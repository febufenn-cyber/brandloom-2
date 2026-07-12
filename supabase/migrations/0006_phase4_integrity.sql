-- Brandloom Phase 4 integrity helpers and database-enforced safety boundaries

create or replace function public.can_publish_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.workspace_role(p_workspace_id) in ('owner', 'admin', 'publisher'); $$;

create or replace function public.can_manage_connections_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.workspace_role(p_workspace_id) in ('owner', 'admin', 'connection_manager'); $$;

grant execute on function public.can_publish_workspace(uuid) to authenticated;
grant execute on function public.can_manage_connections_workspace(uuid) to authenticated;

create or replace function public.prevent_publication_snapshot_mutation()
returns trigger language plpgsql set search_path = public
as $$ begin raise exception 'Publication snapshots are immutable'; end; $$;

create trigger publication_snapshots_immutable_update
before update on public.publication_snapshots for each row execute function public.prevent_publication_snapshot_mutation();
create trigger publication_snapshots_immutable_delete
before delete on public.publication_snapshots for each row execute function public.prevent_publication_snapshot_mutation();

create or replace function public.log_publication_status_change()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if old.status is distinct from new.status then
    insert into public.publication_events(publication_job_id, previous_status, next_status, source, reason, metadata)
    values (new.id, old.status, new.status, 'system', new.safe_error_message, jsonb_build_object('attempt_count', new.attempt_count));
  end if;
  return new;
end;
$$;

create trigger publication_job_status_audit
after update on public.publication_jobs for each row execute function public.log_publication_status_change();

create or replace function public.claim_publication_job(p_job_id uuid, p_lock_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  update public.publication_jobs
  set status = case when status = 'retry_waiting' then 'retrying' else 'dispatching' end,
      lock_token = p_lock_token,
      locked_at = now(),
      attempt_count = attempt_count + 1
  where id = p_job_id
    and status in ('scheduled', 'ready', 'retry_waiting')
    and coalesce(next_attempt_at, scheduled_for) <= now()
    and (locked_at is null or locked_at < now() - interval '10 minutes');
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.claim_publication_job(uuid, text) from public;
grant execute on function public.claim_publication_job(uuid, text) to service_role;

create or replace function public.expire_oauth_attempts()
returns integer language plpgsql security definer set search_path = public
as $$
declare v_count integer;
begin
  update public.oauth_connection_attempts set status = 'expired'
  where status = 'pending' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_oauth_attempts() from public;
grant execute on function public.expire_oauth_attempts() to service_role;

-- Service workers need to write delivery records while end users receive read-only access.
grant select, insert, update, delete on public.platform_credentials to service_role;
grant select, insert, update, delete on public.connection_health_checks to service_role;
grant select, insert, update, delete on public.publication_attempts to service_role;
grant select, insert, update, delete on public.remote_publications to service_role;
grant select, insert, update, delete on public.publication_events to service_role;
grant select, insert, update, delete on public.provider_webhook_events to service_role;
