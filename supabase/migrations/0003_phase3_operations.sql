-- Brandloom Phase 3: campaign operations, collaboration, approvals and export handoff

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('owner', 'admin', 'editor', 'reviewer', 'approver', 'viewer')),
  status text not null default 'accepted' check (status in ('invited', 'accepted', 'suspended')),
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'editor', 'reviewer', 'approver', 'viewer')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  invited_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, email, status)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 180),
  objective text not null default '',
  audience_ids uuid[] not null default '{}',
  product_ids uuid[] not null default '{}',
  start_date date not null,
  end_date date not null,
  key_message text not null default '',
  offer_details jsonb not null default '{}',
  campaign_facts jsonb not null default '[]',
  restrictions text[] not null default '{}',
  deliverable_targets jsonb not null default '{}',
  capacity jsonb not null default '{}',
  owner_id uuid references auth.users(id) on delete set null,
  status text not null default 'planned' check (status in ('draft', 'planned', 'active', 'at_risk', 'completed', 'cancelled', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

alter table public.content_items
  add column campaign_id uuid references public.campaigns(id) on delete set null,
  add column owner_id uuid references auth.users(id) on delete set null,
  add column workflow_status text not null default 'drafting' check (workflow_status in (
    'idea', 'planned', 'drafting', 'internal_review', 'changes_requested',
    'ready_for_approval', 'approved', 'ready_to_publish', 'completed',
    'blocked', 'cancelled', 'expired'
  )),
  add column due_at timestamptz,
  add column material_revision integer not null default 1 check (material_revision > 0),
  add column completed_at timestamptz,
  add column external_publish_note text not null default '';

create table public.content_structures (
  content_item_id uuid primary key references public.content_items(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  structure_type text not null check (structure_type in ('static', 'carousel', 'reel', 'story')),
  structure jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.campaign_deliverables (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  content_item_id uuid references public.content_items(id) on delete set null,
  deliverable_type text not null check (deliverable_type in ('static', 'carousel', 'reel', 'story', 'other')),
  title text not null,
  required boolean not null default true,
  due_date date,
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'review', 'approved', 'ready', 'completed', 'blocked', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete cascade,
  content_item_id uuid references public.content_items(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 240),
  description text not null default '',
  task_type text not null default 'general' check (task_type in (
    'general', 'copy', 'fact_check', 'offer_confirmation', 'asset', 'design',
    'recording', 'review', 'approval', 'export', 'publishing_handoff'
  )),
  owner_id uuid references auth.users(id) on delete set null,
  due_at timestamptz,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  blocks_completion boolean not null default false,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.task_dependencies (
  task_id uuid not null references public.tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  name text not null,
  asset_type text not null check (asset_type in ('image', 'video', 'audio', 'logo', 'document', 'reference')),
  storage_bucket text not null default 'brand-assets',
  storage_path text not null,
  mime_type text not null default '',
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  width integer,
  height integer,
  duration_seconds numeric,
  orientation text not null default 'unknown' check (orientation in ('portrait', 'landscape', 'square', 'unknown')),
  tags text[] not null default '{}',
  rights_status text not null default 'unknown' check (rights_status in ('owned', 'licensed', 'restricted', 'expired', 'unknown')),
  approved boolean not null default false,
  approved_by uuid references auth.users(id) on delete set null,
  expires_at date,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, storage_path)
);

create table public.content_assets (
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  role text not null default 'primary' check (role in ('primary', 'cover', 'slide', 'thumbnail', 'reference', 'audio', 'attachment')),
  required boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (content_item_id, asset_id, role)
);

create table public.workflow_templates (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null,
  content_type text not null check (content_type in ('static', 'carousel', 'reel', 'story', 'any')),
  checklist jsonb not null default '[]',
  approval_steps jsonb not null default '[]',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.content_checklist_items (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  label text not null,
  category text not null default 'general' check (category in ('copy', 'facts', 'assets', 'approval', 'publishing', 'general')),
  required boolean not null default true,
  completed boolean not null default false,
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  content_version_id uuid not null references public.content_versions(id) on delete cascade,
  material_revision integer not null,
  step_number integer not null default 1 check (step_number > 0),
  approval_type text not null default 'final' check (approval_type in ('marketing', 'product_facts', 'compliance', 'founder', 'client', 'final')),
  approver_id uuid not null references auth.users(id) on delete cascade,
  required boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'approved', 'changes_requested', 'cancelled', 'stale')),
  decision_comment text not null default '',
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (content_item_id, content_version_id, approver_id, approval_type)
);

create table public.comment_threads (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  content_version_id uuid references public.content_versions(id) on delete set null,
  field text not null default 'general' check (field in ('general', 'title', 'hook', 'caption', 'cta', 'visual_brief', 'asset', 'strategy')),
  change_type text check (change_type in ('copy', 'fact', 'tone', 'visual', 'offer', 'audience', 'compliance', 'schedule')),
  blocks_approval boolean not null default false,
  status text not null default 'open' check (status in ('open', 'resolved', 'reopened')),
  created_by uuid not null references auth.users(id) on delete cascade,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.comment_threads(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  notification_type text not null,
  entity_type text not null default '',
  entity_id uuid,
  message text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.export_packages (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  content_item_id uuid references public.content_items(id) on delete cascade,
  content_version_id uuid references public.content_versions(id) on delete set null,
  export_format text not null check (export_format in ('json', 'csv', 'copy_package', 'campaign_bundle')),
  payload jsonb not null,
  checksum text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index workspace_members_user_idx on public.workspace_members(user_id, status);
create index campaigns_brand_dates_idx on public.campaigns(brand_id, start_date, end_date);
create index content_items_campaign_idx on public.content_items(campaign_id, workflow_status, scheduled_date);
create index deliverables_campaign_idx on public.campaign_deliverables(campaign_id, status);
create index tasks_brand_due_idx on public.tasks(brand_id, status, due_at);
create index assets_brand_idx on public.assets(brand_id, asset_type, approved);
create index approvals_approver_idx on public.approval_requests(approver_id, status, requested_at);
create index comments_thread_idx on public.comments(thread_id, created_at);
create index notifications_user_idx on public.notifications(user_id, read_at, created_at desc);
create index activity_workspace_idx on public.activity_events(workspace_id, created_at desc);

create trigger workspace_members_updated_at before update on public.workspace_members for each row execute function public.set_updated_at();
create trigger campaigns_updated_at before update on public.campaigns for each row execute function public.set_updated_at();
create trigger structures_updated_at before update on public.content_structures for each row execute function public.set_updated_at();
create trigger deliverables_updated_at before update on public.campaign_deliverables for each row execute function public.set_updated_at();
create trigger tasks_updated_at before update on public.tasks for each row execute function public.set_updated_at();
create trigger assets_updated_at before update on public.assets for each row execute function public.set_updated_at();
create trigger templates_updated_at before update on public.workflow_templates for each row execute function public.set_updated_at();
create trigger threads_updated_at before update on public.comment_threads for each row execute function public.set_updated_at();

insert into public.workspace_members(workspace_id, user_id, role, status, joined_at)
select id, owner_id, 'owner', 'accepted', created_at from public.workspaces
on conflict (workspace_id, user_id) do update set role = 'owner', status = 'accepted';

create or replace function public.add_workspace_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.workspace_members(workspace_id, user_id, role, status, joined_at)
  values (new.id, new.owner_id, 'owner', 'accepted', now())
  on conflict (workspace_id, user_id) do update set role = 'owner', status = 'accepted';
  return new;
end;
$$;

create trigger workspace_owner_membership_after_insert
after insert on public.workspaces
for each row execute function public.add_workspace_owner_membership();

create or replace function public.workspace_role(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(
    (select 'owner' from public.workspaces where id = p_workspace_id and owner_id = auth.uid()),
    (select role from public.workspace_members where workspace_id = p_workspace_id and user_id = auth.uid() and status = 'accepted' limit 1)
  );
$$;

create or replace function public.brand_workspace(p_brand_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select workspace_id from public.brands where id = p_brand_id; $$;

create or replace function public.can_access_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.workspace_role(p_workspace_id) is not null; $$;

create or replace function public.can_edit_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.workspace_role(p_workspace_id) in ('owner', 'admin', 'editor'); $$;

create or replace function public.can_review_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.workspace_role(p_workspace_id) in ('owner', 'admin', 'editor', 'reviewer', 'approver'); $$;

create or replace function public.can_admin_workspace(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.workspace_role(p_workspace_id) in ('owner', 'admin'); $$;

create or replace function public.can_access_brand(p_brand_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.can_access_workspace(public.brand_workspace(p_brand_id)); $$;

create or replace function public.can_edit_brand(p_brand_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.can_edit_workspace(public.brand_workspace(p_brand_id)); $$;

create or replace function public.can_review_brand(p_brand_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.can_review_workspace(public.brand_workspace(p_brand_id)); $$;

create or replace function public.content_brand(p_content_id uuid)
returns uuid language sql stable security definer set search_path = public
as $$ select brand_id from public.content_items where id = p_content_id; $$;

create or replace function public.can_access_content(p_content_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.can_access_brand(public.content_brand(p_content_id)); $$;

create or replace function public.can_edit_content(p_content_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$ select public.can_edit_brand(public.content_brand(p_content_id)); $$;

create or replace function public.accept_workspace_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_invite public.workspace_invitations;
  v_user uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_invite from public.workspace_invitations
  where token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and status = 'pending' and expires_at > now()
  for update;
  if not found then raise exception 'Invitation is invalid or expired'; end if;
  if lower(v_invite.email) <> v_email then raise exception 'Invitation email does not match signed-in user'; end if;
  insert into public.workspace_members(workspace_id, user_id, role, status, invited_by, joined_at)
  values (v_invite.workspace_id, v_user, v_invite.role, 'accepted', v_invite.invited_by, now())
  on conflict (workspace_id, user_id) do update set role = excluded.role, status = 'accepted', joined_at = now();
  update public.workspace_invitations set status = 'accepted', accepted_at = now() where id = v_invite.id;
  return v_invite.workspace_id;
end;
$$;

grant execute on function public.workspace_role(uuid) to authenticated;
grant execute on function public.can_access_workspace(uuid) to authenticated;
grant execute on function public.can_edit_workspace(uuid) to authenticated;
grant execute on function public.can_review_workspace(uuid) to authenticated;
grant execute on function public.can_admin_workspace(uuid) to authenticated;
grant execute on function public.can_access_brand(uuid) to authenticated;
grant execute on function public.can_edit_brand(uuid) to authenticated;
grant execute on function public.can_review_brand(uuid) to authenticated;
grant execute on function public.can_access_content(uuid) to authenticated;
grant execute on function public.can_edit_content(uuid) to authenticated;
grant execute on function public.accept_workspace_invitation(text) to authenticated;

alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.campaigns enable row level security;
alter table public.content_structures enable row level security;
alter table public.campaign_deliverables enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.assets enable row level security;
alter table public.content_assets enable row level security;
alter table public.workflow_templates enable row level security;
alter table public.content_checklist_items enable row level security;
alter table public.approval_requests enable row level security;
alter table public.comment_threads enable row level security;
alter table public.comments enable row level security;
alter table public.notifications enable row level security;
alter table public.activity_events enable row level security;
alter table public.export_packages enable row level security;

grant select, insert, update, delete on all tables in schema public to authenticated;

create policy members_read on public.workspace_members for select using (public.can_access_workspace(workspace_id));
create policy members_manage on public.workspace_members for all using (public.can_admin_workspace(workspace_id)) with check (public.can_admin_workspace(workspace_id));
create policy invitations_manage on public.workspace_invitations for all using (public.can_admin_workspace(workspace_id)) with check (public.can_admin_workspace(workspace_id));

create policy campaigns_read on public.campaigns for select using (public.can_access_brand(brand_id));
create policy campaigns_write on public.campaigns for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy structures_read on public.content_structures for select using (public.can_access_brand(brand_id));
create policy structures_write on public.content_structures for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy deliverables_read on public.campaign_deliverables for select using (exists (select 1 from public.campaigns c where c.id = campaign_id and public.can_access_brand(c.brand_id)));
create policy deliverables_write on public.campaign_deliverables for all using (exists (select 1 from public.campaigns c where c.id = campaign_id and public.can_edit_brand(c.brand_id))) with check (exists (select 1 from public.campaigns c where c.id = campaign_id and public.can_edit_brand(c.brand_id)));
create policy tasks_read on public.tasks for select using (public.can_access_brand(brand_id));
create policy tasks_write on public.tasks for all using (public.can_edit_brand(brand_id) or (owner_id = auth.uid() and public.can_access_brand(brand_id))) with check (public.can_edit_brand(brand_id) or (owner_id = auth.uid() and public.can_access_brand(brand_id)));
create policy dependencies_read on public.task_dependencies for select using (exists (select 1 from public.tasks t where t.id = task_id and public.can_access_brand(t.brand_id)));
create policy dependencies_write on public.task_dependencies for all using (exists (select 1 from public.tasks t where t.id = task_id and public.can_edit_brand(t.brand_id))) with check (exists (select 1 from public.tasks t where t.id = task_id and public.can_edit_brand(t.brand_id)));
create policy assets_read on public.assets for select using (public.can_access_brand(brand_id));
create policy assets_write on public.assets for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy content_assets_read on public.content_assets for select using (public.can_access_content(content_item_id));
create policy content_assets_write on public.content_assets for all using (public.can_edit_content(content_item_id)) with check (public.can_edit_content(content_item_id));
create policy templates_read on public.workflow_templates for select using (public.can_access_brand(brand_id));
create policy templates_write on public.workflow_templates for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy checklist_read on public.content_checklist_items for select using (public.can_access_content(content_item_id));
create policy checklist_write on public.content_checklist_items for all using (public.can_edit_content(content_item_id)) with check (public.can_edit_content(content_item_id));
create policy approvals_read on public.approval_requests for select using (public.can_access_content(content_item_id));
create policy approvals_create on public.approval_requests for insert with check (public.can_review_brand(public.content_brand(content_item_id)));
create policy approvals_decide on public.approval_requests for update using (approver_id = auth.uid() or public.can_admin_workspace(public.brand_workspace(public.content_brand(content_item_id)))) with check (approver_id = auth.uid() or public.can_admin_workspace(public.brand_workspace(public.content_brand(content_item_id))));
create policy threads_read on public.comment_threads for select using (public.can_access_content(content_item_id));
create policy threads_write on public.comment_threads for all using (public.can_review_brand(public.content_brand(content_item_id))) with check (public.can_review_brand(public.content_brand(content_item_id)));
create policy comments_read on public.comments for select using (exists (select 1 from public.comment_threads t where t.id = thread_id and public.can_access_content(t.content_item_id)));
create policy comments_write on public.comments for all using (author_id = auth.uid() or exists (select 1 from public.comment_threads t where t.id = thread_id and public.can_review_brand(public.content_brand(t.content_item_id)))) with check (author_id = auth.uid() and exists (select 1 from public.comment_threads t where t.id = thread_id and public.can_review_brand(public.content_brand(t.content_item_id))));
create policy notifications_own on public.notifications for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy activity_read on public.activity_events for select using (public.can_access_workspace(workspace_id));
create policy activity_insert on public.activity_events for insert with check (public.can_access_workspace(workspace_id));
create policy exports_read on public.export_packages for select using (public.can_access_brand(brand_id));
create policy exports_write on public.export_packages for insert with check (public.can_edit_brand(brand_id));

-- Add collaboration access without removing the original owner-only policies.
create policy workspace_member_read on public.workspaces for select using (public.can_access_workspace(id));
create policy brand_member_read on public.brands for select using (public.can_access_workspace(workspace_id));
create policy brand_member_write on public.brands for all using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy voice_member_read on public.brand_voice_profiles for select using (public.can_access_brand(brand_id));
create policy voice_member_write on public.brand_voice_profiles for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy product_member_read on public.products for select using (public.can_access_brand(brand_id));
create policy product_member_write on public.products for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy audience_member_read on public.audiences for select using (public.can_access_brand(brand_id));
create policy audience_member_write on public.audiences for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy examples_member_read on public.content_examples for select using (public.can_access_brand(brand_id));
create policy examples_member_write on public.content_examples for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy plans_member_read on public.weekly_plans for select using (public.can_access_brand(brand_id));
create policy plans_member_write on public.weekly_plans for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy content_member_read on public.content_items for select using (public.can_access_brand(brand_id));
create policy content_member_write on public.content_items for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy versions_member_read on public.content_versions for select using (public.can_access_content(content_item_id));
create policy versions_member_write on public.content_versions for all using (public.can_edit_content(content_item_id)) with check (public.can_edit_content(content_item_id));
create policy feedback_member_read on public.feedback_events for select using (public.can_access_brand(brand_id));
create policy feedback_member_write on public.feedback_events for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy generations_member_read on public.generation_runs for select using (public.can_access_brand(brand_id));
create policy generations_member_write on public.generation_runs for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy memory_member_read on public.memory_items for select using (public.can_access_brand(brand_id));
create policy memory_member_write on public.memory_items for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy memory_evidence_member_read on public.memory_evidence for select using (public.can_access_brand(brand_id));
create policy memory_evidence_member_write on public.memory_evidence for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy edit_analysis_member_read on public.edit_analyses for select using (public.can_access_brand(brand_id));
create policy content_features_member_read on public.content_features for select using (public.can_access_brand(brand_id));
create policy confirmations_member_read on public.memory_confirmations for select using (public.can_access_brand(brand_id));
create policy learning_reviews_member_read on public.weekly_learning_reviews for select using (public.can_access_brand(brand_id));
create policy experiments_member_read on public.brand_experiments for select using (public.can_access_brand(brand_id));
create policy retrieval_member_read on public.memory_retrieval_logs for select using (public.can_access_brand(brand_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand-assets', 'brand-assets', false, 52428800, array['image/jpeg','image/png','image/webp','video/mp4','audio/mpeg','application/pdf'])
on conflict (id) do nothing;

create policy brand_assets_read on storage.objects for select to authenticated
using (bucket_id = 'brand-assets' and public.can_access_brand((storage.foldername(name))[1]::uuid));
create policy brand_assets_insert on storage.objects for insert to authenticated
with check (bucket_id = 'brand-assets' and public.can_edit_brand((storage.foldername(name))[1]::uuid));
create policy brand_assets_update on storage.objects for update to authenticated
using (bucket_id = 'brand-assets' and public.can_edit_brand((storage.foldername(name))[1]::uuid))
with check (bucket_id = 'brand-assets' and public.can_edit_brand((storage.foldername(name))[1]::uuid));
create policy brand_assets_delete on storage.objects for delete to authenticated
using (bucket_id = 'brand-assets' and public.can_edit_brand((storage.foldername(name))[1]::uuid));
