-- Brandloom Phase 5: commercial plans, billing state, entitlements, usage, cost and data rights

create table public.billing_plans (
  code text primary key,
  name text not null,
  description text not null default '',
  public boolean not null default true,
  features jsonb not null default '{}',
  limits jsonb not null default '{}',
  monthly_amount integer not null default 0 check (monthly_amount >= 0),
  currency text not null default 'usd',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.billing_prices (
  id uuid primary key default gen_random_uuid(),
  plan_code text not null references public.billing_plans(code) on delete cascade,
  provider text not null check (provider in ('mock', 'stripe')),
  provider_price_id text not null,
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year')),
  currency text not null default 'usd',
  amount integer not null default 0 check (amount >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(provider, provider_price_id)
);

create table public.billing_customers (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  provider text not null check (provider in ('mock', 'stripe')),
  provider_customer_id text not null unique,
  billing_email text not null default '',
  currency text not null default 'usd',
  tax_metadata jsonb not null default '{}',
  provider_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  provider text not null default 'mock' check (provider in ('mock', 'stripe')),
  provider_subscription_id text unique,
  plan_code text not null references public.billing_plans(code),
  status text not null check (status in (
    'trialing', 'active', 'incomplete', 'incomplete_expired', 'past_due',
    'unpaid', 'paused', 'canceled'
  )),
  access_state text not null default 'full' check (access_state in ('full', 'grace', 'read_only', 'closed')),
  trial_start timestamptz,
  trial_end timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  grace_ends_at timestamptz,
  provider_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.entitlement_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  plan_code text not null references public.billing_plans(code),
  subscription_status text not null,
  access_state text not null check (access_state in ('full', 'grace', 'read_only', 'closed')),
  features jsonb not null,
  limits jsonb not null,
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  version integer not null check (version > 0),
  created_at timestamptz not null default now(),
  unique(workspace_id, version)
);

create table public.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  usage_type text not null,
  reserved_quantity numeric not null check (reserved_quantity > 0),
  period_key text not null,
  request_id text not null,
  status text not null default 'reserved' check (status in ('reserved', 'finalized', 'released', 'expired')),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique(workspace_id, request_id)
);

create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  brand_id uuid references public.brands(id) on delete set null,
  usage_type text not null,
  quantity numeric not null,
  period_key text not null,
  provider text not null default '',
  model text not null default '',
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_micros bigint not null default 0 check (estimated_cost_micros >= 0),
  reservation_id uuid references public.usage_reservations(id) on delete set null,
  idempotency_key text not null unique,
  reversal_of uuid references public.usage_ledger(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.workspace_credits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  credit_type text not null default 'generation_units',
  quantity numeric not null check (quantity <> 0),
  reason text not null,
  expires_at timestamptz,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.billing_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('mock', 'stripe')),
  provider_event_id text not null unique,
  event_type text not null,
  payload_hash text not null,
  payload jsonb not null default '{}',
  status text not null default 'received' check (status in ('received', 'processing', 'processed', 'ignored', 'failed')),
  attempts integer not null default 0,
  error_message text not null default '',
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table public.mock_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  plan_code text not null references public.billing_plans(code),
  token_hash text not null unique,
  requested_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'completed', 'expired', 'canceled')),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.model_cost_rates (
  model text primary key,
  input_cost_micros_per_million bigint not null default 0 check (input_cost_micros_per_million >= 0),
  output_cost_micros_per_million bigint not null default 0 check (output_cost_micros_per_million >= 0),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.cost_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  provider text not null,
  service text not null,
  model text not null default '',
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_micros bigint not null default 0,
  source_type text not null,
  source_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.feature_flags (
  key text primary key,
  description text not null default '',
  enabled boolean not null default false,
  rules jsonb not null default '{}',
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_commercial_controls (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  generation_paused boolean not null default false,
  generation_pause_reason text not null default '',
  billing_locked boolean not null default false,
  billing_lock_reason text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.data_export_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'expired')),
  export_format text not null default 'json' check (export_format in ('json')),
  payload jsonb,
  checksum text,
  error_message text not null default '',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.deletion_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('workspace', 'brand', 'user')),
  brand_id uuid references public.brands(id) on delete cascade,
  status text not null default 'scheduled' check (status in ('scheduled', 'canceled', 'ready', 'executing', 'completed', 'failed')),
  reason text not null default '',
  execute_after timestamptz not null,
  canceled_at timestamptz,
  completed_at timestamptz,
  error_message text not null default '',
  created_at timestamptz not null default now()
);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'support' check (role in ('support', 'billing', 'operations', 'super_admin')),
  created_at timestamptz not null default now()
);

