-- Brandloom Phase 6 integrity: immutable evidence and explicit recommendation decisions

create or replace function public.prevent_optimization_evidence_mutation()
returns trigger language plpgsql set search_path = public
as $$ begin raise exception 'Optimization evidence is append-only'; end; $$;

create trigger performance_snapshots_immutable_update
before update on public.content_performance_snapshots
for each row execute function public.prevent_optimization_evidence_mutation();

create trigger recommendation_evidence_immutable_update
before update on public.recommendation_evidence
for each row execute function public.prevent_optimization_evidence_mutation();

create trigger optimization_decisions_immutable_update
before update on public.optimization_decisions
for each row execute function public.prevent_optimization_evidence_mutation();

create trigger optimization_application_logs_immutable_update
before update on public.optimization_application_logs
for each row execute function public.prevent_optimization_evidence_mutation();

create or replace function public.validate_performance_snapshot_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_content_brand uuid;
  v_workspace uuid;
  v_batch_brand uuid;
begin
  select brand_id into v_content_brand from public.content_items where id = new.content_item_id;
  if v_content_brand is null or v_content_brand <> new.brand_id then
    raise exception 'Performance content does not belong to the selected brand';
  end if;
  select workspace_id into v_workspace from public.brands where id = new.brand_id;
  if v_workspace is null or v_workspace <> new.workspace_id then
    raise exception 'Performance workspace does not match the selected brand';
  end if;
  if new.import_batch_id is not null then
    select brand_id into v_batch_brand from public.metric_import_batches where id = new.import_batch_id;
    if v_batch_brand is null or v_batch_brand <> new.brand_id then
      raise exception 'Metric import batch does not belong to the selected brand';
    end if;
  end if;
  return new;
end;
$$;

create trigger performance_snapshots_validate_scope
before insert on public.content_performance_snapshots
for each row execute function public.validate_performance_snapshot_scope();

create or replace function public.validate_experiment_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_experiment public.brand_experiments;
  v_content_brand uuid;
begin
  select * into v_experiment from public.brand_experiments where id = new.experiment_id;
  select brand_id into v_content_brand from public.content_items where id = new.content_item_id;
  if v_experiment.id is null or v_experiment.brand_id <> new.brand_id or v_content_brand <> new.brand_id then
    raise exception 'Experiment assignment brand mismatch';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_experiment.variants) variant
    where coalesce(variant->>'key', variant->>'name') = new.variant_key
  ) then
    raise exception 'Experiment variant does not exist';
  end if;
  return new;
end;
$$;

create trigger experiment_assignments_validate_scope
before insert or update of experiment_id, content_item_id, variant_key on public.experiment_assignments
for each row execute function public.validate_experiment_assignment();

