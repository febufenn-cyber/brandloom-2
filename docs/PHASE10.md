# Brandloom Phase 10 — Public Launch and Growth Operations

Phase 10 completes the mandatory product roadmap. It converts production readiness and closed-beta evidence into a controlled public-access decision, then measures acquisition and activation using bounded, privacy-safe events. It does not deploy, open registration, send lifecycle email or spend money automatically.

## Public launch promise

Public registration may open only when one locked production transaction confirms:

1. A production release is active.
2. Phase 8 production provider activation matches that release.
3. A current Phase 9 production beta gate passed.
4. A checksum-verified restore drill passed within 30 days.
5. Every required launch checklist item is passed or explicitly waived and current.
6. No unresolved critical/high security finding exists.
7. No unresolved SEV1/SEV2 incident exists.
8. A platform operator types `OPEN PUBLIC ACCESS` and records a reason.

Deployment and launch are separate actions. Public access defaults to closed.

## Auth-boundary enforcement

The browser no longer exposes unrestricted sign-up when registration is closed. More importantly, the Supabase Auth `auth.users` trigger rejects new users unless:

- production public registration is open, or
- the signup carries the SHA-256 hash of a valid, pending, unexpired beta invitation.

Existing users can always sign in. Beta invite hashes are validated at signup; the original token is still required to accept the invitation and consent version after authentication.

## Launch operations

- `launch_programs` records launch versions and lifecycle.
- `launch_checklist_items` stores required evidence by category.
- `public_access_controls` is the source of truth for registration, waitlist and invite-only modes.
- `launch_gate_assessments` is append-only, expires after four hours and cannot open access itself.
- `open_public_launch` rechecks the live gate under row locks and opens registration atomically.
- `pause_public_launch` immediately closes new registration without deleting users or customer data.

Required checklist categories:

- product
- security
- legal
- support
- operations
- billing
- publishing
- data rights
- communications

## Waitlist and referrals

Waitlist email addresses are normalized and stored only as SHA-256 hashes. Attribution fields are normalized and bounded. Consent version and timestamp are required. Referral codes contain no customer data and are validated before attribution.

Phase 10 does not automatically email waitlist members. Invitation and lifecycle delivery remain explicit future operations.

## Privacy-safe growth events

Acquisition events permit only a fixed funnel vocabulary. Anonymous identifiers are hashed. Properties with personal or credential-like keys are removed recursively. Event keys are idempotent.

Tracked milestones include:

- landing view
- waitlist joined
- signup started/completed
- workspace created
- brand ready
- first approved content
- first verified publication
- trial or subscription started
- churn

Daily aggregates provide source-level funnel counts without exposing user-level browsing histories in the operator dashboard.

## Growth experiments

Experiments use deterministic assignments from a hashed subject identifier. Allocation and variant selection are stable. Outcome writes validate that the experiment is running and that the metric matches the declared primary metric. Phase 10 does not auto-declare winners or modify pricing, onboarding or campaigns.

## Lifecycle actions

Lifecycle actions are proposals. Human approval is required before they become approved. This phase does not include an email sender, so approval never implies delivery.

## Public API

- `GET /public/v10/status`
- `POST /public/v10/beta-invite`
- `POST /public/v10/waitlist`
- `POST /public/v10/events`
- `POST /public/v10/experiments/:experimentKey/assignment`

Public mutation endpoints use the Phase 9 database-backed rate limiter.

## Platform API

- `GET /api/v10/platform/growth`
- launch program, checklist, gate, open and pause operations
- referral code creation
- growth experiment creation and lifecycle changes
- validated growth outcomes and funnel events
- proposed lifecycle actions and approvals

## Migrations

Apply in lexical order through:

- `0020_phase10_public_launch_growth.sql`
- `0021_phase10_launch_integrity.sql`
- `0022_phase10_signup_gate.sql`

## Safety boundaries

Phase 10 does not:

- automatically deploy infrastructure
- automatically open registration
- bypass Phase 7–9 evidence
- store plaintext waitlist emails
- collect arbitrary personal analytics properties
- send lifecycle emails
- automatically change pricing or product behavior
- buy advertising
- claim public launch without the production transaction succeeding

## Acceptance criteria

- Direct Supabase signup is blocked while public access is closed unless a valid beta invite hash is present.
- Public launch rechecks every live prerequisite transactionally.
- Pausing public access closes registration without affecting existing accounts.
- Waitlist records are consented, idempotent and email-hashed.
- Attribution values are bounded and normalized.
- Acquisition events are idempotent and privacy-filtered.
- Experiment assignment is deterministic and outcome metrics are validated.
- Lifecycle actions require explicit approval and are not auto-sent.
- Launch readiness produces checksum-backed repository evidence.
