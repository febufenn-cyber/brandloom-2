-- Brandloom Phase 2: evidence-backed, scoped and reversible brand memory

create table public.memory_items (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  memory_type text not null check (memory_type in (
    'voice_preference', 'selling_style', 'factual_rule', 'compliance_restriction',
    'product_lesson', 'audience_lesson', 'campaign_lesson', 'temporary_context',
    'repetition_warning', 'strategic_suggestion'
  )),
  statement text not null check (char_length(statement) between 3 and 2000),
  structured_value jsonb not null default '{}',
  scope jsonb not null default '{}',
  durability text not null default 'stable' check (durability in ('permanent', 'stable', 'temporary', 'experiment')),
  confidence numeric(4,3) not null default 0.500 check (confidence between 0 and 1),
  status text not null default 'candidate' check (status in (
    'observation', 'candidate', 'suggested', 'confirmed', 'active', 'paused',
    'contradicted', 'superseded', 'expired', 'rejected'
  )),
  origin text not null default 'edit_analysis' check (origin in ('explicit', 'edit_analysis', 'weekly_review', 'system', 'import')),
  evidence_count integer not null default 0 check (evidence_count >= 0),
  valid_from date,
  valid_until date,
  last_observed_at timestamptz not null default now(),
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  supersedes_memory_id uuid references public.memory_items(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until is null or valid_from is null or valid_until >= valid_from)
);

create table public.memory_evidence (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  memory_item_id uuid not null references public.memory_items(id) on delete cascade,
  source_type text not null check (source_type in ('explicit_instruction', 'content_edit', 'feedback', 'weekly_review', 'contradiction', 'experiment')),
  source_id uuid,
  before_text text not null default '',
  after_text text not null default '',
  analysis jsonb not null default '{}',
  weight numeric(4,3) not null default 0.100 check (weight between 0 and 1),
  created_at timestamptz not null default now()
);

create table public.edit_analyses (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  content_version_id uuid references public.content_versions(id) on delete set null,
  meaningful boolean not null default false,
  summary text not null default '',
  removed_patterns text[] not null default '{}',
  added_concepts text[] not null default '{}',
  tone_changes jsonb not null default '{}',
  candidate_memories jsonb not null default '[]',
  model text not null default '',
  prompt_version text not null default '',
  created_at timestamptz not null default now()
);

create table public.content_features (
  content_item_id uuid primary key references public.content_items(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  hook_type text not null default '',
  emotional_angle text not null default '',
  benefits_used text[] not null default '{}',
  objections_addressed text[] not null default '{}',
  cta_type text not null default '',
  language_mode text not null default '',
  semantic_fingerprint jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table public.memory_confirmations (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  memory_item_id uuid not null references public.memory_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  decision text not null check (decision in ('confirm', 'reject', 'pause', 'reactivate', 'change_scope')),
  note text not null default '',
  previous_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.weekly_learning_reviews (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  weekly_plan_id uuid not null references public.weekly_plans(id) on delete cascade,
  summary text not null default '',
  observations jsonb not null default '[]',
  candidate_memories jsonb not null default '[]',
  retire_suggestions jsonb not null default '[]',
  experiment_suggestions jsonb not null default '[]',
  status text not null default 'ready' check (status in ('ready', 'reviewed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (weekly_plan_id)
);

create table public.brand_experiments (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  hypothesis text not null,
  variants jsonb not null default '[]',
  success_metric text not null default 'accepted_without_major_rewrite',
  start_date date,
  end_date date,
  result jsonb not null default '{}',
  status text not null default 'proposed' check (status in ('proposed', 'active', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memory_retrieval_logs (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  generation_run_id uuid references public.generation_runs(id) on delete cascade,
  task_type text not null,
  memory_item_ids uuid[] not null default '{}',
  retrieval_reason text not null default '',
  scores jsonb not null default '{}',
  context_size integer not null default 0,
  created_at timestamptz not null default now()
);

create index memory_items_brand_status_idx on public.memory_items(brand_id, status, confidence desc);
create index memory_items_validity_idx on public.memory_items(brand_id, valid_until) where valid_until is not null;
create index memory_evidence_memory_idx on public.memory_evidence(memory_item_id, created_at desc);
create index edit_analyses_content_idx on public.edit_analyses(content_item_id, created_at desc);
create index learning_reviews_brand_idx on public.weekly_learning_reviews(brand_id, created_at desc);
create index experiments_brand_idx on public.brand_experiments(brand_id, status);
create index retrieval_logs_run_idx on public.memory_retrieval_logs(generation_run_id);

create trigger memory_items_updated_at before update on public.memory_items for each row execute function public.set_updated_at();
create trigger learning_reviews_updated_at before update on public.weekly_learning_reviews for each row execute function public.set_updated_at();
create trigger experiments_updated_at before update on public.brand_experiments for each row execute function public.set_updated_at();

alter table public.memory_items enable row level security;
alter table public.memory_evidence enable row level security;
alter table public.edit_analyses enable row level security;
alter table public.content_features enable row level security;
alter table public.memory_confirmations enable row level security;
alter table public.weekly_learning_reviews enable row level security;
alter table public.brand_experiments enable row level security;
alter table public.memory_retrieval_logs enable row level security;

grant select, insert, update, delete on public.memory_items to authenticated;
grant select, insert, update, delete on public.memory_evidence to authenticated;
grant select, insert, update, delete on public.edit_analyses to authenticated;
grant select, insert, update, delete on public.content_features to authenticated;
grant select, insert, update, delete on public.memory_confirmations to authenticated;
grant select, insert, update, delete on public.weekly_learning_reviews to authenticated;
grant select, insert, update, delete on public.brand_experiments to authenticated;
grant select, insert, update, delete on public.memory_retrieval_logs to authenticated;

create policy memory_item_owner_all on public.memory_items
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy memory_evidence_owner_all on public.memory_evidence
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy edit_analysis_owner_all on public.edit_analyses
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy content_features_owner_all on public.content_features
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy memory_confirmation_owner_all on public.memory_confirmations
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy learning_review_owner_all on public.weekly_learning_reviews
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy experiment_owner_all on public.brand_experiments
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy retrieval_log_owner_all on public.memory_retrieval_logs
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));
