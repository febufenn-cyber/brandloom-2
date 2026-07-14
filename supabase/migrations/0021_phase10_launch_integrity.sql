-- Brandloom Phase 10: public launch gate, access controls and growth integrity

create policy launch_programs_admin_read on public.launch_programs for select using (public.can_read_platform_operations());
create policy launch_checklist_admin_read on public.launch_checklist_items for select using (public.can_read_platform_operations());
create policy public_access_controls_admin_read on public.public_access_controls for select using (public.can_read_platform_operations());
create policy launch_gate_admin_read on public.launch_gate_assessments for select using (public.can_read_platform_operations());
create policy referral_codes_owner_read on public.referral_codes for select using (owner_user_id = auth.uid() or public.can_read_platform_operations());
create policy growth_experiments_admin_read on public.growth_experiments for select using (public.can_read_platform_operations());
create policy daily_growth_metrics_admin_read on public.daily_growth_metrics for select using (public.can_read_platform_operations());

create trigger launch_gate_assessments_append_only before update or delete on public.launch_gate_assessments
for each row execute function public.reject_append_only_mutation();
create trigger acquisition_events_append_only before update or delete on public.acquisition_events
for each row execute function public.reject_append_only_mutation();
create trigger growth_assignments_append_only before update or delete on public.growth_experiment_assignments
for each row execute function public.reject_append_only_mutation();
create trigger growth_outcomes_append_only before update or delete on public.growth_experiment_outcomes
for each row execute function public.reject_append_only_mutation();

