# Brandloom Phase 7 — Production Launch and Reliability

Phase 7 turns the feature-complete application into an auditable release system. It does not automatically deploy infrastructure. It creates deterministic build evidence, verifies launch prerequisites, controls risky operations during incidents, records promotions and rollbacks transactionally, and exposes safe health probes.

## Product promise

A Brandloom release is not considered active because code was pushed or CI passed. It is active only when:

1. A build produced an immutable manifest.
2. The migration target matches the release.
3. Required configuration and provider modes are valid for the environment.
4. Database and component health evidence is current.
5. A recent checksum-verified restore drill exists where required.
6. Rollback readiness is recorded.
7. Observability and security gates are satisfied.
8. The external deployment completed.
9. A platform operator explicitly records promotion.

## Main components

### Immutable release records

`system_releases` binds an environment, version, commit SHA, artifact checksum and migration version. Those identity fields cannot be edited later. Corrections require a new release record.

### Time-bound release gates

`release_gate_results` stores evidence for:

- migration verification
- secret and runtime configuration verification
- database health
- provider readiness
- backup and restore verification
- rollback readiness
- observability readiness
- security review

Expired evidence no longer counts even if its status previously passed.

### Transactional promotion and rollback

`promote_system_release` locks the target environment, re-evaluates required gates and atomically updates the active release. `rollback_environment_release` records the previous active release, target and reason in an append-only transition.

### Environment circuit breakers

`environment_controls` can independently pause:

- maintenance-mode mutations
- all writes
- AI generation
- publishing

Read operations and the reliability control plane remain available. In production, mutating requests fail closed when the control plane cannot be read.

### Incident command

Incidents have severity, impact, ownership, customer-facing messaging and an append-only timeline. Opening an incident may apply a conservative control preset. Resolving an incident never silently resumes paused systems.

### Restore drills

A backup is not considered release evidence until a disposable restore is completed and its checksum is verified. Recovery point and recovery time observations are recorded with redacted evidence.

### Health and audit evidence

Health checks are append-only and expire. The scheduled Worker records API, scheduler and database evidence at a bounded cadence. Operational audit events store references and decisions, not secrets.

## API surface

Public:

- `GET /health/live`
- `GET /health/ready`

Platform operations:

- `GET /api/v7/platform/reliability`
- `POST /api/v7/platform/releases`
- `POST /api/v7/platform/releases/:releaseId/checks`
- `PUT /api/v7/platform/releases/:releaseId/gates/:gateKey`
- `POST /api/v7/platform/releases/:releaseId/validate`
- `POST /api/v7/platform/releases/:releaseId/promote`
- `POST /api/v7/platform/environments/:environment/rollback`
- `PATCH /api/v7/platform/environments/:environment/controls`
- `POST /api/v7/platform/health-checks`
- `POST /api/v7/platform/incidents`
- `PATCH /api/v7/platform/incidents/:incidentId`
- `POST /api/v7/platform/incidents/:incidentId/events`
- `POST /api/v7/platform/restore-drills`
- `PATCH /api/v7/platform/restore-drills/:drillId`

## Release artifact workflow

Run:

```bash
pnpm check
pnpm run release:manifest -- --environment staging --version 7.0.0 --commit <sha>
```

The manifest includes:

- environment
- release version
- commit SHA
- latest migration version
- migration corpus checksum
- lockfile checksum
- API artifact checksum
- web artifact checksum
- combined artifact checksum

The `Release readiness` GitHub Actions workflow creates the same package for a manual run or version tag. It uploads evidence but does not deploy or promote.

## Required environment metadata

- `DEPLOYMENT_ENVIRONMENT`
- `APP_VERSION`
- `COMMIT_SHA`
- `EXPECTED_MIGRATION_VERSION`

Production also requires real Meta and Stripe modes plus their current secrets. Readiness responses expose only configuration status, never secret values.

## Migrations

Apply in lexical order through:

- `0014_phase7_production_reliability.sql`
- `0015_phase7_integrity_and_release_rpc.sql`

The release validator rejects missing or duplicate migration numbers and requires Wrangler's expected migration version to match the latest migration.

## Safety boundaries

Phase 7 does not:

- deploy Cloudflare Workers or the web application
- run Supabase migrations automatically
- rotate or reveal secrets
- auto-promote a build
- auto-resolve incidents
- auto-resume paused operations
- claim a backup works without a restore drill
- treat CI success as production health

## Acceptance criteria

- Release identity fields are immutable.
- Production promotion fails when any required gate is missing, failed or expired.
- Concurrent promotions cannot create two active releases.
- Rollback records source, target, actor and reason.
- Production mutations fail closed when the safety control plane is unavailable.
- Reads and recovery controls remain accessible during a pause.
- SEV1 incidents may pause all mutations immediately.
- Incident and audit timelines cannot be rewritten.
- Restore drills cannot pass without checksum verification.
- Health evidence expires and must be refreshed.
- Build artifacts produce a deterministic checksum-backed manifest.
- CI runs release validation, strict TypeScript, tests and production builds.
