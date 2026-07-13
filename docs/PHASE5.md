# Brandloom Phase 5 — Commercial Production

Phase 5 turns the Phase 1–4 product into an economically bounded, supportable SaaS operation.

## Product promise

Customers can understand their plan, subscribe, move through trial/active/grace/read-only states, inspect usage, export their data and schedule deletion. Brandloom reserves usage before expensive generation so concurrent requests cannot accidentally overspend a workspace allowance.

## Launch plans

| Plan | Brands | Members | Monthly generation units | Connected accounts |
| --- | ---: | ---: | ---: | ---: |
| Trial | 1 | 2 | 60 | 1 |
| Solo | 1 | 2 | 300 | 1 |
| Growth | 3 | 8 | 1,200 | 5 |
| Agency | 15 | 30 | 5,000 | 25 |

Plan limits and feature flags are stored in `billing_plans`; API authorization uses the latest immutable `entitlement_snapshots` projection rather than scattered plan-name checks. Postgres triggers enforce brand, accepted-member, connected-account and automatic-publishing limits so frontend bypasses cannot exceed the plan.

## Billing lifecycle

The provider reports billing facts. Brandloom projects those facts into product access:

- `trialing` / `active` → full access
- `past_due` before `grace_ends_at` → grace access
- failed, unpaid, paused or cancelled subscriptions → read-only access
- customer data is not deleted because a payment fails

Checkout return pages never activate access by themselves. Production activation is driven by verified Stripe webhook events. Mock billing uses a one-time database-backed checkout session so the complete product flow can be tested without charging a card.

## Usage and cost controls

Generation routes pass through `commercialGuard` before the underlying Phase 1–4 handlers:

1. Resolve workspace and brand.
2. Atomically reserve understandable generation units.
3. Execute the request.
4. Finalize the reservation on success.
5. Release it on failure.

`usage_ledger` is append-only during normal operation. Corrections must use reversal entries. Controlled workspace deletion can still cascade through usage history after the deletion workflow is approved. `generation_runs` also create configurable `cost_events`; model prices remain zero until operators populate `model_cost_rates` with current contracted rates.

## Stripe integration boundary

Production mode uses Stripe Checkout and the customer portal through server-side REST calls. The webhook handler:

- verifies the raw request body and `Stripe-Signature`
- enforces timestamp tolerance
- deduplicates by Stripe event ID
- stores the event before processing
- returns quickly and processes through `waitUntil`
- reconciles subscription and invoice state into Brandloom entitlements

Stripe documentation verified during implementation:

- https://docs.stripe.com/billing/subscriptions/overview
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/customer-management

Do not set `BILLING_PROVIDER_MODE=stripe` until products/prices, sandbox Checkout, portal settings, webhook destination, tax behaviour, failed-payment rules and cancellation policy have been tested.

## Data rights

Workspace administrators can create a JSON export containing brand setup, products, audiences, memories, campaigns, content, publishing audit, subscription references and usage history. Export payloads expire after 72 hours.

Workspace deletion uses a seven-day cooling period. Scheduling deletion pauses new generation. The request becomes `ready` after the cooling period; destructive execution remains an explicit privileged operation so backups, billing cancellation and provider-token revocation can be confirmed first.

## Admin operations

`platform_admins` gates the internal overview. It surfaces subscriptions, current-period usage, estimated costs, recent billing events and pending deletion requests. No unrestricted customer impersonation is included.

## Migrations

Apply in lexical order:

1. `0001` through `0007`
2. `0008_phase5_commercial.sql`
3. `0009_phase5_integrity.sql`
4. `0010_phase5_entitlement_enforcement.sql`

Test the migrations against a disposable Supabase branch before production. In particular verify RLS, entitlement triggers, trial/owner trigger ordering, reservation concurrency, brand/member/account limits, export size, deletion cooling, Stripe event replay and workspace cascades.

## Environment

Safe default:

```env
BILLING_PROVIDER_MODE=mock
```

Production Stripe mode additionally requires:

```env
BILLING_PROVIDER_MODE=stripe
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_API_BASE=https://api.stripe.com
STRIPE_API_VERSION=...
STRIPE_SUCCESS_URL=https://app.example.com/#commercial?checkout=success
STRIPE_CANCEL_URL=https://app.example.com/#commercial?checkout=cancelled
```

## Acceptance criteria

- Duplicate webhooks do not duplicate state changes.
- Browser redirects alone never provision paid access.
- Concurrent generation cannot exceed the available allowance.
- Failed generation releases reservations.
- Payment failures enter grace/read-only states without deleting data.
- Plan limits are enforced in Postgres, not only in UI controls.
- Downgrades preserve excess data for explicit archival decisions.
- Usage history is immutable during operation and customer-visible.
- Customer export is checksum-backed and expires.
- Deletion has a cooling period and auditable state.
- Mock mode can exercise checkout and entitlement changes without Stripe credentials.
