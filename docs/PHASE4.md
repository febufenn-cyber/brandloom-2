# Brandloom Phase 4 — trusted publishing

## Promise

Brandloom publishes only the exact content version the customer approved, to the destination they explicitly confirmed, at the chosen time, and retains evidence of the result.

## Included

- Official OAuth authorization-code connection flow
- One-time hashed state and configurable PKCE S256
- AES-GCM encrypted access-token custody
- Service-role-only credential access
- Explicit destination-account confirmation
- Connection health and reauthorization states
- Immutable publication snapshots
- Deterministic preflight at scheduling and dispatch
- Workspace, brand and account publishing pause controls
- Brandloom-owned scheduling through Cloudflare Cron Triggers
- Atomic job claims and stable idempotency keys
- Image, carousel and Reel provider adapters
- Remote processing continuation
- Bounded retry policy and manual-action states
- Unknown-result reconciliation before retry
- Remote publication verification and permalink storage
- Signed private-asset delivery URLs
- Webhook signature verification and event deduplication
- Manual publication fallback
- Publishing command centre
- Mock provider for safe end-to-end testing

## Deliberate exclusions

- Performance analytics
- Paid ads
- Comment or DM management
- Engagement automation
- Automatic remote deletion
- Multi-platform rollout
- Publishing content that lacks a current human approval

## Provider modes

### `mock`

The default local mode. It completes the full OAuth, snapshot, scheduler, retry and verification workflow without contacting Meta.

### `meta`

Uses the environment-configured Meta endpoints and scopes. Do not enable in production until `docs/integrations/meta-capability-matrix.md` is completed with authenticated tests for the exact Meta app and API version.

## Required configuration

Generate the encryption key once and keep it outside the database:

```bash
openssl rand -base64 32
```

Store `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_ENCRYPTION_KEY`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` and `CRON_SECRET` as Worker secrets.

## Migration order

Apply all migration files in lexical order. Phase 4 contains a permissions migration before the publishing schema, followed by integrity functions and triggers.

## Production verification checklist

1. Complete Meta capability spike.
2. Apply migrations to a disposable Supabase branch.
3. Verify authenticated users cannot select `platform_credentials`.
4. Connect and confirm a test professional account.
5. Publish one approved image and verify it remotely.
6. Test carousel order.
7. Test Reel processing continuation.
8. Simulate network loss after provider acceptance and confirm no duplicate.
9. Revoke the token and verify reauthorization handling.
10. Pause workspace publishing and confirm cron dispatch stops.
11. Complete Meta App Review materials.