create table public.support_access_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  support_user_id uuid not null references auth.users(id) on delete cascade,
  requested_reason text not null,
  permissions text[] not null default '{}',
  approved_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

insert into public.billing_plans(code, name, description, public, features, limits, monthly_amount, currency, sort_order)
values
  ('trial', 'Trial', 'Fourteen-day product evaluation.', false,
   '{"brand_memory":true,"team_approvals":true,"automatic_publishing":false,"client_review_links":false,"priority_support":false}',
   '{"brands":1,"members":2,"monthly_generation_units":60,"connected_accounts":1,"storage_bytes":536870912}', 0, 'usd', 0),
  ('solo', 'Solo', 'For one founder or small business.', true,
   '{"brand_memory":true,"team_approvals":true,"automatic_publishing":true,"client_review_links":false,"priority_support":false}',
   '{"brands":1,"members":2,"monthly_generation_units":300,"connected_accounts":1,"storage_bytes":2147483648}', 1900, 'usd', 10),
  ('growth', 'Growth', 'For active small-business marketing teams.', true,
   '{"brand_memory":true,"team_approvals":true,"automatic_publishing":true,"client_review_links":true,"priority_support":true}',
   '{"brands":3,"members":8,"monthly_generation_units":1200,"connected_accounts":5,"storage_bytes":10737418240}', 5900, 'usd', 20),
  ('agency', 'Agency', 'For consultants and multi-client teams.', true,
   '{"brand_memory":true,"team_approvals":true,"automatic_publishing":true,"client_review_links":true,"priority_support":true,"agency_reporting":true}',
   '{"brands":15,"members":30,"monthly_generation_units":5000,"connected_accounts":25,"storage_bytes":53687091200}', 14900, 'usd', 30)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  public = excluded.public,
  features = excluded.features,
  limits = excluded.limits,
  monthly_amount = excluded.monthly_amount,
  currency = excluded.currency,
  sort_order = excluded.sort_order,
  active = true;

insert into public.billing_prices(plan_code, provider, provider_price_id, amount)
values
  ('solo', 'mock', 'mock_solo_monthly', 1900),
  ('growth', 'mock', 'mock_growth_monthly', 5900),
  ('agency', 'mock', 'mock_agency_monthly', 14900)
on conflict (provider, provider_price_id) do nothing;

insert into public.model_cost_rates(model, input_cost_micros_per_million, output_cost_micros_per_million)
values ('default', 0, 0)
on conflict (model) do nothing;

create index subscriptions_status_idx on public.subscriptions(status, current_period_end);
create index entitlements_workspace_idx on public.entitlement_snapshots(workspace_id, version desc);
create index usage_ledger_workspace_period_idx on public.usage_ledger(workspace_id, period_key, usage_type);
create index usage_reservations_workspace_idx on public.usage_reservations(workspace_id, period_key, status, expires_at);
create index billing_events_status_idx on public.billing_events(status, received_at);
create index cost_events_workspace_idx on public.cost_events(workspace_id, created_at desc);
create index exports_workspace_idx on public.data_export_jobs(workspace_id, created_at desc);
create index deletion_requests_due_idx on public.deletion_requests(status, execute_after);

