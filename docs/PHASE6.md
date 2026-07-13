# Brandloom Phase 6 — Intelligent Optimization

Phase 6 turns measured outcomes into cautious, reversible strategy improvements. It does not create an autonomous marketing system that changes campaigns, posts, publishing, or spend without approval.

## Product promise

Brandloom can ingest performance observations, explain what appears to be working, detect repetition and fatigue, propose controlled experiments, and convert explicitly approved recommendations into scoped temporary Brand Memory.

The operating sequence is:

```text
Performance snapshot
→ normalized rates and features
→ review with sample and attribution limits
→ proposed recommendation
→ human decision
→ temporary scoped memory or controlled experiment
→ expiry or re-evaluation
```

Raw likes, reach, or clicks never enter prompts directly.

## Evidence hierarchy

1. **Manual or provider snapshot** — an append-only observation.
2. **Segment comparison** — correlation only; attribution confidence is capped at medium.
3. **Fatigue signal** — repetition plus distribution and performance context.
4. **Controlled experiment** — explicit variant assignment, equal measurement windows, minimum sample per variant.
5. **Approved recommendation** — creates a temporary or experiment-scoped `strategic_suggestion` memory.

A recommendation stores:

- source review or experiment
- statement and rationale
- proposed action
- scope
- sample size
- modeled confidence
- attribution confidence
- evidence summary
- expiry
- decision history

## Performance data

`content_performance_snapshots` is append-only during normal operation. Every row belongs to one content item, brand, workspace, source, and observation window. Optional `source_event_id` values provide idempotency for provider and API imports.

Supported normalized metrics include:

- impressions and reach
- likes, comments, saves, and shares
- clicks and profile visits
- follows
- video views and watch time
- provider-specific custom metrics

The analysis service selects the latest snapshot for each content item so cumulative provider snapshots are not accidentally summed.

## Optimization scoring

The deterministic engine derives rates and a weighted performance score. Saves, shares, clicks, and follows receive more weight than passive likes. The score is for internal comparison only; it is not presented as universal business value or causal truth.

Observational confidence is capped below causal confidence. A large organic sample can support a useful test recommendation, but it cannot claim that a hook, format, or posting time caused the result.

## Fatigue detection

Fatigue signals inspect repeated dimensions such as:

- hook type
- CTA type
- pillar
- format
- product

A signal combines frequency concentration and relative performance. It creates a warning and proposed cooling action, not an automatic prohibition.

## Controlled experiments

Experiments require:

- at least two named variants
- one explicit variant assignment per content item
- a primary metric
- minimum sample size per variant
- an attribution window
- human activation
- human evaluation or completion

Underpowered experiments remain `insufficient`. Small or weak differences remain `inconclusive`. A winner recommendation is created only after the configured minimum sample exists for every variant and the modeled effect clears the confidence threshold.

The winner recommendation still requires approval before becoming Brand Memory.

## Opportunity signals

Users may record time-bound opportunities from calendars, customer feedback, research, performance, products, or seasonal events. Relevance, confidence, and expiry remain visible.

Converting an opportunity creates a **draft campaign** with normal fact, asset, approval, and publishing requirements. It does not launch content automatically.

## Recommendation decisions

`approve_optimization_recommendation` is the only path that turns an optimization recommendation into active generation context. It:

1. verifies reviewer permission
2. verifies the recommendation is current
3. creates a temporary or experiment-scoped `memory_items` record
4. records a memory confirmation
5. records an immutable optimization decision
6. records an application log

Reject, pause, reactivate, expire, and supersede decisions update the linked memory consistently.

## Commercial boundary

The optimization dashboard is visible across plans. In production billing mode, review generation and controlled experiments require Growth or Agency. Mock billing mode keeps the complete flow testable.

The Phase 6 migration projects the new feature flags into existing latest entitlement snapshots without mutating historical entitlement records.

## API surface

```text
GET  /api/v6/brands/:brandId/dashboard
POST /api/v6/brands/:brandId/performance/import
POST /api/v6/brands/:brandId/reviews

GET  /api/v6/recommendations/:recommendationId/evidence
POST /api/v6/recommendations/:recommendationId/approve
POST /api/v6/recommendations/:recommendationId/decision

POST /api/v6/brands/:brandId/experiments
POST /api/v6/experiments/:experimentId/activate
POST /api/v6/experiments/:experimentId/assignments
POST /api/v6/experiments/:experimentId/evaluate

POST /api/v6/brands/:brandId/opportunities
POST /api/v6/opportunities/:opportunityId/decision
POST /api/v6/opportunities/:opportunityId/convert
POST /api/v6/fatigue/:signalId/status
```

## Migrations

Apply all migrations in lexical order through:

```text
0011_phase6_intelligent_optimization.sql
0012_phase6_integrity.sql
0013_phase6_policy_corrections.sql
```

Test on a disposable Supabase branch before production. Verify:

- metric import idempotency
- snapshot immutability
- content/brand/workspace scope validation
- reviewer and editor policies
- recommendation approval RPCs
- linked memory pause and expiry
- experiment variant validation
- entitlement projection
- workspace deletion cascades

## Acceptance criteria

- Duplicate source events do not create duplicate performance observations.
- A snapshot cannot be edited after insertion.
- Reviews show sample size and attribution confidence.
- Organic correlations never receive high attribution confidence.
- Underpowered experiments cannot select a winner.
- Recommendations never enter prompts without approval.
- Approved recommendations are temporary, scoped, reversible, and auditable.
- Expired recommendations also expire linked memories.
- Opportunity conversion creates only a draft campaign.
- No automatic publishing, ad spend, campaign launch, or cross-customer learning is introduced.

## Deliberate exclusions

Phase 6 does not include:

- autonomous posting
- autonomous ad buying or budget allocation
- cross-customer benchmark training
- follower-growth bots
- social inbox automation
- causal claims from ordinary engagement data
- hidden permanent memory promotion
- employee productivity scoring

The product is an evidence-aware decision system, not an unsupervised marketing agent.
