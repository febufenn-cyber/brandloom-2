-- Brandloom Phase 7: integrity, platform-operator access and transactional release promotion

create or replace function public.is_platform_operator()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid() and role in ('operations', 'super_admin')
  );
$$;

create or replace function public.can_read_platform_operations()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

grant execute on function public.is_platform_operator() to authenticated;
grant execute on function public.can_read_platform_operations() to authenticated;

create policy deployment_environments_admin_read on public.deployment_environments
for select using (public.can_read_platform_operations());
create policy system_releases_admin_read on public.system_releases
for select using (public.can_read_platform_operations());
create policy release_gates_admin_read on public.release_gate_results
for select using (public.can_read_platform_operations());
create policy environment_controls_admin_read on public.environment_controls
for select using (public.can_read_platform_operations());
create policy service_health_admin_read on public.service_health_checks
for select using (public.can_read_platform_operations());
create policy incidents_admin_read on public.incidents
for select using (public.can_read_platform_operations());
create policy incident_events_admin_read on public.incident_events
for select using (public.can_read_platform_operations());
create policy restore_drills_admin_read on public.backup_restore_drills
for select using (public.can_read_platform_operations());
create policy release_transitions_admin_read on public.release_transitions
for select using (public.can_read_platform_operations());
create policy operational_audit_admin_read on public.operational_audit_events
for select using (public.can_read_platform_operations());

create or replace function public.protect_release_identity()
returns trigger
language plpgsql
as $$
begin
  if new.environment <> old.environment
    or new.version <> old.version
    or new.commit_sha <> old.commit_sha
    or new.artifact_checksum <> old.artifact_checksum
    or new.migration_version <> old.migration_version then
    raise exception 'Release identity is immutable';
  end if;
  return new;
end;
$$;

create trigger system_release_identity_immutable
before update on public.system_releases
for each row execute function public.protect_release_identity();

create or replace function public.reject_append_only_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'This operational record is append-only';
end;
$$;

create trigger health_checks_append_only before update or delete on public.service_health_checks
for each row execute function public.reject_append_only_mutation();
create trigger incident_events_append_only before update or delete on public.incident_events
for each row execute function public.reject_append_only_mutation();
create trigger release_transitions_append_only before update or delete on public.release_transitions
for each row execute function public.reject_append_only_mutation();
create trigger operational_audit_append_only before update or delete on public.operational_audit_events
for each row execute function public.reject_append_only_mutation();

create or replace function public.release_required_gate_keys(p_environment text)
returns text[]
language sql
immutable
as $$
  select case p_environment
    when 'production' then array[
      'migration_verified', 'secrets_verified', 'database_health', 'provider_readiness',
      'backup_restore_verified', 'rollback_ready', 'observability_ready', 'security_review'
    ]::text[]
    when 'staging' then array[
      'migration_verified', 'secrets_verified', 'database_health', 'provider_readiness',
      'rollback_ready', 'observability_ready'
    ]::text[]
    else array['migration_verified', 'secrets_verified', 'database_health']::text[]
  end;
$$;

