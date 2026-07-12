-- Brandloom Phase 4 role expansion and publishing permission helpers

alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members add constraint workspace_members_role_check
  check (role in ('owner', 'admin', 'editor', 'reviewer', 'approver', 'publisher', 'connection_manager', 'viewer'));

alter table public.workspace_invitations drop constraint if exists workspace_invitations_role_check;
alter table public.workspace_invitations add constraint workspace_invitations_role_check
  check (role in ('admin', 'editor', 'reviewer', 'approver', 'publisher', 'connection_manager', 'viewer'));

create or replace function public.can_publish_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.workspace_role(p_workspace_id) in ('owner', 'admin', 'publisher'); $$;

create or replace function public.can_manage_connections_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.workspace_role(p_workspace_id) in ('owner', 'admin', 'connection_manager'); $$;

grant execute on function public.can_publish_workspace(uuid) to authenticated;
grant execute on function public.can_manage_connections_workspace(uuid) to authenticated;
