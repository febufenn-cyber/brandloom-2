-- Brandloom Phase 5 entitlement enforcement at the database boundary

-- Usage history is immutable during normal operation, but workspace deletion must be
-- allowed to cascade through the ledger. RLS prevents end-user deletes.
drop trigger if exists usage_ledger_immutable_delete on public.usage_ledger;

create or replace function public.latest_entitlement(p_workspace_id uuid)
returns public.entitlement_snapshots
language sql
stable
security definer
set search_path = public
as $$
  select e from public.entitlement_snapshots e
  where e.workspace_id = p_workspace_id
  order by e.version desc
  limit 1;
$$;

revoke all on function public.latest_entitlement(uuid) from public;
grant execute on function public.latest_entitlement(uuid) to service_role;

create or replace function public.enforce_brand_entitlement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitlement public.entitlement_snapshots;
  v_limit integer;
  v_count integer;
begin
  v_entitlement := public.latest_entitlement(new.workspace_id);
  if v_entitlement.id is null then raise exception 'Workspace entitlements are unavailable'; end if;
  if v_entitlement.access_state not in ('full', 'grace') then raise exception 'Workspace is read-only'; end if;
  v_limit := coalesce((v_entitlement.limits ->> 'brands')::integer, 0);
  select count(*) into v_count from public.brands
  where workspace_id = new.workspace_id and (tg_op = 'INSERT' or id <> new.id);
  if v_limit >= 0 and v_count >= v_limit then raise exception 'Plan brand limit reached'; end if;
  return new;
end;
$$;

create trigger brands_enforce_plan_limit
before insert or update of workspace_id on public.brands
for each row execute function public.enforce_brand_entitlement();

create or replace function public.enforce_member_entitlement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitlement public.entitlement_snapshots;
  v_limit integer;
  v_count integer;
begin
  if new.status <> 'accepted' then return new; end if;
  v_entitlement := public.latest_entitlement(new.workspace_id);
  if v_entitlement.id is null then raise exception 'Workspace entitlements are unavailable'; end if;
  if v_entitlement.access_state not in ('full', 'grace') then raise exception 'Workspace is read-only'; end if;
  v_limit := coalesce((v_entitlement.limits ->> 'members')::integer, 0);
  select count(*) into v_count from public.workspace_members
  where workspace_id = new.workspace_id
    and status = 'accepted'
    and (tg_op = 'INSERT' or id <> new.id);
  if v_limit >= 0 and v_count >= v_limit then raise exception 'Plan member limit reached'; end if;
  return new;
end;
$$;

create trigger workspace_members_enforce_plan_limit
before insert or update of workspace_id, status on public.workspace_members
for each row execute function public.enforce_member_entitlement();

create or replace function public.enforce_connected_account_entitlement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
  v_entitlement public.entitlement_snapshots;
  v_limit integer;
  v_count integer;
begin
  if not new.publishing_enabled then return new; end if;
  select workspace_id into v_workspace from public.brands where id = new.brand_id;
  v_entitlement := public.latest_entitlement(v_workspace);
  if v_entitlement.id is null then raise exception 'Workspace entitlements are unavailable'; end if;
  if v_entitlement.access_state not in ('full', 'grace') then raise exception 'Workspace is read-only'; end if;
  if coalesce((v_entitlement.features ->> 'automatic_publishing')::boolean, false) is not true then
    raise exception 'Automatic publishing is not included in this plan';
  end if;
  v_limit := coalesce((v_entitlement.limits ->> 'connected_accounts')::integer, 0);
  select count(distinct bpa.platform_account_id) into v_count
  from public.brand_platform_accounts bpa
  join public.brands b on b.id = bpa.brand_id
  where b.workspace_id = v_workspace
    and bpa.publishing_enabled
    and (tg_op = 'INSERT' or not (bpa.brand_id = new.brand_id and bpa.platform_account_id = new.platform_account_id));
  if v_limit >= 0 and v_count >= v_limit then raise exception 'Plan connected-account limit reached'; end if;
  return new;
end;
$$;

create trigger brand_platform_accounts_enforce_plan_limit
before insert or update of publishing_enabled, brand_id, platform_account_id on public.brand_platform_accounts
for each row execute function public.enforce_connected_account_entitlement();

create or replace function public.enforce_publication_entitlement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitlement public.entitlement_snapshots;
begin
  v_entitlement := public.latest_entitlement(new.workspace_id);
  if v_entitlement.id is null then raise exception 'Workspace entitlements are unavailable'; end if;
  if v_entitlement.access_state not in ('full', 'grace') then raise exception 'Workspace is read-only'; end if;
  if coalesce((v_entitlement.features ->> 'automatic_publishing')::boolean, false) is not true then
    raise exception 'Automatic publishing is not included in this plan';
  end if;
  return new;
end;
$$;

create trigger publication_jobs_enforce_plan
before insert on public.publication_jobs
for each row execute function public.enforce_publication_entitlement();
