-- Brandloom Phase 8: live infrastructure and provider activation evidence

create table public.provider_activation_profiles (
  environment text primary key references public.deployment_environments(name) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'checking', 'ready', 'active', 'blocked', 'suspended')),
  release_id uuid references public.system_releases(id) on delete set null,
  configuration_fingerprint text not null default '',
  last_checked_at timestamptz,
  activated_at timestamptz,
  activated_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.provider_activation_checks (
  id uuid primary key default gen_random_uuid(),
  environment text not null references public.deployment_environments(name) on delete cascade,
  activation_run_id uuid not null,
  component text not null check (component in (
    'database', 'web', 'worker', 'storage', 'ai_provider',
    'publishing_provider', 'billing_provider', 'webhooks'
  )),
  status text not null check (status in ('pending', 'passed', 'failed', 'waived')),
  summary text not null default '',
  evidence jsonb not null default '{}',
  checked_by uuid references auth.users(id) on delete set null,
  checked_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.deployment_verification_runs (
  id uuid primary key default gen_random_uuid(),
  environment text not null references public.deployment_environments(name),
  release_id uuid references public.system_releases(id) on delete set null,
  status text not null default 'running' check (status in ('running', 'passed', 'failed', 'cancelled')),
  source text not null default 'operator' check (source in ('operator', 'workflow', 'scheduled')),
  commit_sha text not null default '',
  artifact_checksum text not null default '',
  result jsonb not null default '{}',
  safe_error text not null default '',
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

insert into public.provider_activation_profiles(environment)
values ('local'), ('staging'), ('production')
on conflict (environment) do nothing;

create index provider_activation_checks_environment_idx
  on public.provider_activation_checks(environment, checked_at desc);
create index provider_activation_checks_run_idx
  on public.provider_activation_checks(activation_run_id, component);
create index deployment_verification_runs_environment_idx
  on public.deployment_verification_runs(environment, started_at desc);

create trigger provider_activation_profiles_updated_at
before update on public.provider_activation_profiles
for each row execute function public.set_updated_at();

alter table public.provider_activation_profiles enable row level security;
alter table public.provider_activation_checks enable row level security;
alter table public.deployment_verification_runs enable row level security;

grant select on public.provider_activation_profiles, public.provider_activation_checks,
  public.deployment_verification_runs to authenticated;
grant select, insert, update, delete on public.provider_activation_profiles,
  public.provider_activation_checks, public.deployment_verification_runs to service_role;
