# Brandloom Production Release Runbook

This runbook is the operator sequence for moving a verified build through staging and production. It assumes migrations and deployments are performed through the approved external tools for Supabase, Cloudflare and the web host.

## Roles

- **Release operator:** owns the release record, deployment and promotion evidence.
- **Database operator:** applies and verifies migrations.
- **Security reviewer:** verifies scopes, secrets, RLS and externally exposed endpoints.
- **Incident commander:** owns containment if the release causes customer impact.

One person may hold multiple roles in an early-stage team, but each decision must remain separately recorded.

## 1. Prepare the release package

1. Start from a clean, reviewed commit on `main`.
2. Run `pnpm check`.
3. Run the Release readiness workflow for `staging`.
4. Download the artifact and preserve `release-manifest.json`.
5. Confirm its commit SHA matches the intended `main` commit.
6. Confirm migration version matches the latest migration file.
7. Create an immutable staging release record in the Reliability workspace.

Do not copy an artifact checksum from a different workflow run or rebuild the same version with changed contents.

## 2. Stage the database

1. Create or select a disposable/staging Supabase project or branch.
2. Take a backup or snapshot before migration.
3. Apply migrations in lexical order through the manifest's migration version.
4. Verify every migration is recorded once.
5. Exercise:
   - authentication and workspace access
   - RLS for each workspace role
   - service-role-only functions
   - storage policies
   - release promotion RPCs
   - append-only trigger behaviour
   - workspace deletion cascades
6. Record the migration gate evidence.

Never edit an already-applied migration to repair staging. Add a new forward migration.

## 3. Deploy staging artifacts

1. Configure staging runtime metadata:
   - `DEPLOYMENT_ENVIRONMENT=staging`
   - `APP_VERSION=<release version>`
   - `COMMIT_SHA=<manifest commit>`
   - `EXPECTED_MIGRATION_VERSION=<manifest migration>`
2. Configure staging URLs and secrets.
3. Keep billing and publishing in mock mode unless staging provider capability testing is explicitly scheduled.
4. Deploy the exact API and web artifacts from the release package.
5. Verify `/health/live` returns the intended version and commit.
6. Verify `/health/ready` reports no blocking configuration or database failures.
7. Record current health checks for API, web, database and scheduler.

## 4. Execute staging smoke tests

Test at minimum:

- sign-up, sign-in and session restoration
- brand onboarding and Brand Constitution
- weekly plan and content generation
- editing, approval and readiness
- mock publishing lifecycle and retries
- mock billing lifecycle and entitlements
- performance import and optimization review
- data export
- environment pause and resume
- release validation and rollback on staging

Use synthetic customers and accounts. Do not use production tokens in staging.

## 5. Run a restore drill

1. Restore the staging backup into a disposable target.
2. Verify schema version and critical record counts.
3. Verify representative workspace, memory, approval, publishing, billing and optimization records.
4. Compare checksums or an approved integrity report.
5. Record observed recovery point and recovery time.
6. Mark the drill passed only after checksum verification.

A successful backup job without a restore is not acceptable evidence.

## 6. Validate staging release

1. Run automated release checks.
2. Review every gate's evidence and expiry.
3. Manually provide any provider, security or observability evidence that cannot be automated.
4. Validate the release.
5. Deploy externally if not already deployed.
6. Record promotion only after the deployed system has passed smoke tests.
7. Observe staging for a meaningful soak period.

## 7. Prepare production

Create a separate production release record using the production artifact from the Release readiness workflow.

Production runtime must use:

- `DEPLOYMENT_ENVIRONMENT=production`
- real, reviewed `APP_VERSION` and `COMMIT_SHA`
- the exact expected migration version
- `PUBLISHING_PROVIDER_MODE=meta`
- `BILLING_PROVIDER_MODE=stripe`
- production-specific secrets and redirect URLs

Confirm:

- provider scopes and webhook signatures
- Stripe products, prices, tax behaviour and failed-payment flows
- Meta account identity and test publications
- alert routing and on-call ownership
- customer communication channel
- rollback artifact and previous release availability

## 8. Production migration and deployment

1. Announce the release window internally.
2. Open an incident pre-emptively only when the migration or provider change is unusually risky.
3. Pause risky operation classes when required; avoid broad maintenance mode unless necessary.
4. Take a verified production backup.
5. Apply migrations.
6. Run database verification queries.
7. Deploy the exact manifest artifacts.
8. Check `/health/live` for version and commit.
9. Check `/health/ready`.
10. Run critical smoke tests using designated production test records.
11. Run automated release checks again so time-bound evidence is current.
12. Validate the release.
13. Record promotion.

Do not record promotion while the deployment is only queued or while health evidence belongs to the previous release.

## 9. Post-release observation

Monitor:

- API error rate and latency
- authentication failures
- database saturation and RLS errors
- generation failures and cost anomalies
- publishing delays, retries and duplicate risk
- billing webhooks and entitlement mismatches
- scheduled-job freshness
- customer-reported issues

Keep the previous release and rollback instructions available throughout the observation window.

## 10. Rollback

Rollback when continued operation is riskier than reverting.

1. Open or update an incident.
2. Pause affected operation classes.
3. Select a previously verified release for the same environment.
4. Confirm database compatibility with that release.
5. Deploy the previous artifacts externally.
6. Run live and ready checks.
7. Record the rollback with a concrete reason.
8. Reconcile queued publications, billing events and background jobs.
9. Do not resume paused operations until validation completes.

A database migration that is not backward compatible may require a forward repair rather than an application rollback.

## 11. Release closeout

- Preserve the manifest, gate evidence and transition record.
- Resolve or link incidents.
- Record follow-up tasks.
- Update runbooks when reality differed from the documented process.
- Schedule another restore drill before existing evidence expires.
