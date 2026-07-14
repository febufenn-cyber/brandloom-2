-- Brandloom Phase 10: controlled public launch and privacy-safe growth operations

create table public.launch_programs (
  id uuid primary key default gen_random_uuid(),
  environment text not null references public.deployment_environments(name),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  name text not null check (char_length(name) between 3 and 160),
  status text not null default 'draft' check (status in ('draft', 'gating', 'ready', 'live', 'paused', 'completed', 'cancelled')),
  launch_version text not null default '',
  target_at timestamptz,
  launched_at timestamptz,
  paused_at timestamptz,
  metadata jsonb not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(environment, launch_version)
);

create table public.launch_checklist_items (
  id uuid primary key default gen_random_uuid(),
  launch_program_id uuid not null references public.launch_programs(id) on delete cascade,
  item_key text not null,
  category text not null check (category in ('product', 'security', 'legal', 'support', 'operations', 'billing', 'publishing', 'data_rights', 'communications')),
  title text not null check (char_length(title) between 3 and 240),
  required boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'passed', 'failed', 'waived')),
  evidence jsonb not null default '{}',
  summary text not null default '',
  checked_by uuid references auth.users(id) on delete set null,
  checked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(launch_program_id, item_key)
);

create table public.public_access_controls (
  environment text primary key references public.deployment_environments(name) on delete cascade,
  launch_program_id uuid references public.launch_programs(id) on delete set null,
  registration_open boolean not null default false,
  waitlist_open boolean not null default true,
  invite_only boolean not null default true,
  daily_signup_limit integer not null default 100 check (daily_signup_limit between 1 and 100000),
  reason text not null default 'Pre-launch',
  opened_by uuid references auth.users(id) on delete set null,
  opened_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.launch_gate_assessments (
  id uuid primary key default gen_random_uuid(),
  launch_program_id uuid not null references public.launch_programs(id) on delete cascade,
  environment text not null references public.deployment_environments(name),
  status text not null check (status in ('passed', 'failed', 'blocked')),
  summary jsonb not null,
  assessed_by uuid references auth.users(id) on delete set null,
  assessed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  email_hash text not null unique,
  status text not null default 'waiting' check (status in ('waiting', 'invited', 'converted', 'unsubscribed', 'blocked')),
  source text not null default 'direct',
  medium text not null default '',
  campaign text not null default '',
  referral_code text not null default '',
  consent_version text not null,
  consented_at timestamptz not null,
  metadata jsonb not null default '{}',
  invited_at timestamptz,
  converted_user_id uuid references auth.users(id) on delete set null,
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.referral_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6,20}$'),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'paused', 'expired', 'revoked')),
  max_conversions integer check (max_conversions is null or max_conversions > 0),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique(workspace_id, owner_user_id)
);

create table public.referral_attributions (
  id uuid primary key default gen_random_uuid(),
  referral_code_id uuid not null references public.referral_codes(id) on delete cascade,
  waitlist_entry_id uuid references public.waitlist_entries(id) on delete set null,
  referred_user_id uuid references auth.users(id) on delete set null,
  status text not null default 'attributed' check (status in ('attributed', 'qualified', 'converted', 'rejected')),
  qualified_at timestamptz,
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(referral_code_id, waitlist_entry_id),
  unique(referral_code_id, referred_user_id)
);

create table public.acquisition_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null check (event_type in ('landing_view', 'waitlist_joined', 'signup_started', 'signup_completed', 'workspace_created', 'brand_ready', 'first_approved_content', 'first_verified_publish', 'trial_started', 'subscription_started', 'churned')),
  anonymous_id_hash text not null default '',
  user_id uuid references auth.users(id) on delete set null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  source text not null default 'direct',
  medium text not null default '',
  campaign text not null default '',
  content text not null default '',
  referral_code text not null default '',
  properties jsonb not null default '{}',
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);

