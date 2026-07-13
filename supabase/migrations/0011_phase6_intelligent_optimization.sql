-- Brandloom Phase 6: evidence-aware performance learning and human-approved optimization

alter table public.brand_experiments
  add column if not exists name text not null default '',
  add column if not exists experiment_type text not null default 'content' check (experiment_type in ('content', 'timing', 'format', 'audience', 'offer', 'workflow')),
  add column if not exists primary_metric text not null default 'engagement_rate',
  add column if not exists guardrail_metrics text[] not null default '{}',
  add column if not exists min_sample_size integer not null default 10 check (min_sample_size between 2 and 10000),
  add column if not exists confidence_threshold numeric(4,3) not null default 0.700 check (confidence_threshold between 0 and 1),
  add column if not exists attribution_window_days integer not null default 7 check (attribution_window_days between 1 and 90),
  add column if not exists design jsonb not null default '{}',
  add column if not exists decision text not null default 'undecided' check (decision in ('undecided', 'winner', 'inconclusive', 'stopped')),
  add column if not exists decision_reason text not null default '',
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists completed_at timestamptz;

create table public.metric_import_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  source text not null check (source in ('manual', 'csv', 'meta', 'api', 'system')),
  external_batch_id text,
  period_start date,
  period_end date,
  status text not null default 'processing' check (status in ('processing', 'completed', 'partial', 'failed')),
  rows_received integer not null default 0 check (rows_received >= 0),
  rows_accepted integer not null default 0 check (rows_accepted >= 0),
  rows_rejected integer not null default 0 check (rows_rejected >= 0),
  rejection_summary jsonb not null default '[]',
  initiated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (period_end is null or period_start is null or period_end >= period_start)
);

create unique index metric_import_external_batch_idx
  on public.metric_import_batches(brand_id, source, external_batch_id)
  where external_batch_id is not null;

create table public.content_performance_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  publication_job_id uuid references public.publication_jobs(id) on delete set null,
  platform_account_id uuid references public.platform_accounts(id) on delete set null,
  import_batch_id uuid references public.metric_import_batches(id) on delete set null,
  source text not null check (source in ('manual', 'csv', 'meta', 'api', 'system')),
  source_event_id text,
  provider_media_id text not null default '',
  window_start timestamptz not null,
  window_end timestamptz not null,
  observed_at timestamptz not null default now(),
  impressions bigint not null default 0 check (impressions >= 0),
  reach bigint not null default 0 check (reach >= 0),
  likes bigint not null default 0 check (likes >= 0),
  comments bigint not null default 0 check (comments >= 0),
  saves bigint not null default 0 check (saves >= 0),
  shares bigint not null default 0 check (shares >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  profile_visits bigint not null default 0 check (profile_visits >= 0),
  follows bigint not null default 0 check (follows >= 0),
  video_views bigint not null default 0 check (video_views >= 0),
  watch_time_seconds numeric not null default 0 check (watch_time_seconds >= 0),
  custom_metrics jsonb not null default '{}',
  is_final boolean not null default false,
  created_at timestamptz not null default now(),
  check (window_end >= window_start)
);

create unique index performance_source_event_idx
  on public.content_performance_snapshots(brand_id, source, source_event_id)
  where source_event_id is not null;
create index performance_content_observed_idx on public.content_performance_snapshots(content_item_id, observed_at desc);
create index performance_brand_window_idx on public.content_performance_snapshots(brand_id, window_end desc);

create table public.optimization_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  window_start date not null,
  window_end date not null,
  status text not null default 'ready' check (status in ('ready', 'reviewed', 'archived')),
  summary text not null default '',
  baseline jsonb not null default '{}',
  performance jsonb not null default '{}',
  diagnostics jsonb not null default '{}',
  generated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (window_end >= window_start)
);

