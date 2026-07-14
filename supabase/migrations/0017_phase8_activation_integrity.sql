-- Brandloom Phase 8: activation policies, append-only evidence and transactional activation

create policy provider_activation_profiles_admin_read on public.provider_activation_profiles
for select using (public.can_read_platform_operations());
create policy provider_activation_checks_admin_read on public.provider_activation_checks
for select using (public.can_read_platform_operations());
create policy deployment_verification_runs_admin_read on public.deployment_verification_runs
for select using (public.can_read_platform_operations());

create trigger provider_activation_checks_append_only
before update or delete on public.provider_activation_checks
for each row execute function public.reject_append_only_mutation();

create or replace function public.provider_activation_summary(p_environment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required text[] := array[
    'database', 'web', 'worker', 'storage', 'ai_provider',
    'publishing_provider', 'billing_provider', 'webhooks'
  ]::text[];
  v_passed integer;
  v_failed integer;
  v_components jsonb;
begin
  if p_environment not in ('staging', 'production') then
    raise exception 'Only staging and production can be activated';
  end if;

  with latest as (
    select distinct on (component)
      component, status, summary, checked_at, expires_at
    from public.provider_activation_checks
    where environment = p_environment and component = any(v_required)
    order by component, checked_at desc
  )
  select
    count(*) filter (where status in ('passed', 'waived') and (expires_at is null or expires_at > now())),
    count(*) filter (where status = 'failed'),
    coalesce(jsonb_agg(jsonb_build_object(
      'component', component,
      'status', status,
      'summary', summary,
      'checked_at', checked_at,
      'expires_at', expires_at,
      'current', status in ('passed', 'waived') and (expires_at is null or expires_at > now())
    ) order by component), '[]'::jsonb)
  into v_passed, v_failed, v_components
  from latest;

  return jsonb_build_object(
    'environment', p_environment,
    'required', cardinality(v_required),
    'passed', coalesce(v_passed, 0),
    'failed', coalesce(v_failed, 0),
    'ready', coalesce(v_passed, 0) = cardinality(v_required) and coalesce(v_failed, 0) = 0,
    'components', v_components
  );
end;
$$;

create or replace function public.activate_provider_environment(
  p_environment text,
  p_actor uuid,
  p_configuration_fingerprint text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_summary jsonb;
  v_release uuid;
begin
  if char_length(trim(p_configuration_fingerprint)) < 16 then
    raise exception 'Configuration fingerprint is required';
  end if;

  perform 1 from public.provider_activation_profiles
  where environment = p_environment for update;
  if not found then raise exception 'Activation profile not found'; end if;

  select active_release_id into v_release
  from public.deployment_environments
  where name = p_environment for update;
  if v_release is null then raise exception 'Environment has no active release'; end if;

  select public.provider_activation_summary(p_environment) into v_summary;
  if not coalesce((v_summary->>'ready')::boolean, false) then
    raise exception 'Provider activation evidence is incomplete, failed or expired';
  end if;

  update public.provider_activation_profiles
  set status = 'active', release_id = v_release,
      configuration_fingerprint = p_configuration_fingerprint,
      activated_at = now(), activated_by = p_actor,
      last_checked_at = now(), metadata = coalesce(p_metadata, '{}'::jsonb)
  where environment = p_environment;

  insert into public.operational_audit_events(environment, actor_id, action, entity_type, metadata)
  values (p_environment, p_actor, 'provider_environment.activated', 'provider_activation_profile',
    jsonb_build_object('release_id', v_release, 'summary', v_summary,
      'configuration_fingerprint', p_configuration_fingerprint));

  return jsonb_build_object('environment', p_environment, 'release_id', v_release,
    'activated', true, 'summary', v_summary);
end;
$$;

revoke all on function public.provider_activation_summary(text) from public, anon, authenticated;
revoke all on function public.activate_provider_environment(text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.provider_activation_summary(text) to service_role;
grant execute on function public.activate_provider_environment(text, uuid, text, jsonb) to service_role;
