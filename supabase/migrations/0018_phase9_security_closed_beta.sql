-- Brandloom Phase 9: security hardening, QA evidence and closed beta governance

create table public.beta_programs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  name text not null check (char_length(name) between 3 and 160),
  status text not null default 'draft' check (status in ('draft', 'recruiting', 'active', 'paused', 'completed', 'cancelled')),
  capacity integer not null default 25 check (capacity between 1 and 10000),
  consent_version text not null check (char_length(consent_version) between 1 and 80),
  starts_at timestamptz,
  ends_at timestamptz,
  metadata jsonb not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.beta_invites (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.beta_programs(id) on delete cascade,
  email_hash text not null,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  intended_role text not null default 'owner' check (intended_role in ('owner', 'admin', 'editor', 'reviewer', 'viewer')),
  expires_at timestamptz not null,
  invited_by uuid references auth.users(id) on delete set null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.beta_participants (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.beta_programs(id) on delete cascade,
  invite_id uuid references public.beta_invites(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete set null,
  status text not null default 'accepted' check (status in ('accepted', 'onboarding', 'active', 'paused', 'exited', 'removed')),
  consent_version text not null,
  consented_at timestamptz not null,
  cohort_label text not null default 'default',
  risk_flags jsonb not null default '[]',
  activated_at timestamptz,
  exited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(program_id, user_id)
);

create table public.beta_feedback (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.beta_programs(id) on delete cascade,
  participant_id uuid references public.beta_participants(id) on delete set null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  submitted_by uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('bug', 'quality', 'publishing', 'billing', 'security', 'usability', 'feature', 'other')),
  severity text not null default 'medium' check (severity in ('critical', 'high', 'medium', 'low')),
  status text not null default 'new' check (status in ('new', 'triaged', 'investigating', 'planned', 'resolved', 'closed', 'duplicate')),
  title text not null check (char_length(title) between 3 and 240),
  description text not null default '',
  reproduction text not null default '',
  trace_id text not null default '',
  safe_context jsonb not null default '{}',
  assigned_to uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.qa_test_runs (
  id uuid primary key default gen_random_uuid(),
  environment text not null references public.deployment_environments(name),
  suite text not null check (suite in ('auth', 'rls', 'generation', 'publishing', 'billing', 'data_rights', 'reliability', 'accessibility', 'performance', 'security')),
  status text not null default 'running' check (status in ('running', 'passed', 'failed', 'blocked', 'cancelled')),
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{7,64}$'),
  release_id uuid references public.system_releases(id) on delete set null,
  source text not null default 'manual' check (source in ('ci', 'manual', 'synthetic', 'beta')),
  cases_total integer not null default 0 check (cases_total >= 0),
  cases_passed integer not null default 0 check (cases_passed >= 0),
  cases_failed integer not null default 0 check (cases_failed >= 0),
  result jsonb not null default '{}',
  safe_error text not null default '',
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.security_findings (
  id uuid primary key default gen_random_uuid(),
  finding_key text not null unique,
  severity text not null check (severity in ('critical', 'high', 'medium', 'low', 'informational')),
  status text not null default 'open' check (status in ('open', 'triaged', 'in_progress', 'mitigated', 'accepted', 'closed', 'false_positive')),
  title text not null check (char_length(title) between 3 and 240),
  description text not null default '',
  affected_component text not null default '',
  evidence jsonb not null default '{}',
  remediation text not null default '',
  owner_id uuid references auth.users(id) on delete set null,
  due_at timestamptz,
  mitigated_at timestamptz,
  closed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.beta_gate_assessments (
  id uuid primary key default gen_random_uuid(),
  environment text not null references public.deployment_environments(name),
  program_id uuid references public.beta_programs(id) on delete set null,
  status text not null check (status in ('passed', 'failed', 'blocked')),
  summary jsonb not null,
  assessed_by uuid references auth.users(id) on delete set null,
  assessed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.api_rate_limit_buckets (
  key_hash text not null,
  scope text not null,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  expires_at timestamptz not null,
  primary key(key_hash, scope, window_start)
);

create index beta_invites_program_status_idx on public.beta_invites(program_id, status, expires_at);
create index beta_participants_program_status_idx on public.beta_participants(program_id, status);
create index beta_feedback_program_status_idx on public.beta_feedback(program_id, status, severity, created_at desc);
create index qa_test_runs_environment_suite_idx on public.qa_test_runs(environment, suite, completed_at desc);
create index security_findings_status_severity_idx on public.security_findings(status, severity, created_at desc);
create index beta_gate_environment_idx on public.beta_gate_assessments(environment, assessed_at desc);
create index api_rate_limit_expiry_idx on public.api_rate_limit_buckets(expires_at);

create trigger beta_programs_updated_at before update on public.beta_programs for each row execute function public.set_updated_at();
create trigger beta_participants_updated_at before update on public.beta_participants for each row execute function public.set_updated_at();
create trigger beta_feedback_updated_at before update on public.beta_feedback for each row execute function public.set_updated_at();
create trigger security_findings_updated_at before update on public.security_findings for each row execute function public.set_updated_at();

alter table public.beta_programs enable row level security;
alter table public.beta_invites enable row level security;
alter table public.beta_participants enable row level security;
alter table public.beta_feedback enable row level security;
alter table public.qa_test_runs enable row level security;
alter table public.security_findings enable row level security;
alter table public.beta_gate_assessments enable row level security;
alter table public.api_rate_limit_buckets enable row level security;

grant select on public.beta_programs, public.beta_participants, public.beta_feedback to authenticated;
grant select on public.qa_test_runs, public.security_findings, public.beta_gate_assessments to authenticated;
grant select, insert, update, delete on public.beta_programs, public.beta_invites,
  public.beta_participants, public.beta_feedback, public.qa_test_runs,
  public.security_findings, public.beta_gate_assessments, public.api_rate_limit_buckets to service_role;