create table public.optimization_recommendations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  review_id uuid references public.optimization_reviews(id) on delete set null,
  experiment_id uuid references public.brand_experiments(id) on delete set null,
  recommendation_type text not null check (recommendation_type in (
    'content_mix', 'hook', 'cta', 'format', 'timing', 'audience', 'product',
    'campaign', 'fatigue', 'experiment', 'measurement'
  )),
  statement text not null check (char_length(statement) between 3 and 2000),
  rationale text not null default '',
  proposed_action jsonb not null default '{}',
  scope jsonb not null default '{}',
  confidence numeric(4,3) not null default 0.500 check (confidence between 0 and 1),
  attribution_confidence text not null default 'low' check (attribution_confidence in ('low', 'medium', 'high')),
  sample_size integer not null default 0 check (sample_size >= 0),
  evidence_summary jsonb not null default '{}',
  status text not null default 'proposed' check (status in (
    'proposed', 'approved', 'active', 'rejected', 'paused', 'expired', 'superseded'
  )),
  valid_until date,
  memory_item_id uuid references public.memory_items(id) on delete set null,
  created_by text not null default 'system' check (created_by in ('system', 'user', 'experiment')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recommendation_evidence (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  recommendation_id uuid not null references public.optimization_recommendations(id) on delete cascade,
  content_item_id uuid references public.content_items(id) on delete set null,
  performance_snapshot_id uuid references public.content_performance_snapshots(id) on delete set null,
  experiment_id uuid references public.brand_experiments(id) on delete set null,
  evidence_type text not null check (evidence_type in ('metric', 'feature', 'comparison', 'fatigue', 'opportunity', 'user_note', 'experiment')),
  payload jsonb not null default '{}',
  weight numeric(4,3) not null default 0.100 check (weight between 0 and 1),
  created_at timestamptz not null default now()
);

create table public.optimization_decisions (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  recommendation_id uuid not null references public.optimization_recommendations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  decision text not null check (decision in ('approve', 'reject', 'pause', 'reactivate', 'expire', 'supersede')),
  note text not null default '',
  previous_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  experiment_id uuid not null references public.brand_experiments(id) on delete cascade,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  variant_key text not null,
  status text not null default 'assigned' check (status in ('assigned', 'published', 'measured', 'excluded')),
  exclusion_reason text not null default '',
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  measured_at timestamptz,
  unique (experiment_id, content_item_id)
);

create table public.fatigue_signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  review_id uuid references public.optimization_reviews(id) on delete set null,
  signal_type text not null check (signal_type in ('hook', 'cta', 'pillar', 'format', 'product', 'audience')),
  signal_key text not null,
  score numeric(5,4) not null check (score between 0 and 1),
  recent_count integer not null default 0 check (recent_count >= 0),
  baseline_count integer not null default 0 check (baseline_count >= 0),
  performance_change numeric not null default 0,
  evidence jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'expired')),
  detected_at timestamptz not null default now(),
  expires_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index fatigue_open_signal_idx on public.fatigue_signals(brand_id, signal_type, signal_key)
  where status in ('open', 'acknowledged');

create table public.opportunity_signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  source text not null check (source in ('manual', 'calendar', 'performance', 'seasonal', 'customer', 'research')),
  signal_type text not null check (signal_type in ('event', 'trend', 'product', 'audience', 'campaign', 'retention')),
  title text not null check (char_length(title) between 3 and 240),
  description text not null default '',
  source_reference text not null default '',
  relevance_score numeric(4,3) not null default 0.500 check (relevance_score between 0 and 1),
  confidence numeric(4,3) not null default 0.500 check (confidence between 0 and 1),
  valid_from date,
  valid_until date,
  status text not null default 'new' check (status in ('new', 'accepted', 'rejected', 'expired', 'converted')),
  converted_campaign_id uuid references public.campaigns(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until is null or valid_from is null or valid_until >= valid_from)
);

