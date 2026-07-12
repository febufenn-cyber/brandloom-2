-- Brandloom Phase 1 schema
create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 120),
  description text not null default '',
  category text not null default '',
  location text not null default '',
  website_url text not null default '',
  primary_language text not null default 'English',
  secondary_languages text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'archived')),
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.brand_voice_profiles (
  brand_id uuid primary key references public.brands(id) on delete cascade,
  tone_attributes jsonb not null default '{}',
  preferred_phrases text[] not null default '{}',
  prohibited_phrases text[] not null default '{}',
  style_rules jsonb not null default '{}',
  approved_claims text[] not null default '{}',
  prohibited_claims text[] not null default '{}',
  positive_examples text[] not null default '{}',
  negative_examples text[] not null default '{}',
  constitution jsonb,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 160),
  description text not null default '',
  customer_problem text not null default '',
  benefits text[] not null default '{}',
  approved_facts text[] not null default '{}',
  restricted_claims text[] not null default '{}',
  price text not null default '',
  purchase_url text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audiences (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 160),
  description text not null default '',
  pain_points text[] not null default '{}',
  motivations text[] not null default '{}',
  objections text[] not null default '{}',
  language_notes text not null default '',
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.content_examples (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  type text not null check (type in ('approved', 'rejected', 'competitor_inspiration', 'user_written')),
  content text not null,
  feedback text not null default '',
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

create table public.weekly_plans (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  week_start date not null,
  primary_goal text not null check (primary_goal in ('awareness', 'product', 'sales', 'education', 'trust', 'event', 'leads', 'reengagement')),
  secondary_goal text not null default '',
  campaign_context text not null default '',
  featured_product_ids uuid[] not null default '{}',
  important_dates jsonb not null default '[]',
  posting_days integer not null default 7 check (posting_days between 1 and 7),
  language_mode text not null default 'English',
  strategy jsonb,
  status text not null default 'setup' check (status in ('setup', 'planned', 'drafted', 'approved', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, week_start)
);

create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  weekly_plan_id uuid not null references public.weekly_plans(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  scheduled_date date not null,
  platform text not null default 'instagram' check (platform = 'instagram'),
  format text not null check (format in ('static', 'carousel', 'reel', 'story')),
  pillar text not null default '',
  objective text not null default '',
  title text not null default '',
  hook text not null default '',
  caption text not null default '',
  cta text not null default '',
  visual_brief text not null default '',
  hashtags text[] not null default '{}',
  facts_used text[] not null default '{}',
  quality_flags jsonb not null default '[]',
  generation_metadata jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.content_versions (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  source text not null check (source in ('generation', 'regeneration', 'user_edit')),
  snapshot jsonb not null,
  previous_snapshot jsonb,
  created_at timestamptz not null default now(),
  unique (content_item_id, version_number)
);

create table public.feedback_events (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  feedback_type text not null,
  comment text not null default '',
  content_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.generation_runs (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  weekly_plan_id uuid references public.weekly_plans(id) on delete cascade,
  task_type text not null,
  model text not null,
  prompt_version text not null,
  input_snapshot jsonb not null default '{}',
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  latency_ms integer not null default 0,
  status text not null check (status in ('completed', 'failed')),
  error_message text not null default '',
  created_at timestamptz not null default now()
);

create index brands_workspace_idx on public.brands(workspace_id);
create index products_brand_idx on public.products(brand_id);
create index audiences_brand_idx on public.audiences(brand_id);
create index weekly_plans_brand_week_idx on public.weekly_plans(brand_id, week_start desc);
create index content_items_plan_date_idx on public.content_items(weekly_plan_id, scheduled_date);
create index feedback_brand_idx on public.feedback_events(brand_id, created_at desc);
create index generation_runs_brand_idx on public.generation_runs(brand_id, created_at desc);

create unique index one_primary_audience_per_brand
on public.audiences(brand_id)
where is_primary = true;

create trigger workspaces_updated_at before update on public.workspaces for each row execute function public.set_updated_at();
create trigger brands_updated_at before update on public.brands for each row execute function public.set_updated_at();
create trigger voice_updated_at before update on public.brand_voice_profiles for each row execute function public.set_updated_at();
create trigger products_updated_at before update on public.products for each row execute function public.set_updated_at();
create trigger audiences_updated_at before update on public.audiences for each row execute function public.set_updated_at();
create trigger weekly_plans_updated_at before update on public.weekly_plans for each row execute function public.set_updated_at();
create trigger content_items_updated_at before update on public.content_items for each row execute function public.set_updated_at();

create or replace function public.owns_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.workspaces
    where id = p_workspace_id and owner_id = auth.uid()
  );
$$;

create or replace function public.owns_brand(p_brand_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.brands b
    join public.workspaces w on w.id = b.workspace_id
    where b.id = p_brand_id and w.owner_id = auth.uid()
  );
$$;

create or replace function public.owns_plan(p_plan_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.weekly_plans p
    where p.id = p_plan_id and public.owns_brand(p.brand_id)
  );
$$;

create or replace function public.owns_content(p_content_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.content_items c
    where c.id = p_content_id and public.owns_brand(c.brand_id)
  );
$$;

create or replace function public.create_brand_workspace(p_brand jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_brand_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  insert into public.workspaces(owner_id, name)
  values (v_user_id, coalesce(nullif(p_brand->>'name', ''), 'My Brand') || ' Workspace')
  returning id into v_workspace_id;

  insert into public.brands(
    workspace_id, name, description, category, location, website_url,
    primary_language, secondary_languages
  ) values (
    v_workspace_id,
    p_brand->>'name',
    coalesce(p_brand->>'description', ''),
    coalesce(p_brand->>'category', ''),
    coalesce(p_brand->>'location', ''),
    coalesce(p_brand->>'website_url', ''),
    coalesce(nullif(p_brand->>'primary_language', ''), 'English'),
    array(select jsonb_array_elements_text(coalesce(p_brand->'secondary_languages', '[]'::jsonb)))
  ) returning id into v_brand_id;

  insert into public.brand_voice_profiles(brand_id) values (v_brand_id);
  return v_brand_id;
end;
$$;

grant execute on function public.create_brand_workspace(jsonb) to authenticated;
grant execute on function public.owns_workspace(uuid) to authenticated;
grant execute on function public.owns_brand(uuid) to authenticated;
grant execute on function public.owns_plan(uuid) to authenticated;
grant execute on function public.owns_content(uuid) to authenticated;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

alter table public.workspaces enable row level security;
alter table public.brands enable row level security;
alter table public.brand_voice_profiles enable row level security;
alter table public.products enable row level security;
alter table public.audiences enable row level security;
alter table public.content_examples enable row level security;
alter table public.weekly_plans enable row level security;
alter table public.content_items enable row level security;
alter table public.content_versions enable row level security;
alter table public.feedback_events enable row level security;
alter table public.generation_runs enable row level security;

create policy workspace_owner_all on public.workspaces
for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy brand_owner_all on public.brands
for all using (public.owns_workspace(workspace_id)) with check (public.owns_workspace(workspace_id));

create policy voice_owner_all on public.brand_voice_profiles
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy product_owner_all on public.products
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy audience_owner_all on public.audiences
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy example_owner_all on public.content_examples
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy plan_owner_all on public.weekly_plans
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy content_owner_all on public.content_items
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy version_owner_all on public.content_versions
for all using (public.owns_content(content_item_id)) with check (public.owns_content(content_item_id));

create policy feedback_owner_all on public.feedback_events
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));

create policy generation_owner_all on public.generation_runs
for all using (public.owns_brand(brand_id)) with check (public.owns_brand(brand_id));
