# Brandloom

> Tell Brandloom about your business once. Each week, choose what you want to achieve and receive a seven-day Instagram content plan written in your brand's voice—ready to review, edit and approve.

Brandloom Phase 1 is now a runnable, human-approved brand intelligence and weekly content studio. It deliberately avoids automatic publishing, billing and broad multi-platform complexity until the core quality loop is proven.

## What is implemented

- Brand onboarding and readiness scoring
- Product library with approved facts and forbidden claims
- Audience cards with pains, motives and objections
- Voice calibration through contrasts, preferred language and positive/negative examples
- AI-generated Brand Constitution
- Weekly campaign strategist
- Structured Instagram drafts: hook, caption, CTA, format, visual brief and hashtags
- Quality flags for prohibited language, AI clichés, unsupported facts, repeated hooks and weak specificity
- Selective field regeneration
- Human editing and approval
- Version history, feedback events and generation provenance
- Supabase RLS tenant isolation

See [`docs/PHASE1.md`](docs/PHASE1.md) for the product boundary and API contract.

## Stack

- **Web:** React + Vite + TypeScript
- **API:** Cloudflare Workers + Hono
- **Data/Auth:** Supabase Postgres + Auth + RLS
- **Generation:** Anthropic API, with the model ID supplied through `ANTHROPIC_MODEL`
- **Validation:** Zod plus deterministic quality rules

## Repository layout

```text
apps/
  api/        Cloudflare Worker and generation pipeline
  web/        React brand studio
supabase/
  migrations/ Phase 1 database and RLS policies
docs/
  PHASE1.md   Product contract and safety boundaries
```

## Local setup

### 1. Install

```bash
corepack enable
pnpm install
```

### 2. Create Supabase schema

Create a Supabase project, then run:

```bash
supabase db push
```

Or paste `supabase/migrations/0001_phase1.sql` into the Supabase SQL editor.

Enable email/password authentication in Supabase. For local testing, either disable email confirmation or confirm the test account.

### 3. Configure the Worker

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars
```

Fill in:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `WEB_ORIGIN`

The model ID is configuration rather than hard-coded so the project does not silently depend on an obsolete model name.

### 4. Configure the web app

```bash
cp apps/web/.env.example apps/web/.env
```

Fill in the Supabase URL, anon key and local Worker URL.

### 5. Run

```bash
pnpm dev
```

- Web: `http://localhost:5173`
- API: normally `http://localhost:8787`

## Verification

```bash
pnpm check
```

This runs TypeScript checks, unit tests and production builds for both applications.

## Deployment

Deploy the API:

```bash
cd apps/api
pnpm wrangler secret put ANTHROPIC_API_KEY
pnpm deploy
```

Set the remaining Worker variables in `wrangler.toml` or the Cloudflare dashboard. Deploy `apps/web/dist` to Cloudflare Pages or another static host and point `VITE_API_URL` to the Worker.

## Product rule

Generation is not the moat. The retained record of what a brand approved, rejected and rewrote is the beginning of the moat. Phase 1 captures that evidence without pretending the system is autonomous.