create table public.optimization_application_logs (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  recommendation_id uuid not null references public.optimization_recommendations(id) on delete cascade,
  memory_item_id uuid references public.memory_items(id) on delete set null,
  application_type text not null check (application_type in ('memory', 'experiment', 'campaign', 'task')),
  target_id uuid,
  payload jsonb not null default '{}',
  applied_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index optimization_reviews_brand_idx on public.optimization_reviews(brand_id, created_at desc);
create index optimization_recommendations_brand_idx on public.optimization_recommendations(brand_id, status, confidence desc);
create index recommendation_evidence_rec_idx on public.recommendation_evidence(recommendation_id, created_at);
create index optimization_decisions_rec_idx on public.optimization_decisions(recommendation_id, created_at desc);
create index experiment_assignments_experiment_idx on public.experiment_assignments(experiment_id, variant_key, status);
create index fatigue_signals_brand_idx on public.fatigue_signals(brand_id, status, score desc);
create index opportunity_signals_brand_idx on public.opportunity_signals(brand_id, status, valid_until);

create trigger optimization_reviews_updated_at before update on public.optimization_reviews for each row execute function public.set_updated_at();
create trigger optimization_recommendations_updated_at before update on public.optimization_recommendations for each row execute function public.set_updated_at();
create trigger fatigue_signals_updated_at before update on public.fatigue_signals for each row execute function public.set_updated_at();
create trigger opportunity_signals_updated_at before update on public.opportunity_signals for each row execute function public.set_updated_at();

alter table public.metric_import_batches enable row level security;
alter table public.content_performance_snapshots enable row level security;
alter table public.optimization_reviews enable row level security;
alter table public.optimization_recommendations enable row level security;
alter table public.recommendation_evidence enable row level security;
alter table public.optimization_decisions enable row level security;
alter table public.experiment_assignments enable row level security;
alter table public.fatigue_signals enable row level security;
alter table public.opportunity_signals enable row level security;
alter table public.optimization_application_logs enable row level security;

grant select, insert, update on public.metric_import_batches to authenticated;
grant select, insert on public.content_performance_snapshots to authenticated;
grant select, insert, update on public.optimization_reviews to authenticated;
grant select, insert, update on public.optimization_recommendations to authenticated;
grant select, insert on public.recommendation_evidence to authenticated;
grant select, insert on public.optimization_decisions to authenticated;
grant select, insert, update on public.experiment_assignments to authenticated;
grant select, insert, update on public.fatigue_signals to authenticated;
grant select, insert, update on public.opportunity_signals to authenticated;
grant select, insert on public.optimization_application_logs to authenticated;
grant select, insert, update on public.brand_experiments to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;

create policy metric_batches_read on public.metric_import_batches for select using (public.can_access_brand(brand_id));
create policy metric_batches_write on public.metric_import_batches for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy performance_read on public.content_performance_snapshots for select using (public.can_access_brand(brand_id));
create policy performance_insert on public.content_performance_snapshots for insert with check (public.can_edit_brand(brand_id));
create policy optimization_reviews_read on public.optimization_reviews for select using (public.can_access_brand(brand_id));
create policy optimization_reviews_write on public.optimization_reviews for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy recommendations_read on public.optimization_recommendations for select using (public.can_access_brand(brand_id));
create policy recommendations_write on public.optimization_recommendations for all using (public.can_review_brand(brand_id)) with check (public.can_review_brand(brand_id));
create policy recommendation_evidence_read on public.recommendation_evidence for select using (public.can_access_brand(brand_id));
create policy recommendation_evidence_insert on public.recommendation_evidence for insert with check (public.can_edit_brand(brand_id));
create policy optimization_decisions_read on public.optimization_decisions for select using (public.can_access_brand(brand_id));
create policy optimization_decisions_insert on public.optimization_decisions for insert with check (user_id = auth.uid() and public.can_review_brand(brand_id));
create policy experiment_assignments_read on public.experiment_assignments for select using (public.can_access_brand(brand_id));
create policy experiment_assignments_write on public.experiment_assignments for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy fatigue_signals_read on public.fatigue_signals for select using (public.can_access_brand(brand_id));
create policy fatigue_signals_write on public.fatigue_signals for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy opportunity_signals_read on public.opportunity_signals for select using (public.can_access_brand(brand_id));
create policy opportunity_signals_write on public.opportunity_signals for all using (public.can_edit_brand(brand_id)) with check (public.can_edit_brand(brand_id));
create policy optimization_applications_read on public.optimization_application_logs for select using (public.can_access_brand(brand_id));
create policy optimization_applications_insert on public.optimization_application_logs for insert with check (public.can_review_brand(brand_id));
create policy experiments_member_read on public.brand_experiments for select using (public.can_access_brand(brand_id));
create policy experiments_member_write on public.brand_experiments for all using (public.can_review_brand(brand_id)) with check (public.can_review_brand(brand_id));

update public.billing_plans
set features = features || jsonb_build_object(
  'optimization_dashboard', true,
  'intelligent_optimization', code in ('growth', 'agency'),
  'controlled_experiments', code in ('growth', 'agency')
);

with latest as (
  select distinct on (e.workspace_id) e.*
  from public.entitlement_snapshots e
  order by e.workspace_id, e.version desc
), projected as (
  select l.*, p.features as next_features
  from latest l join public.billing_plans p on p.code = l.plan_code
  where not (l.features ? 'optimization_dashboard')
)
insert into public.entitlement_snapshots(
  workspace_id, subscription_id, plan_code, subscription_status, access_state,
  features, limits, effective_from, effective_until, version
)
select workspace_id, subscription_id, plan_code, subscription_status, access_state,
  next_features, limits, now(), effective_until, version + 1
from projected;