create trigger billing_plans_updated_at before update on public.billing_plans for each row execute function public.set_updated_at();
create trigger billing_customers_updated_at before update on public.billing_customers for each row execute function public.set_updated_at();
create trigger subscriptions_updated_at before update on public.subscriptions for each row execute function public.set_updated_at();
create trigger feature_flags_updated_at before update on public.feature_flags for each row execute function public.set_updated_at();

alter table public.billing_plans enable row level security;
alter table public.billing_prices enable row level security;
alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.entitlement_snapshots enable row level security;
alter table public.usage_reservations enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.workspace_credits enable row level security;
alter table public.billing_events enable row level security;
alter table public.mock_checkout_sessions enable row level security;
alter table public.model_cost_rates enable row level security;
alter table public.cost_events enable row level security;
alter table public.feature_flags enable row level security;
alter table public.workspace_commercial_controls enable row level security;
alter table public.data_export_jobs enable row level security;
alter table public.deletion_requests enable row level security;
alter table public.platform_admins enable row level security;
alter table public.support_access_sessions enable row level security;

grant select on public.billing_plans, public.billing_prices to anon, authenticated;
grant select on public.billing_customers, public.subscriptions, public.entitlement_snapshots,
  public.usage_reservations, public.usage_ledger, public.workspace_credits,
  public.workspace_commercial_controls, public.data_export_jobs, public.deletion_requests,
  public.cost_events to authenticated;
grant insert, update on public.data_export_jobs, public.deletion_requests to authenticated;
grant insert, update on public.workspace_commercial_controls to authenticated;
grant select on public.platform_admins to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;

create policy billing_plans_public_read on public.billing_plans for select using (public or auth.role() = 'authenticated');
create policy billing_prices_public_read on public.billing_prices for select using (active);
create policy billing_customers_workspace_read on public.billing_customers for select using (public.can_access_workspace(workspace_id));
create policy subscriptions_workspace_read on public.subscriptions for select using (public.can_access_workspace(workspace_id));
create policy entitlements_workspace_read on public.entitlement_snapshots for select using (public.can_access_workspace(workspace_id));
create policy usage_reservations_workspace_read on public.usage_reservations for select using (public.can_access_workspace(workspace_id));
create policy usage_ledger_workspace_read on public.usage_ledger for select using (public.can_access_workspace(workspace_id));
create policy credits_workspace_read on public.workspace_credits for select using (public.can_access_workspace(workspace_id));
create policy controls_workspace_read on public.workspace_commercial_controls for select using (public.can_access_workspace(workspace_id));
create policy controls_workspace_admin on public.workspace_commercial_controls for all
  using (public.can_admin_workspace(workspace_id)) with check (public.can_admin_workspace(workspace_id));
create policy exports_workspace_read on public.data_export_jobs for select using (public.can_access_workspace(workspace_id));
create policy exports_workspace_create on public.data_export_jobs for insert with check (requested_by = auth.uid() and public.can_access_workspace(workspace_id));
create policy deletions_workspace_read on public.deletion_requests for select using (public.can_access_workspace(workspace_id));
create policy deletions_workspace_create on public.deletion_requests for insert with check (requested_by = auth.uid() and public.can_admin_workspace(workspace_id));
create policy deletions_workspace_update on public.deletion_requests for update
  using (requested_by = auth.uid() or public.can_admin_workspace(workspace_id))
  with check (requested_by = auth.uid() or public.can_admin_workspace(workspace_id));
create policy cost_events_workspace_read on public.cost_events for select using (public.can_admin_workspace(workspace_id));
create policy platform_admin_self_read on public.platform_admins for select using (user_id = auth.uid());
create policy support_sessions_workspace_read on public.support_access_sessions for select
  using (public.can_admin_workspace(workspace_id) or support_user_id = auth.uid());
