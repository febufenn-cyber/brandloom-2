-- Brandloom Phase 7: production launch, release governance and reliability control plane

create table public.deployment_environments (
  name text primary key check (name in ('local', 'staging', 'production')),
  display_name text not null,
  active_release_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.system_releases (
  id uuid primary key default gen_random_uuid(),
  environment text not null references public.deployment_environments(name),
  version text not null check (char_length(version) between 1 and 120),
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{7,64}$'),
  artifact_checksum text not null check (char_length(artifact_checksum) between 16 and 256),
  migration_version text not null check (migration_version ~ '^\d{4}$'),
  status text not null default 'draft' check (status in (
    'draft', 'checking', 'validated', 'promoting', 'active', 'superseded',
    'failed', 'rolled_back', 'cancelled'
  )),
  previous_release_id uuid references public.system_releases(id) on delete set null,
  release_notes text not null default '',
  metadata jsonb not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  validated_at timestamptz,
  promoted_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(environment, version),
  unique(environment, commit_sha, artifact_checksum)
);

alter table public.deployment_environments
  add constraint deployment_environments_active_release_fk
  foreign key (active_release_id) references public.system_releases(id) on delete set null;

create table public.release_gate_results (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.system_releases(id) on delete cascade,
  gate_key text not null check (gate_key in (
    'migration_verified', 'secrets_verified', 'database_health', 'provider_readiness',
    'backup_restore_verified', 'rollback_ready', 'observability_ready', 'security_review'
  )),
  status text not null default 'pending' check (status in ('pending', 'passed', 'failed', 'waived')),
  summary text not null default '',
  evidence jsonb not null default '{}',
  checked_by uuid references auth.users(id) on delete set null,
  checked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(release_id, gate_key)
);

create table public.environment_controls (
  environment text primary key references public.deployment_environments(name) on delete cascade,
  maintenance_mode boolean not null default false,
  writes_paused boolean not null default false,
  generation_paused boolean not null default false,
  publishing_paused boolean not null default false,
  reason text not null default '',
  incident_id uuid,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.service_health_checks (
  id uuid primary key default gen_random_uuid(),
  environment text not null references public.deployment_environments(name) on delete cascade,
  component text not null check (component in ('api', 'database', 'web', 'storage', 'ai_provider', 'publishing_provider', 'billing_provider', 'scheduler')),
  status text not null check (status in ('healthy', 'degraded', 'unhealthy', 'unknown')),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  release_id uuid references public.system_releases(id) on delete set null,
  source text not null default 'synthetic',
  details jsonb not null default '{}',
  checked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  incident_key text not null unique,
  environment text not null references public.deployment_environments(name),
  release_id uuid references public.system_releases(id) on delete set null,
  severity text not null check (severity in ('sev1', 'sev2', 'sev3', 'sev4')),
  status text not null default 'investigating' check (status in ('investigating', 'identified', 'monitoring', 'resolved', 'cancelled')),
  title text not null check (char_length(title) between 3 and 240),
  impact text not null default '',
  public_message text not null default '',
  owner_id uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.environment_controls
  add constraint environment_controls_incident_fk
  foreign key (incident_id) references public.incidents(id) on delete set null;

create table public.incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  event_type text not null check (event_type in ('note', 'status_change', 'mitigation', 'customer_update', 'root_cause', 'resolution')),
  message text not null check (char_length(message) between 1 and 5000),
  metadata jsonb not null default '{}',
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.backup_restore_drills (
  id uuid primary key default gen_random_uuid(),
  environment text not null references public.deployment_environments(name),
  status text not null default 'planned' check (status in ('planned', 'running', 'passed', 'failed', 'cancelled')),
  backup_reference_hash text not null default '',
  restore_target text not null default '',
  restore_point timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  recovery_point_minutes integer check (recovery_point_minutes is null or recovery_point_minutes >= 0),
  recovery_time_minutes integer check (recovery_time_minutes is null or recovery_time_minutes >= 0),
  checksum_verified boolean not null default false,
  evidence jsonb not null default '{}',
  failure_reason text not null default '',
  conducted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.release_transitions (
  id uuid primary key default gen_random_uuid(),
  environment text not null references public.deployment_environments(name),
  release_id uuid not null references public.system_releases(id) on delete cascade,
  from_release_id uuid references public.system_releases(id) on delete set null,
  transition_type text not null check (transition_type in ('promote', 'rollback', 'fail', 'cancel')),
  note text not null default '',
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.operational_audit_events (
  id uuid primary key default gen_random_uuid(),
  environment text references public.deployment_environments(name),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  trace_id text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

insert into public.deployment_environments(name, display_name)
values ('local', 'Local'), ('staging', 'Staging'), ('production', 'Production')
on conflict (name) do update set display_name = excluded.display_name;

insert into public.environment_controls(environment)
values ('local'), ('staging'), ('production')
on conflict (environment) do nothing;

create index system_releases_environment_idx on public.system_releases(environment, created_at desc);
create index release_gates_release_idx on public.release_gate_results(release_id, gate_key);
create index health_environment_component_idx on public.service_health_checks(environment, component, checked_at desc);
create index incidents_environment_status_idx on public.incidents(environment, status, started_at desc);
create index incident_events_incident_idx on public.incident_events(incident_id, created_at);
create index restore_drills_environment_idx on public.backup_restore_drills(environment, completed_at desc);
create index release_transitions_environment_idx on public.release_transitions(environment, created_at desc);
create index operational_audit_created_idx on public.operational_audit_events(created_at desc);

create trigger deployment_environments_updated_at before update on public.deployment_environments for each row execute function public.set_updated_at();
create trigger system_releases_updated_at before update on public.system_releases for each row execute function public.set_updated_at();
create trigger release_gates_updated_at before update on public.release_gate_results for each row execute function public.set_updated_at();
create trigger incidents_updated_at before update on public.incidents for each row execute function public.set_updated_at();
create trigger restore_drills_updated_at before update on public.backup_restore_drills for each row execute function public.set_updated_at();

alter table public.deployment_environments enable row level security;
alter table public.system_releases enable row level security;
alter table public.release_gate_results enable row level security;
alter table public.environment_controls enable row level security;
alter table public.service_health_checks enable row level security;
alter table public.incidents enable row level security;
alter table public.incident_events enable row level security;
alter table public.backup_restore_drills enable row level security;
alter table public.release_transitions enable row level security;
alter table public.operational_audit_events enable row level security;

grant select on public.deployment_environments, public.system_releases, public.release_gate_results,
  public.environment_controls, public.service_health_checks, public.incidents, public.incident_events,
  public.backup_restore_drills, public.release_transitions, public.operational_audit_events to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
