-- Brandloom Phase 4: connection custody, immutable publication snapshots and delivery audit

alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members add constraint workspace_members_role_check
  check (role in ('owner', 'admin', 'editor', 'reviewer', 'approver', 'publisher', 'connection_manager', 'viewer'));

alter table public.workspace_invitations drop constraint if exists workspace_invitations_role_check;
alter table public.workspace_invitations add constraint workspace_invitations_role_check
  check (role in ('admin', 'editor', 'reviewer', 'approver', 'publisher', 'connection_manager', 'viewer'));

create table public.oauth_connection_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  provider text not null check (provider in ('meta_instagram')),
  state_hash text not null unique,
  code_verifier_ciphertext text,
  code_verifier_nonce text,
  redirect_uri text not null,
  requested_scopes text[] not null default '{}',
  created_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'consumed', 'expired', 'failed')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  safe_error text not null default '',
  created_at timestamptz not null default now()
);

create table public.platform_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null check (provider in ('meta_instagram')),
  connected_by uuid references auth.users(id) on delete set null,
  provider_user_id text not null default '',
  granted_scopes text[] not null default '{}',
  status text not null default 'connected' check (status in (
    'connecting', 'connected', 'healthy', 'permission_limited', 'token_expiring',
    'reauthorization_required', 'revoked', 'account_unavailable', 'platform_restricted',
    'disconnected', 'error'
  )),
  metadata jsonb not null default '{}',
  last_validated_at timestamptz,
  reauthorization_required_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- This table is intentionally service-role only. No authenticated grants or policies are created.
create table public.platform_credentials (
  connection_id uuid primary key references public.platform_connections(id) on delete cascade,
  access_token_ciphertext text not null,
  access_token_nonce text not null,
  refresh_token_ciphertext text,
  refresh_token_nonce text,
  token_type text not null default 'Bearer',
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  key_version integer not null default 1,
  last_refreshed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.platform_accounts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.platform_connections(id) on delete cascade,
  provider_account_id text not null,
  username text not null default '',
  display_name text not null default '',
  profile_image_url text not null default '',
  account_type text not null default '',
  capabilities jsonb not null default '{}',
  status text not null default 'discovered' check (status in ('discovered', 'confirmed', 'healthy', 'limited', 'unavailable', 'disconnected')),
  publishing_tested_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, provider_account_id)
);

create table public.brand_platform_accounts (
  brand_id uuid not null references public.brands(id) on delete cascade,
  platform_account_id uuid not null references public.platform_accounts(id) on delete cascade,
  is_default boolean not null default false,
  publishing_enabled boolean not null default false,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (brand_id, platform_account_id)
);

create table public.connection_health_checks (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.platform_connections(id) on delete cascade,
  status text not null,
  scopes text[] not null default '{}',
  capabilities jsonb not null default '{}',
  safe_errors jsonb not null default '[]',
  checked_at timestamptz not null default now()
);