create or replace function public.public_launch_gate_summary(p_launch_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_program public.launch_programs;
  v_activation boolean;
  v_beta boolean;
  v_release uuid;
  v_check_required integer;
  v_check_passed integer;
  v_findings integer;
  v_incidents integer;
  v_restore boolean;
  v_ready boolean;
begin
  select * into v_program from public.launch_programs where id = p_launch_program_id;
  if not found then raise exception 'Launch program not found'; end if;
  if v_program.environment <> 'production' then raise exception 'Public launch is production-only'; end if;

  select active_release_id into v_release from public.deployment_environments where name = 'production';
  select exists(select 1 from public.provider_activation_profiles where environment = 'production' and status = 'active' and release_id = v_release) into v_activation;
  select exists(select 1 from public.beta_gate_assessments where environment = 'production' and status = 'passed' and expires_at > now() order by assessed_at desc limit 1) into v_beta;

  select count(*) filter (where required),
         count(*) filter (where required and status in ('passed','waived') and (expires_at is null or expires_at > now()))
  into v_check_required, v_check_passed
  from public.launch_checklist_items where launch_program_id = p_launch_program_id;

  select count(*) into v_findings from public.security_findings
  where severity in ('critical','high') and status not in ('mitigated','accepted','closed','false_positive');
  select count(*) into v_incidents from public.incidents
  where environment = 'production' and severity in ('sev1','sev2') and status not in ('resolved','cancelled');
  select exists(select 1 from public.backup_restore_drills where environment = 'production' and status = 'passed' and checksum_verified and completed_at > now() - interval '30 days') into v_restore;

  v_ready := v_release is not null and v_activation and v_beta and v_restore
    and v_check_required > 0 and v_check_passed = v_check_required
    and v_findings = 0 and v_incidents = 0;

  return jsonb_build_object(
    'launch_program_id', p_launch_program_id,
    'active_release_id', v_release,
    'production_activation_active', v_activation,
    'beta_gate_current', v_beta,
    'restore_drill_current', v_restore,
    'required_checklist', v_check_required,
    'passed_checklist', v_check_passed,
    'open_critical_high_findings', v_findings,
    'open_sev1_sev2_incidents', v_incidents,
    'ready', v_ready
  );
end;
$$;

create or replace function public.record_public_launch_gate(p_launch_program_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_summary jsonb; v_status text;
begin
  select public.public_launch_gate_summary(p_launch_program_id) into v_summary;
  v_status := case when coalesce((v_summary->>'ready')::boolean,false) then 'passed' else 'blocked' end;
  insert into public.launch_gate_assessments(launch_program_id, environment, status, summary, assessed_by, expires_at)
  values (p_launch_program_id, 'production', v_status, v_summary, p_actor, now() + interval '4 hours');
  update public.launch_programs set status = case when v_status = 'passed' then 'ready' else 'gating' end where id = p_launch_program_id and status in ('draft','gating','ready','paused');
  insert into public.operational_audit_events(environment,actor_id,action,entity_type,entity_id,metadata)
  values ('production',p_actor,'launch.gate_assessed','launch_program',p_launch_program_id,v_summary);
  return v_summary;
end;
$$;

create or replace function public.open_public_launch(p_launch_program_id uuid, p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_summary jsonb; v_program public.launch_programs;
begin
  if char_length(trim(p_reason)) < 3 then raise exception 'Launch reason is required'; end if;
  select * into v_program from public.launch_programs where id = p_launch_program_id for update;
  if not found or v_program.environment <> 'production' then raise exception 'Production launch program not found'; end if;
  perform 1 from public.public_access_controls where environment = 'production' for update;
  select public.public_launch_gate_summary(p_launch_program_id) into v_summary;
  if not coalesce((v_summary->>'ready')::boolean,false) then raise exception 'Public launch gate is not ready'; end if;
  update public.launch_programs set status='live', launched_at=now(), paused_at=null where id=p_launch_program_id;
  update public.public_access_controls set launch_program_id=p_launch_program_id, registration_open=true,
    waitlist_open=true, invite_only=false, reason=p_reason, opened_by=p_actor, opened_at=now(), updated_by=p_actor, updated_at=now()
  where environment='production';
  insert into public.operational_audit_events(environment,actor_id,action,entity_type,entity_id,metadata)
  values ('production',p_actor,'launch.public_opened','launch_program',p_launch_program_id,jsonb_build_object('reason',p_reason,'gate',v_summary));
  return jsonb_build_object('opened',true,'launch_program_id',p_launch_program_id,'gate',v_summary);
end;
$$;

create or replace function public.pause_public_launch(p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_program uuid;
begin
  if char_length(trim(p_reason)) < 3 then raise exception 'Pause reason is required'; end if;
  select launch_program_id into v_program from public.public_access_controls where environment='production' for update;
  update public.public_access_controls set registration_open=false, invite_only=true, reason=p_reason, updated_by=p_actor, updated_at=now() where environment='production';
  if v_program is not null then update public.launch_programs set status='paused', paused_at=now() where id=v_program and status='live'; end if;
  insert into public.operational_audit_events(environment,actor_id,action,entity_type,entity_id,metadata)
  values ('production',p_actor,'launch.public_paused','launch_program',v_program,jsonb_build_object('reason',p_reason));
  return jsonb_build_object('paused',true,'launch_program_id',v_program,'reason',p_reason);
end;
$$;

create or replace function public.recompute_daily_growth_metrics(p_date date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_rows integer;
begin
  delete from public.daily_growth_metrics where metric_date=p_date;
  insert into public.daily_growth_metrics(metric_date,source,landing_views,waitlist_joins,signups,activated_workspaces,first_publishes,paid_workspaces,churned_workspaces)
  select p_date, coalesce(nullif(source,''),'direct'),
    count(*) filter(where event_type='landing_view'), count(*) filter(where event_type='waitlist_joined'),
    count(*) filter(where event_type='signup_completed'), count(*) filter(where event_type='brand_ready'),
    count(*) filter(where event_type='first_verified_publish'), count(*) filter(where event_type='subscription_started'),
    count(*) filter(where event_type='churned')
  from public.acquisition_events where occurred_at>=p_date::timestamptz and occurred_at<(p_date+1)::timestamptz
  group by coalesce(nullif(source,''),'direct');
  get diagnostics v_rows=row_count; return v_rows;
end;
$$;

revoke all on function public.public_launch_gate_summary(uuid) from public,anon,authenticated;
revoke all on function public.record_public_launch_gate(uuid,uuid) from public,anon,authenticated;
revoke all on function public.open_public_launch(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.pause_public_launch(uuid,text) from public,anon,authenticated;
revoke all on function public.recompute_daily_growth_metrics(date) from public,anon,authenticated;
grant execute on function public.public_launch_gate_summary(uuid) to service_role;
grant execute on function public.record_public_launch_gate(uuid,uuid) to service_role;
grant execute on function public.open_public_launch(uuid,uuid,text) to service_role;
grant execute on function public.pause_public_launch(uuid,text) to service_role;
grant execute on function public.recompute_daily_growth_metrics(date) to service_role;
