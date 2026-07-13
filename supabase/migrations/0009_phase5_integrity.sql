-- Brandloom Phase 5 integrity: entitlement projection, atomic usage and lifecycle automation

create or replace function public.recalculate_workspace_entitlements(p_workspace_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subscription public.subscriptions;
  v_plan public.billing_plans;
  v_access text;
  v_version integer;
  v_id uuid;
begin
  select * into v_subscription from public.subscriptions where workspace_id = p_workspace_id for update;
  if not found then raise exception 'Workspace subscription is missing'; end if;
  select * into v_plan from public.billing_plans where code = v_subscription.plan_code and active;
  if not found then raise exception 'Billing plan is unavailable'; end if;

  v_access := case
    when v_subscription.status in ('trialing', 'active') then 'full'
    when v_subscription.status = 'past_due' and coalesce(v_subscription.grace_ends_at, now()) > now() then 'grace'
    when v_subscription.status in ('past_due', 'unpaid', 'paused', 'incomplete', 'incomplete_expired', 'canceled') then 'read_only'
    else 'closed'
  end;

  update public.subscriptions set access_state = v_access where id = v_subscription.id;
  select coalesce(max(version), 0) + 1 into v_version from public.entitlement_snapshots where workspace_id = p_workspace_id;
  insert into public.entitlement_snapshots(workspace_id, subscription_id, plan_code, subscription_status, access_state, features, limits, version)
  values (p_workspace_id, v_subscription.id, v_plan.code, v_subscription.status, v_access, v_plan.features, v_plan.limits, v_version)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.subscription_entitlement_refresh()
returns trigger language plpgsql security definer set search_path = public
as $$ begin perform public.recalculate_workspace_entitlements(new.workspace_id); return new; end; $$;

create trigger subscription_entitlement_after_insert
after insert on public.subscriptions for each row execute function public.subscription_entitlement_refresh();
create trigger subscription_entitlement_after_update
after update of plan_code, status, grace_ends_at, current_period_end, cancel_at_period_end
on public.subscriptions for each row
when (old.* is distinct from new.*)
execute function public.subscription_entitlement_refresh();

create or replace function public.provision_workspace_trial()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.subscriptions(workspace_id, provider, plan_code, status, access_state, trial_start, trial_end, current_period_start, current_period_end)
  values (new.id, 'mock', 'trial', 'trialing', 'full', now(), now() + interval '14 days', now(), now() + interval '14 days')
  on conflict (workspace_id) do nothing;
  insert into public.workspace_commercial_controls(workspace_id) values (new.id)
  on conflict (workspace_id) do nothing;
  return new;
end;
$$;

create trigger workspace_trial_after_insert
after insert on public.workspaces for each row execute function public.provision_workspace_trial();

insert into public.subscriptions(workspace_id, provider, plan_code, status, access_state, trial_start, trial_end, current_period_start, current_period_end)
select id, 'mock', 'trial', 'trialing', 'full', created_at, created_at + interval '14 days', created_at, created_at + interval '14 days'
from public.workspaces
on conflict (workspace_id) do nothing;

insert into public.workspace_commercial_controls(workspace_id)
select id from public.workspaces
on conflict (workspace_id) do nothing;

create or replace function public.current_entitlements(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, auth
as $$
  select jsonb_build_object(
    'workspace_id', e.workspace_id,
    'plan_code', e.plan_code,
    'subscription_status', e.subscription_status,
    'access_state', e.access_state,
    'features', e.features,
    'limits', e.limits,
    'effective_from', e.effective_from,
    'version', e.version
  )
  from public.entitlement_snapshots e
  where e.workspace_id = p_workspace_id
    and (auth.role() = 'service_role' or public.can_access_workspace(p_workspace_id))
  order by e.version desc limit 1;
$$;

grant execute on function public.current_entitlements(uuid) to authenticated, service_role;

create or replace function public.reserve_workspace_usage(
  p_workspace_id uuid,
  p_user_id uuid,
  p_brand_id uuid,
  p_usage_type text,
  p_quantity numeric,
  p_request_id text,
  p_ttl_seconds integer default 900
)
returns table(reservation_id uuid, allowed boolean, reason text, remaining numeric)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_existing public.usage_reservations;
  v_entitlement public.entitlement_snapshots;
  v_controls public.workspace_commercial_controls;
  v_limit numeric;
  v_used numeric;
  v_reserved numeric;
  v_credits numeric;
  v_remaining numeric;
  v_period text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  v_id uuid;
begin
  if p_quantity <= 0 then raise exception 'Quantity must be positive'; end if;
  if auth.role() <> 'service_role' and (auth.uid() is null or auth.uid() <> p_user_id or not public.can_access_workspace(p_workspace_id)) then
    raise exception 'Not authorized';
  end if;

  select * into v_existing from public.usage_reservations where workspace_id = p_workspace_id and request_id = p_request_id;
  if found then
    return query select v_existing.id, v_existing.status in ('reserved', 'finalized'), 'existing reservation', null::numeric;
    return;
  end if;

  select * into v_entitlement from public.entitlement_snapshots where workspace_id = p_workspace_id order by version desc limit 1;
  if not found then
    return query select null::uuid, false, 'entitlements unavailable', 0::numeric;
    return;
  end if;

  select * into v_controls from public.workspace_commercial_controls where workspace_id = p_workspace_id;
  if coalesce(v_controls.generation_paused, false) or coalesce(v_controls.billing_locked, false) then
    return query select null::uuid, false, coalesce(nullif(v_controls.generation_pause_reason, ''), nullif(v_controls.billing_lock_reason, ''), 'workspace generation is paused'), 0::numeric;
    return;
  end if;
  if v_entitlement.access_state not in ('full', 'grace') then
    return query select null::uuid, false, 'subscription is read-only', 0::numeric;
    return;
  end if;

  v_limit := coalesce((v_entitlement.limits ->> 'monthly_generation_units')::numeric, 0);
  select coalesce(sum(quantity), 0) into v_used from public.usage_ledger
  where workspace_id = p_workspace_id and period_key = v_period and usage_type = 'generation_units';
  select coalesce(sum(reserved_quantity), 0) into v_reserved from public.usage_reservations
  where workspace_id = p_workspace_id and period_key = v_period and status = 'reserved' and expires_at > now();
  select coalesce(sum(quantity), 0) into v_credits from public.workspace_credits
  where workspace_id = p_workspace_id and credit_type = 'generation_units' and (expires_at is null or expires_at > now());

  if v_limit < 0 then v_remaining := null;
  else v_remaining := greatest(v_limit + v_credits - v_used - v_reserved, 0); end if;

  if v_limit >= 0 and v_remaining < p_quantity then
    return query select null::uuid, false, 'monthly generation allowance reached', v_remaining;
    return;
  end if;

  insert into public.usage_reservations(workspace_id, user_id, brand_id, usage_type, reserved_quantity, period_key, request_id, expires_at)
  values (p_workspace_id, p_user_id, p_brand_id, p_usage_type, p_quantity, v_period, p_request_id, now() + make_interval(secs => greatest(p_ttl_seconds, 60)))
  returning id into v_id;

  return query select v_id, true, 'reserved', case when v_remaining is null then null else v_remaining - p_quantity end;
end;
$$;

grant execute on function public.reserve_workspace_usage(uuid, uuid, uuid, text, numeric, text, integer) to authenticated, service_role;

create or replace function public.finalize_workspace_usage(
  p_reservation_id uuid,
  p_actual_quantity numeric,
  p_provider text default '',
  p_model text default '',
  p_input_tokens integer default 0,
  p_output_tokens integer default 0,
  p_estimated_cost_micros bigint default 0,
  p_metadata jsonb default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_res public.usage_reservations;
  v_ledger uuid;
begin
  select * into v_res from public.usage_reservations where id = p_reservation_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if auth.role() <> 'service_role' and auth.uid() <> v_res.user_id then raise exception 'Not authorized'; end if;
  if v_res.status = 'finalized' then
    select id into v_ledger from public.usage_ledger where reservation_id = v_res.id limit 1;
    return v_ledger;
  end if;
  if v_res.status <> 'reserved' then raise exception 'Reservation is not active'; end if;

  insert into public.usage_ledger(workspace_id, user_id, brand_id, usage_type, quantity, period_key, provider, model, input_tokens, output_tokens, estimated_cost_micros, reservation_id, idempotency_key, metadata)
  values (v_res.workspace_id, v_res.user_id, v_res.brand_id, 'generation_units', greatest(p_actual_quantity, 0), v_res.period_key, p_provider, p_model, greatest(p_input_tokens, 0), greatest(p_output_tokens, 0), greatest(p_estimated_cost_micros, 0), v_res.id, 'reservation:' || v_res.id::text, coalesce(p_metadata, '{}'))
  returning id into v_ledger;

  update public.usage_reservations set status = 'finalized', finalized_at = now() where id = v_res.id;
  return v_ledger;
end;
$$;

grant execute on function public.finalize_workspace_usage(uuid, numeric, text, text, integer, integer, bigint, jsonb) to authenticated, service_role;

create or replace function public.release_workspace_usage(p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare v_res public.usage_reservations;
begin
  select * into v_res from public.usage_reservations where id = p_reservation_id for update;
  if not found then return false; end if;
  if auth.role() <> 'service_role' and auth.uid() <> v_res.user_id then raise exception 'Not authorized'; end if;
  if v_res.status = 'reserved' then
    update public.usage_reservations set status = 'released', released_at = now() where id = v_res.id;
  end if;
  return true;
end;
$$;

grant execute on function public.release_workspace_usage(uuid) to authenticated, service_role;

create or replace function public.expire_commercial_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_reservations integer; v_trials integer; v_deletions integer;
begin
  update public.usage_reservations set status = 'expired' where status = 'reserved' and expires_at <= now();
  get diagnostics v_reservations = row_count;
  update public.subscriptions set status = 'canceled', access_state = 'read_only', canceled_at = now()
  where status = 'trialing' and trial_end <= now();
  get diagnostics v_trials = row_count;
  update public.deletion_requests set status = 'ready' where status = 'scheduled' and execute_after <= now();
  get diagnostics v_deletions = row_count;
  update public.data_export_jobs set status = 'expired', payload = null where status = 'completed' and expires_at <= now();
  return jsonb_build_object('expired_reservations', v_reservations, 'expired_trials', v_trials, 'ready_deletions', v_deletions);
end;
$$;

revoke all on function public.expire_commercial_state() from public;
grant execute on function public.expire_commercial_state() to service_role;

create or replace function public.prevent_usage_ledger_mutation()
returns trigger language plpgsql set search_path = public
as $$ begin raise exception 'Usage ledger entries are immutable; create a reversal entry instead'; end; $$;

create trigger usage_ledger_immutable_update before update on public.usage_ledger
for each row execute function public.prevent_usage_ledger_mutation();
create trigger usage_ledger_immutable_delete before delete on public.usage_ledger
for each row execute function public.prevent_usage_ledger_mutation();

create or replace function public.record_generation_cost()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_workspace uuid;
  v_rate public.model_cost_rates;
  v_cost bigint;
begin
  if new.status <> 'completed' then return new; end if;
  select workspace_id into v_workspace from public.brands where id = new.brand_id;
  select * into v_rate from public.model_cost_rates where model = new.model and active;
  if not found then select * into v_rate from public.model_cost_rates where model = 'default'; end if;
  v_cost := ((new.input_tokens::numeric * v_rate.input_cost_micros_per_million) / 1000000
    + (new.output_tokens::numeric * v_rate.output_cost_micros_per_million) / 1000000)::bigint;
  insert into public.cost_events(workspace_id, brand_id, provider, service, model, input_tokens, output_tokens, estimated_cost_micros, source_type, source_id)
  values (v_workspace, new.brand_id, 'anthropic', new.task_type, new.model, new.input_tokens, new.output_tokens, greatest(v_cost, 0), 'generation_run', new.id);
  return new;
end;
$$;

create trigger generation_run_cost_after_insert
after insert on public.generation_runs for each row execute function public.record_generation_cost();