create table public.publishing_controls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete cascade,
  platform_account_id uuid references public.platform_accounts(id) on delete cascade,
  publishing_paused boolean not null default false,
  pause_reason text not null default '',
  paused_by uuid references auth.users(id) on delete set null,
  paused_at timestamptz,
  resumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index publishing_controls_scope_idx on public.publishing_controls(
  workspace_id,
  coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(platform_account_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

create table public.publication_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  content_version_id uuid not null references public.content_versions(id) on delete restrict,
  material_revision integer not null check (material_revision > 0),
  platform_account_id uuid not null references public.platform_accounts(id) on delete restrict,
  snapshot jsonb not null,
  asset_checksums jsonb not null default '[]',
  approval_snapshot jsonb not null default '[]',
  preflight_snapshot jsonb not null default '{}',
  snapshot_checksum text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.publication_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  publication_snapshot_id uuid not null references public.publication_snapshots(id) on delete restrict,
  scheduled_for timestamptz not null,
  brand_timezone text not null default 'UTC',
  local_scheduled_time text not null default '',
  status text not null default 'scheduled' check (status in (
    'eligible', 'scheduled', 'preflight_queued', 'preflight_failed', 'ready', 'dispatching',
    'remote_media_created', 'remote_processing', 'publish_requested', 'published', 'verified',
    'completed', 'retry_waiting', 'retrying', 'permission_failure', 'asset_failure',
    'remote_rejection', 'verification_uncertain', 'manual_action_required', 'cancelled',
    'superseded', 'expired', 'manual_published'
  )),
  idempotency_key text not null unique,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  locked_at timestamptz,
  lock_token text,
  last_error_category text not null default '',
  safe_error_message text not null default '',
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  manual_published_at timestamptz,
  manual_published_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.publication_attempts (
  id uuid primary key default gen_random_uuid(),
  publication_job_id uuid not null references public.publication_jobs(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  provider_stage text not null default 'starting',
  remote_container_id text,
  remote_media_id text,
  error_category text not null default '',
  provider_error_code text not null default '',
  safe_error_message text not null default '',
  result jsonb not null default '{}',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (publication_job_id, attempt_number)
);

create table public.remote_publications (
  id uuid primary key default gen_random_uuid(),
  publication_job_id uuid not null unique references public.publication_jobs(id) on delete cascade,
  platform_account_id uuid not null references public.platform_accounts(id) on delete restrict,
  remote_media_id text not null,
  permalink text not null default '',
  published_at timestamptz,
  verified_at timestamptz,
  remote_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.publication_events (
  id uuid primary key default gen_random_uuid(),
  publication_job_id uuid not null references public.publication_jobs(id) on delete cascade,
  previous_status text,
  next_status text not null,
  actor_id uuid references auth.users(id) on delete set null,
  source text not null default 'system' check (source in ('system', 'user', 'provider', 'reconciliation')),
  reason text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('meta_instagram')),
  event_key text not null unique,
  event_type text not null default '',
  signature_valid boolean not null default false,
  payload jsonb not null default '{}',
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  safe_error text not null default ''
);

create index oauth_attempts_state_idx on public.oauth_connection_attempts(state_hash, status, expires_at);
create index connections_workspace_idx on public.platform_connections(workspace_id, status);
create index accounts_connection_idx on public.platform_accounts(connection_id, status);
create index brand_accounts_brand_idx on public.brand_platform_accounts(brand_id, publishing_enabled);
create index snapshots_content_idx on public.publication_snapshots(content_item_id, created_at desc);
create index publication_jobs_due_idx on public.publication_jobs(status, coalesce(next_attempt_at, scheduled_for));
create index publication_jobs_brand_idx on public.publication_jobs(brand_id, scheduled_for desc);
create index publication_attempts_job_idx on public.publication_attempts(publication_job_id, attempt_number desc);
create index publication_events_job_idx on public.publication_events(publication_job_id, created_at);

create trigger platform_connections_updated_at before update on public.platform_connections for each row execute function public.set_updated_at();
create trigger platform_credentials_updated_at before update on public.platform_credentials for each row execute function public.set_updated_at();
create trigger platform_accounts_updated_at before update on public.platform_accounts for each row execute function public.set_updated_at();
create trigger publishing_controls_updated_at before update on public.publishing_controls for each row execute function public.set_updated_at();
create trigger publication_jobs_updated_at before update on public.publication_jobs for each row execute function public.set_updated_at();
create trigger remote_publications_updated_at before update on public.remote_publications for each row execute function public.set_updated_at();

alter table public.oauth_connection_attempts enable row level security;
alter table public.platform_connections enable row level security;
alter table public.platform_credentials enable row level security;
alter table public.platform_accounts enable row level security;
alter table public.brand_platform_accounts enable row level security;
alter table public.connection_health_checks enable row level security;
alter table public.publishing_controls enable row level security;
alter table public.publication_snapshots enable row level security;
alter table public.publication_jobs enable row level security;
alter table public.publication_attempts enable row level security;
alter table public.remote_publications enable row level security;
alter table public.publication_events enable row level security;
alter table public.provider_webhook_events enable row level security;

grant select, insert, update, delete on public.oauth_connection_attempts to authenticated;
grant select, insert, update, delete on public.platform_connections to authenticated;
grant select, insert, update, delete on public.platform_accounts to authenticated;
grant select, insert, update, delete on public.brand_platform_accounts to authenticated;
grant select on public.connection_health_checks to authenticated;
grant select, insert, update, delete on public.publishing_controls to authenticated;
grant select, insert on public.publication_snapshots to authenticated;
grant select, insert, update on public.publication_jobs to authenticated;
grant select on public.publication_attempts to authenticated;
grant select on public.remote_publications to authenticated;
grant select on public.publication_events to authenticated;

create policy oauth_attempt_owner on public.oauth_connection_attempts for all
  using (created_by = auth.uid() and public.can_admin_workspace(workspace_id))
  with check (created_by = auth.uid() and public.can_admin_workspace(workspace_id));
create policy connections_read on public.platform_connections for select using (public.can_access_workspace(workspace_id));
create policy connections_manage on public.platform_connections for all
  using (public.can_manage_connections_workspace(workspace_id)) with check (public.can_manage_connections_workspace(workspace_id));
create policy accounts_read on public.platform_accounts for select
  using (exists (select 1 from public.platform_connections c where c.id = connection_id and public.can_access_workspace(c.workspace_id)));
create policy accounts_manage on public.platform_accounts for all
  using (exists (select 1 from public.platform_connections c where c.id = connection_id and public.can_manage_connections_workspace(c.workspace_id)))
  with check (exists (select 1 from public.platform_connections c where c.id = connection_id and public.can_manage_connections_workspace(c.workspace_id)));
create policy brand_accounts_read on public.brand_platform_accounts for select using (public.can_access_brand(brand_id));
create policy brand_accounts_manage on public.brand_platform_accounts for all
  using (public.can_manage_connections_workspace(public.brand_workspace(brand_id)))
  with check (public.can_manage_connections_workspace(public.brand_workspace(brand_id)));
create policy health_read on public.connection_health_checks for select
  using (exists (select 1 from public.platform_connections c where c.id = connection_id and public.can_access_workspace(c.workspace_id)));
create policy controls_read on public.publishing_controls for select using (public.can_access_workspace(workspace_id));
create policy controls_manage on public.publishing_controls for all
  using (public.can_publish_workspace(workspace_id)) with check (public.can_publish_workspace(workspace_id));
create policy snapshots_read on public.publication_snapshots for select using (public.can_access_brand(brand_id));
create policy snapshots_create on public.publication_snapshots for insert with check (public.can_publish_workspace(workspace_id));
create policy jobs_read on public.publication_jobs for select using (public.can_access_brand(brand_id));
create policy jobs_create on public.publication_jobs for insert with check (public.can_publish_workspace(workspace_id));
create policy jobs_manage on public.publication_jobs for update using (public.can_publish_workspace(workspace_id)) with check (public.can_publish_workspace(workspace_id));
create policy attempts_read on public.publication_attempts for select
  using (exists (select 1 from public.publication_jobs j where j.id = publication_job_id and public.can_access_brand(j.brand_id)));
create policy remote_read on public.remote_publications for select
  using (exists (select 1 from public.publication_jobs j where j.id = publication_job_id and public.can_access_brand(j.brand_id)));
create policy publication_events_read on public.publication_events for select
  using (exists (select 1 from public.publication_jobs j where j.id = publication_job_id and public.can_access_brand(j.brand_id)));