create or replace function public.release_gate_summary(p_release_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_release public.system_releases;
  v_required text[];
  v_required_count integer;
  v_passed integer;
  v_failed integer;
  v_pending integer;
begin
  select * into v_release from public.system_releases where id = p_release_id;
  if not found then raise exception 'Release not found'; end if;
  v_required := public.release_required_gate_keys(v_release.environment);
  v_required_count := cardinality(v_required);

  select count(*) filter (where status in ('passed', 'waived') and (expires_at is null or expires_at > now())),
         count(*) filter (where status = 'failed'),
         count(*) filter (where status = 'pending' or (expires_at is not null and expires_at <= now()))
  into v_passed, v_failed, v_pending
  from public.release_gate_results
  where release_id = p_release_id and gate_key = any(v_required);

  return jsonb_build_object(
    'release_id', p_release_id,
    'environment', v_release.environment,
    'required', v_required_count,
    'passed', coalesce(v_passed, 0),
    'failed', coalesce(v_failed, 0),
    'pending', greatest(v_required_count - coalesce(v_passed, 0) - coalesce(v_failed, 0), coalesce(v_pending, 0)),
    'ready', coalesce(v_passed, 0) = v_required_count and coalesce(v_failed, 0) = 0
  );
end;
$$;

create or replace function public.validate_system_release(p_release_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_summary jsonb;
begin
  select public.release_gate_summary(p_release_id) into v_summary;
  if not coalesce((v_summary->>'ready')::boolean, false) then
    raise exception 'Release gates are not ready';
  end if;
  update public.system_releases
  set status = 'validated', validated_at = now()
  where id = p_release_id and status in ('draft', 'checking', 'failed');
  if not found then raise exception 'Release cannot be validated from its current state'; end if;
  insert into public.operational_audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (p_actor, 'release.validated', 'system_release', p_release_id, v_summary);
  return v_summary;
end;
$$;

create or replace function public.promote_system_release(p_release_id uuid, p_actor uuid, p_note text default '')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_release public.system_releases;
  v_current uuid;
  v_summary jsonb;
begin
  select * into v_release from public.system_releases where id = p_release_id for update;
  if not found then raise exception 'Release not found'; end if;
  if v_release.status <> 'validated' then raise exception 'Only a validated release can be promoted'; end if;

  select public.release_gate_summary(p_release_id) into v_summary;
  if not coalesce((v_summary->>'ready')::boolean, false) then
    raise exception 'A required release gate failed, expired or is pending';
  end if;

  select active_release_id into v_current
  from public.deployment_environments where name = v_release.environment for update;
  if v_current = p_release_id then raise exception 'Release is already active'; end if;

  update public.system_releases set status = 'promoting' where id = p_release_id;
  if v_current is not null then
    update public.system_releases set status = 'superseded' where id = v_current and status = 'active';
  end if;
  update public.system_releases
  set status = 'active', previous_release_id = v_current, promoted_at = now(), failed_at = null
  where id = p_release_id;
  update public.deployment_environments set active_release_id = p_release_id where name = v_release.environment;

  insert into public.release_transitions(environment, release_id, from_release_id, transition_type, note, actor_id)
  values (v_release.environment, p_release_id, v_current, 'promote', p_note, p_actor);
  insert into public.operational_audit_events(environment, actor_id, action, entity_type, entity_id, metadata)
  values (v_release.environment, p_actor, 'release.promoted', 'system_release', p_release_id,
    jsonb_build_object('from_release_id', v_current, 'gate_summary', v_summary, 'note', p_note));
  return p_release_id;
end;
$$;

create or replace function public.rollback_environment_release(
  p_environment text,
  p_target_release_id uuid,
  p_actor uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current uuid;
  v_target public.system_releases;
begin
  if char_length(trim(p_reason)) < 3 then raise exception 'Rollback reason is required'; end if;
  select active_release_id into v_current from public.deployment_environments where name = p_environment for update;
  select * into v_target from public.system_releases where id = p_target_release_id and environment = p_environment for update;
  if not found then raise exception 'Rollback target is not part of this environment'; end if;
  if v_current is null then raise exception 'Environment has no active release'; end if;
  if v_current = p_target_release_id then raise exception 'Rollback target is already active'; end if;
  if v_target.status not in ('superseded', 'rolled_back', 'validated') then raise exception 'Rollback target is not eligible'; end if;

  update public.system_releases set status = 'rolled_back' where id = v_current;
  update public.system_releases set status = 'active', promoted_at = now() where id = p_target_release_id;
  update public.deployment_environments set active_release_id = p_target_release_id where name = p_environment;

  insert into public.release_transitions(environment, release_id, from_release_id, transition_type, note, actor_id)
  values (p_environment, p_target_release_id, v_current, 'rollback', p_reason, p_actor);
  insert into public.operational_audit_events(environment, actor_id, action, entity_type, entity_id, metadata)
  values (p_environment, p_actor, 'release.rolled_back', 'system_release', p_target_release_id,
    jsonb_build_object('from_release_id', v_current, 'reason', p_reason));
  return p_target_release_id;
end;
$$;

revoke all on function public.release_gate_summary(uuid) from public, anon, authenticated;
revoke all on function public.validate_system_release(uuid, uuid) from public, anon, authenticated;
revoke all on function public.promote_system_release(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.rollback_environment_release(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.release_gate_summary(uuid) to service_role;
grant execute on function public.validate_system_release(uuid, uuid) to service_role;
grant execute on function public.promote_system_release(uuid, uuid, text) to service_role;
grant execute on function public.rollback_environment_release(text, uuid, uuid, text) to service_role;