create table public.growth_experiments (
  id uuid primary key default gen_random_uuid(),
  experiment_key text not null unique,
  name text not null check (char_length(name) between 3 and 200),
  surface text not null check (surface in ('landing', 'pricing', 'onboarding', 'activation', 'referral', 'lifecycle')),
  hypothesis text not null default '',
  status text not null default 'draft' check (status in ('draft', 'running', 'paused', 'completed', 'cancelled')),
  variants jsonb not null check (jsonb_typeof(variants) = 'array'),
  allocation_percent integer not null default 100 check (allocation_percent between 1 and 100),
  primary_metric text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.growth_experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.growth_experiments(id) on delete cascade,
  subject_hash text not null,
  variant_key text not null,
  assigned_at timestamptz not null default now(),
  unique(experiment_id, subject_hash)
);

create table public.growth_experiment_outcomes (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.growth_experiment_assignments(id) on delete cascade,
  metric_key text not null,
  metric_value numeric not null default 1,
  event_key text not null unique,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.lifecycle_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  action_type text not null check (action_type in ('welcome', 'activation_help', 'usage_warning', 'trial_expiry', 'publish_recovery', 'feedback_request', 'winback')),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'queued', 'sent', 'cancelled', 'failed')),
  channel text not null default 'in_app' check (channel in ('in_app', 'email')),
  payload jsonb not null default '{}',
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  scheduled_for timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.daily_growth_metrics (
  metric_date date not null,
  source text not null default 'all',
  landing_views integer not null default 0,
  waitlist_joins integer not null default 0,
  signups integer not null default 0,
  activated_workspaces integer not null default 0,
  first_publishes integer not null default 0,
  paid_workspaces integer not null default 0,
  churned_workspaces integer not null default 0,
  computed_at timestamptz not null default now(),
  primary key(metric_date, source)
);

insert into public.public_access_controls(environment)
values ('local'), ('staging'), ('production')
on conflict (environment) do nothing;

create index launch_checklist_program_idx on public.launch_checklist_items(launch_program_id, category, status);
create index launch_gate_program_idx on public.launch_gate_assessments(launch_program_id, assessed_at desc);
create index waitlist_status_created_idx on public.waitlist_entries(status, created_at desc);
create index acquisition_type_time_idx on public.acquisition_events(event_type, occurred_at desc);
create index acquisition_source_time_idx on public.acquisition_events(source, occurred_at desc);
create index lifecycle_status_schedule_idx on public.lifecycle_actions(status, scheduled_for);
create index growth_outcomes_assignment_idx on public.growth_experiment_outcomes(assignment_id, metric_key);

create trigger launch_programs_updated_at before update on public.launch_programs for each row execute function public.set_updated_at();
create trigger launch_checklist_updated_at before update on public.launch_checklist_items for each row execute function public.set_updated_at();
create trigger waitlist_entries_updated_at before update on public.waitlist_entries for each row execute function public.set_updated_at();
create trigger growth_experiments_updated_at before update on public.growth_experiments for each row execute function public.set_updated_at();
create trigger lifecycle_actions_updated_at before update on public.lifecycle_actions for each row execute function public.set_updated_at();

alter table public.launch_programs enable row level security;
alter table public.launch_checklist_items enable row level security;
alter table public.public_access_controls enable row level security;
alter table public.launch_gate_assessments enable row level security;
alter table public.waitlist_entries enable row level security;
alter table public.referral_codes enable row level security;
alter table public.referral_attributions enable row level security;
alter table public.acquisition_events enable row level security;
alter table public.growth_experiments enable row level security;
alter table public.growth_experiment_assignments enable row level security;
alter table public.growth_experiment_outcomes enable row level security;
alter table public.lifecycle_actions enable row level security;
alter table public.daily_growth_metrics enable row level security;

grant select on public.launch_programs, public.launch_checklist_items, public.public_access_controls,
  public.launch_gate_assessments, public.referral_codes, public.growth_experiments,
  public.daily_growth_metrics to authenticated;
grant select, insert, update, delete on public.launch_programs, public.launch_checklist_items,
  public.public_access_controls, public.launch_gate_assessments, public.waitlist_entries,
  public.referral_codes, public.referral_attributions, public.acquisition_events,
  public.growth_experiments, public.growth_experiment_assignments, public.growth_experiment_outcomes,
  public.lifecycle_actions, public.daily_growth_metrics to service_role;
