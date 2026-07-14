-- Brandloom Phase 9: beta consent, atomic rate limiting and closed-beta launch gates

create policy beta_programs_read on public.beta_programs for select
using (status in ('recruiting', 'active') or public.can_read_platform_operations());
create policy beta_participants_read on public.beta_participants for select
using (user_id = auth.uid() or public.can_read_platform_operations());
create policy beta_feedback_read on public.beta_feedback for select
using (submitted_by = auth.uid() or public.can_read_platform_operations());
create policy qa_test_runs_admin_read on public.qa_test_runs for select
using (public.can_read_platform_operations());
create policy security_findings_admin_read on public.security_findings for select
using (public.can_read_platform_operations());
create policy beta_gate_assessments_admin_read on public.beta_gate_assessments for select
using (public.can_read_platform_operations());

create trigger beta_gate_assessments_append_only
before update or delete on public.beta_gate_assessments
for each row execute function public.reject_append_only_mutation();

create or replace function public.protect_beta_invite_identity()
returns trigger
language plpgsql
as $$
begin
  if new.program_id <> old.program_id
    or new.email_hash <> old.email_hash
    or new.token_hash <> old.token_hash
    or new.invited_by is distinct from old.invited_by then
    raise exception 'Beta invitation identity is immutable';
  end if;
  return new;
end;
$$;

create trigger beta_invite_identity_immutable
before update on public.beta_invites
for each row execute function public.protect_beta_invite_identity();

create or replace function public.consume_api_rate_limit(
  p_key_hash text,
  p_scope text,
  p_limit integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count integer;
  v_reset timestamptz;
begin
  if char_length(p_key_hash) < 16 then raise exception 'Rate-limit key is invalid'; end if;
  if p_limit < 1 or p_limit > 10000 then raise exception 'Rate limit is invalid'; end if;
  if p_window_seconds < 1 or p_window_seconds > 86400 then raise exception 'Rate-limit window is invalid'; end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_reset := v_window + make_interval(secs => p_window_seconds);

  insert into public.api_rate_limit_buckets(key_hash, scope, window_start, request_count, expires_at)
  values (p_key_hash, p_scope, v_window, 1, v_reset + interval '5 minutes')
  on conflict (key_hash, scope, window_start)
  do update set request_count = public.api_rate_limit_buckets.request_count + 1
  returning request_count into v_count;

  return jsonb_build_object(
    'allowed', v_count <= p_limit,
    'limit', p_limit,
    'remaining', greatest(p_limit - v_count, 0),
    'reset_at', v_reset,
    'count', v_count
  );
end;
$$;

create or replace function public.accept_beta_invite(
  p_token_hash text,
  p_user_id uuid,
  p_consent_version text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.beta_invites;
  v_program public.beta_programs;
  v_count integer;
  v_participant uuid;
begin
  select * into v_invite from public.beta_invites
  where token_hash = p_token_hash for update;
  if not found then raise exception 'Invitation is invalid'; end if;
  if v_invite.status <> 'pending' or v_invite.expires_at <= now() then raise exception 'Invitation is no longer available'; end if;

  select * into v_program from public.beta_programs where id = v_invite.program_id for update;
  if v_program.status not in ('recruiting', 'active') then raise exception 'Beta program is not accepting participants'; end if;
  if p_consent_version <> v_program.consent_version then raise exception 'Current beta consent must be accepted'; end if;

  select count(*) into v_count from public.beta_participants
  where program_id = v_program.id and status not in ('exited', 'removed');
  if v_count >= v_program.capacity then raise exception 'Beta program is at capacity'; end if;

  insert into public.beta_participants(program_id, invite_id, user_id, consent_version, consented_at)
  values (v_program.id, v_invite.id, p_user_id, p_consent_version, now())
  on conflict (program_id, user_id) do update
    set status = 'accepted', consent_version = excluded.consent_version,
        consented_at = excluded.consented_at, invite_id = excluded.invite_id
  returning id into v_participant;

  update public.beta_invites set status = 'accepted', accepted_by = p_user_id, accepted_at = now()
  where id = v_invite.id;

  return v_participant;
end;
$$;

create or replace function public.beta_launch_gate_summary(p_environment text, p_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required text[] := array['auth', 'rls', 'publishing', 'billing', 'data_rights', 'reliability', 'security']::text[];
  v_activation boolean;
  v_qa_passed integer;
  v_findings integer;
  v_incidents integer;
  v_program_ready boolean;
begin
  select exists(
    select 1 from public.provider_activation_profiles
    where environment = p_environment and status = 'active'
  ) into v_activation;

  with latest as (
    select distinct on (suite) suite, status, expires_at
    from public.qa_test_runs
    where environment = p_environment and suite = any(v_required)
    order by suite, completed_at desc nulls last, started_at desc
  )
  select count(*) filter (where status = 'passed' and (expires_at is null or expires_at > now()))
  into v_qa_passed from latest;

  select count(*) into v_findings from public.security_findings
  where severity in ('critical', 'high') and status not in ('mitigated', 'accepted', 'closed', 'false_positive');

  select count(*) into v_incidents from public.incidents
  where environment = p_environment and severity in ('sev1', 'sev2') and status not in ('resolved', 'cancelled');

  select exists(select 1 from public.beta_programs where id = p_program_id and status in ('recruiting', 'active'))
  into v_program_ready;

  return jsonb_build_object(
    'environment', p_environment,
    'program_id', p_program_id,
    'activation_active', v_activation,
    'qa_required', cardinality(v_required),
    'qa_passed', coalesce(v_qa_passed, 0),
    'open_critical_high_findings', v_findings,
    'open_sev1_sev2_incidents', v_incidents,
    'program_ready', v_program_ready,
    'ready', v_activation and coalesce(v_qa_passed, 0) = cardinality(v_required)
      and v_findings = 0 and v_incidents = 0 and v_program_ready
  );
end;
$$;

create or replace function public.record_beta_gate_assessment(
  p_environment text,
  p_program_id uuid,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_summary jsonb;
  v_status text;
begin
  select public.beta_launch_gate_summary(p_environment, p_program_id) into v_summary;
  v_status := case when coalesce((v_summary->>'ready')::boolean, false) then 'passed' else 'blocked' end;
  insert into public.beta_gate_assessments(environment, program_id, status, summary, assessed_by, expires_at)
  values (p_environment, p_program_id, v_status, v_summary, p_actor, now() + interval '24 hours');
  insert into public.operational_audit_events(environment, actor_id, action, entity_type, entity_id, metadata)
  values (p_environment, p_actor, 'beta.gate_assessed', 'beta_program', p_program_id, v_summary);
  return v_summary;
end;
$$;

create or replace function public.cleanup_rate_limit_buckets()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_deleted integer;
begin
  delete from public.api_rate_limit_buckets where expires_at <= now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.accept_beta_invite(text, uuid, text) from public, anon, authenticated;
revoke all on function public.beta_launch_gate_summary(text, uuid) from public, anon, authenticated;
revoke all on function public.record_beta_gate_assessment(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.cleanup_rate_limit_buckets() from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer) to service_role;
grant execute on function public.accept_beta_invite(text, uuid, text) to service_role;
grant execute on function public.beta_launch_gate_summary(text, uuid) to service_role;
grant execute on function public.record_beta_gate_assessment(text, uuid, uuid) to service_role;
grant execute on function public.cleanup_rate_limit_buckets() to service_role;
