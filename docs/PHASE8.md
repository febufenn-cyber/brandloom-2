# Brandloom Phase 8 — Live Infrastructure and Provider Activation

Phase 8 turns the Phase 7 release-control plane into a deployable staging and production activation process. It does not claim that external accounts, domains or credentials exist. It adds the guarded workflow, evidence model and operator controls required to verify them before activation.

## Product promise

An environment is considered provider-active only when:

1. A Phase 7 release is already active for the environment.
2. Database, Worker, web and private storage checks pass.
3. Anthropic credentials can list available models.
4. Meta mode is enabled and at least one validated publishing connection is healthy.
5. Stripe credentials resolve to the correct test/live account mode.
6. Webhook origins and verification secrets are configured.
7. Every activation check is current and unexpired.
8. An operator types the exact activation confirmation.

CI success, a successful Cloudflare upload or the presence of secret names alone does not activate an environment.

## Activation evidence

`provider_activation_checks` is append-only and stores one safe result per component:

- `database`
- `web`
- `worker`
- `storage`
- `ai_provider`
- `publishing_provider`
- `billing_provider`
- `webhooks`

Each record contains a status, redacted evidence, the checker and an optional expiry. The latest current result for every required component must pass.

`provider_activation_profiles` records the current environment status and the configuration fingerprint used at activation. The fingerprint includes only non-secret configuration identifiers and modes.

`deployment_verification_runs` groups one complete operator or workflow verification attempt.

## API surface

Platform operations:

- `GET /api/v8/platform/activation`
- `POST /api/v8/platform/activation/:environment/verify`
- `POST /api/v8/platform/activation/:environment/activate`
- `POST /api/v8/platform/activation/:environment/evidence`

Activation accepts only `staging` and `production`. Manual waivers require a `super_admin` platform role.

## Deployment workflow

`.github/workflows/deploy-environment.yml` is manual and protected by a GitHub Environment. It:

1. Requires `DEPLOY STAGING` or `DEPLOY PRODUCTION`.
2. Runs the complete repository check.
3. Validates required environment values without printing secret values.
4. Creates the immutable Phase 7 release manifest.
5. Optionally applies Supabase migrations.
6. Synchronizes Worker secrets for the selected environment.
7. Deploys the Cloudflare Worker.
8. Builds and uploads the web application to Cloudflare Pages.
9. Runs liveness, readiness and web smoke probes.
10. Uploads redacted deployment evidence.

The workflow intentionally does not validate or promote a Phase 7 release and does not activate Phase 8. Those are separate operator decisions after the deployment is inspected.

## GitHub Environment configuration

Create `staging` and `production` GitHub Environments. Production should require manual approval.

Environment variables:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `ANTHROPIC_MODEL`
- `ANTHROPIC_API_VERSION`
- `WEB_ORIGIN`
- `PUBLIC_API_ORIGIN`
- `META_APP_ID`
- `META_REDIRECT_URI`
- `META_REQUIRED_SCOPES`
- `STRIPE_API_VERSION`
- `STRIPE_SUCCESS_URL`
- `STRIPE_CANCEL_URL`
- `CLOUDFLARE_PAGES_PROJECT`
- `CLOUDFLARE_PAGES_BRANCH`

Environment secrets:

- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL`
- `ANTHROPIC_API_KEY`
- `TOKEN_ENCRYPTION_KEY`
- `CRON_SECRET`
- `META_APP_SECRET`
- `META_WEBHOOK_VERIFY_TOKEN`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Use Stripe test credentials in staging and live credentials only in production.

## Activation sequence

1. Apply migrations through `0017` on a disposable branch and test RLS/RPC behaviour.
2. Configure GitHub staging environment values and secrets.
3. Run the deployment workflow with migrations enabled.
4. Create and validate the Phase 7 staging release using the workflow artifact checksum.
5. Promote that release.
6. Complete one real Meta OAuth connection and validate the account.
7. Configure Stripe test products, prices and webhook destination.
8. Open the Activation console and run staging verification.
9. Resolve every failed component.
10. Type `ACTIVATE STAGING`.
11. Execute the closed-beta and security work in Phase 9.
12. Repeat with production credentials only after the production launch gate is approved.

## Safety boundaries

Phase 8 does not:

- invent or retrieve credentials
- bypass Meta review or OAuth consent
- create Stripe products silently
- publish test content automatically
- create a real charge during activation checks
- promote a Phase 7 release
- activate an environment with missing or expired evidence
- expose secret values in APIs, logs or artifacts
- treat staging activation as production approval

## Migrations

Apply in lexical order through:

- `0016_phase8_live_infrastructure.sql`
- `0017_phase8_activation_integrity.sql`

## Acceptance criteria

- Production rejects mock provider modes.
- Production rejects Stripe test keys; staging rejects live keys.
- Provider activation checks are append-only.
- Activation requires all eight current checks.
- Activation requires an active Phase 7 release.
- Meta readiness requires a healthy validated connection.
- Stripe readiness performs a safe account lookup and records no secret.
- The deployment workflow requires explicit confirmation and a protected environment.
- Deployment artifacts contain only redacted evidence.
- Deployment, release promotion and provider activation remain separate auditable actions.
