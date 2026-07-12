# Brandloom Phase 1 product contract

## Promise

A small business defines its brand once, selects the objective for a week, and receives a seven-day Instagram plan written within its approved voice and factual boundaries. Every post remains a draft until a human approves it.

## Included

- Supabase email/password authentication
- Workspace and brand isolation through RLS
- Guided brand profile and voice calibration
- Product facts and restricted claims
- Primary and secondary audience cards
- Brand Readiness score
- AI-generated Brand Constitution
- Weekly campaign setup and strategy generation
- Structured Instagram post generation
- Deterministic checks for banned phrases, generic AI clichés, unsupported facts, duplicate hooks and weak specificity
- Field-level regeneration
- Editing, approval and rejection states
- Version history and feedback capture
- Generation provenance, latency and token counts

## Explicitly excluded

- Social publishing and OAuth
- Billing
- Social analytics
- Autonomous browsing
- Image or video generation
- Multi-platform support
- Agency hierarchies
- Mobile apps

## Controlled generation pipeline

1. The user provides factual brand, product and audience information.
2. Brandloom calculates missing signal and displays it.
3. The strategist produces a Brand Constitution using only supplied facts.
4. The user reviews the Constitution.
5. The strategist creates a weekly narrative and calendar.
6. The user approves the plan.
7. The writer drafts structured posts.
8. Deterministic validators flag claims and language risks.
9. The user edits or selectively regenerates fields.
10. Edits, versions and feedback are retained as future learning signals.

## Primary success metric

`accepted_without_major_rewrite / generated_posts`

Suggested pilot thresholds:

- Setup completed in under 15 minutes
- At least 4 of 7 posts accepted with minor edits
- No unsupported factual claim is approved without an explicit warning
- At least 30% of pilot brands create a second weekly plan

## API surface

- `GET /health`
- `GET /api/bootstrap`
- `POST /api/brands`
- `GET|PATCH /api/brands/:brandId`
- `PUT /api/brands/:brandId/voice-profile`
- `GET /api/brands/:brandId/readiness`
- `POST /api/brands/:brandId/products`
- `PATCH|DELETE /api/products/:productId`
- `POST /api/brands/:brandId/audiences`
- `PATCH|DELETE /api/audiences/:audienceId`
- `POST /api/brands/:brandId/constitution/generate`
- `GET /api/brands/:brandId/weekly-plans`
- `POST /api/weekly-plans`
- `GET /api/weekly-plans/:planId`
- `POST /api/weekly-plans/:planId/strategy/generate`
- `POST /api/weekly-plans/:planId/posts/generate`
- `PATCH /api/content-items/:contentId`
- `POST /api/content-items/:contentId/regenerate`
- `POST /api/content-items/:contentId/feedback`

## Safety boundaries

- Model calls happen only in the Worker.
- The browser never receives the model API key.
- All API data access uses the signed-in user's Supabase JWT and RLS.
- Facts are supplied as structured arrays and returned by the model as `facts_used`.
- Unsupported facts become error-severity quality flags.
- Drafts are never published automatically.
- Website ingestion is deliberately absent from Phase 1; imported web text must later be treated as untrusted and confirmed by the user.