create or replace function public.approve_optimization_recommendation(
  p_recommendation_id uuid,
  p_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_rec public.optimization_recommendations;
  v_memory_id uuid;
  v_user uuid := auth.uid();
  v_previous jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_rec from public.optimization_recommendations
  where id = p_recommendation_id for update;
  if v_rec.id is null then raise exception 'Recommendation not found'; end if;
  if not public.can_review_brand(v_rec.brand_id) then raise exception 'Review permission is required'; end if;
  if v_rec.status not in ('proposed', 'paused') then raise exception 'Recommendation cannot be approved from its current state'; end if;
  if v_rec.valid_until is not null and v_rec.valid_until < current_date then raise exception 'Recommendation has expired'; end if;

  v_previous := to_jsonb(v_rec);
  insert into public.memory_items(
    brand_id, memory_type, statement, structured_value, scope, durability,
    confidence, status, origin, evidence_count, valid_from, valid_until,
    confirmed_by, confirmed_at
  ) values (
    v_rec.brand_id,
    'strategic_suggestion',
    v_rec.statement,
    jsonb_build_object(
      'recommendation_id', v_rec.id,
      'proposed_action', v_rec.proposed_action,
      'rationale', v_rec.rationale,
      'attribution_confidence', v_rec.attribution_confidence,
      'evidence_summary', v_rec.evidence_summary,
      'experiment_id', v_rec.experiment_id
    ),
    v_rec.scope,
    case when v_rec.experiment_id is not null then 'experiment' else 'temporary' end,
    least(v_rec.confidence, 0.900),
    'confirmed',
    'system',
    v_rec.sample_size,
    current_date,
    coalesce(v_rec.valid_until, current_date + 60),
    v_user,
    now()
  ) returning id into v_memory_id;

  update public.optimization_recommendations set
    status = 'approved', memory_item_id = v_memory_id, decided_by = v_user,
    decided_at = now(), decision_note = coalesce(p_note, '')
  where id = v_rec.id;

  insert into public.memory_confirmations(
    brand_id, memory_item_id, user_id, decision, note, previous_snapshot
  ) values (
    v_rec.brand_id, v_memory_id, v_user, 'confirm', coalesce(p_note, ''), v_previous
  );

  insert into public.optimization_decisions(
    brand_id, recommendation_id, user_id, decision, note, previous_snapshot
  ) values (
    v_rec.brand_id, v_rec.id, v_user, 'approve', coalesce(p_note, ''), v_previous
  );

  insert into public.optimization_application_logs(
    brand_id, recommendation_id, memory_item_id, application_type, target_id, payload, applied_by
  ) values (
    v_rec.brand_id, v_rec.id, v_memory_id, 'memory', v_memory_id,
    jsonb_build_object('valid_until', coalesce(v_rec.valid_until, current_date + 60)), v_user
  );

  return v_memory_id;
end;
$$;

create or replace function public.decide_optimization_recommendation(
  p_recommendation_id uuid,
  p_decision text,
  p_note text default ''
)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_rec public.optimization_recommendations;
  v_user uuid := auth.uid();
  v_status text;
  v_memory_status text;
  v_previous jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_decision not in ('reject', 'pause', 'reactivate', 'expire', 'supersede') then
    raise exception 'Unsupported recommendation decision';
  end if;
  select * into v_rec from public.optimization_recommendations
  where id = p_recommendation_id for update;
  if v_rec.id is null then raise exception 'Recommendation not found'; end if;
  if not public.can_review_brand(v_rec.brand_id) then raise exception 'Review permission is required'; end if;

  v_previous := to_jsonb(v_rec);
  v_status := case p_decision
    when 'reject' then 'rejected'
    when 'pause' then 'paused'
    when 'reactivate' then 'active'
    when 'expire' then 'expired'
    when 'supersede' then 'superseded'
  end;
  v_memory_status := case p_decision
    when 'reject' then 'rejected'
    when 'pause' then 'paused'
    when 'reactivate' then 'active'
    when 'expire' then 'expired'
    when 'supersede' then 'superseded'
  end;

  if p_decision = 'reactivate' and v_rec.valid_until is not null and v_rec.valid_until < current_date then
    raise exception 'Expired recommendation cannot be reactivated';
  end if;

  update public.optimization_recommendations set
    status = v_status, decided_by = v_user, decided_at = now(), decision_note = coalesce(p_note, '')
  where id = v_rec.id;

  if v_rec.memory_item_id is not null then
    update public.memory_items set status = v_memory_status where id = v_rec.memory_item_id;
  end if;

  insert into public.optimization_decisions(
    brand_id, recommendation_id, user_id, decision, note, previous_snapshot
  ) values (
    v_rec.brand_id, v_rec.id, v_user, p_decision, coalesce(p_note, ''), v_previous
  );

  return v_status;
end;
$$;

revoke all on function public.approve_optimization_recommendation(uuid, text) from public;
revoke all on function public.decide_optimization_recommendation(uuid, text, text) from public;
grant execute on function public.approve_optimization_recommendation(uuid, text) to authenticated;
grant execute on function public.decide_optimization_recommendation(uuid, text, text) to authenticated;
