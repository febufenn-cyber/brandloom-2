# Brandloom Incident Response Runbook

## First principle

Contain customer harm before debugging deeply. Preserve evidence, keep recovery controls accessible, and do not silently resume operations after the incident appears stable.

## Severity

### SEV1 — Critical

Examples:

- cross-customer data exposure
- wrong-account publication
- compromised provider or service credentials
- incorrect billing at scale
- destructive data loss

Default preset:

- maintenance mode on
- writes paused
- generation paused
- publishing paused

Immediate actions:

1. Open the incident.
2. Apply the SEV1 preset.
3. Revoke or rotate exposed credentials.
4. Preserve logs and identifiers.
5. Identify affected customers and time range.
6. Engage qualified legal/security support when required.

### SEV2 — Major

Examples:

- widespread publishing failures
- payment state not matching access
- large-scale generation outage or cost runaway
- database instability affecting many workspaces

Default preset:

- generation paused
- publishing paused
- reads and ordinary non-risky writes remain available where safe

### SEV3 — Significant

Examples:

- delayed publishing for a subset of accounts
- one provider integration degraded
- repeated background-job failures
- material dashboard data lag

Default preset:

- publishing paused
- other systems remain available unless evidence requires broader containment

### SEV4 — Limited

Examples:

- isolated customer defect
- cosmetic issue
- non-critical report delay

No automatic circuit breaker is applied.

## Incident lifecycle

### Investigating

- establish incident commander
- state known impact and unknowns
- attach related release and environment
- set next update time
- choose the narrowest safe circuit breaker

### Identified

- document the most likely failure mechanism
- distinguish confirmed facts from hypotheses
- record mitigation and rollback options
- update customers when impact warrants it

### Monitoring

- mitigation is deployed
- health and business indicators are improving
- risky operation classes remain paused until evidence is sufficient

### Resolved

- immediate impact has ended
- reconciliation is complete or assigned
- customer communication is issued where required
- controls are resumed separately and explicitly
- follow-up actions have owners

## Required timeline entries

Record:

- discovery time
- first containment action
- affected environment and release
- customer impact assessment
- provider and database evidence
- every circuit-breaker change
- mitigations and rollbacks
- customer communications
- root cause
- resolution evidence

Never store raw access tokens, passwords, payment details or private signed URLs in incident evidence.

## Wrong-account publication

1. Pause publishing globally for the environment.
2. Disable or revoke the affected connection.
3. Preserve publication snapshot, account ID, remote media ID and provider response.
4. Determine whether any other job used the same credential or destination mapping.
5. Remove content only through an approved account-owner action.
6. Require reauthorization and destination reconfirmation before resuming.

## Billing incident

1. Pause new checkout or billing mutations if state projection is unreliable.
2. Preserve provider event IDs and Brandloom billing-event records.
3. Do not delete or rewrite webhook history.
4. Reconcile provider subscriptions against entitlement snapshots.
5. Use compensating credits or refunds through approved processes.
6. Do not remove customer data because payment state is uncertain.

## Data exposure

1. Apply SEV1 containment.
2. Revoke affected credentials.
3. Preserve audit evidence and query scope.
4. Determine affected tenants, fields and access duration.
5. Stop any automation that could overwrite evidence.
6. Follow applicable notification and legal obligations.

## AI cost runaway

1. Pause generation, not the entire product.
2. Identify workspace, route, model and idempotency keys.
3. Stop retries or duplicated reservations.
4. Reconcile usage and provider cost records.
5. Reverse customer charges caused by a system defect using append-only ledger corrections.
6. Resume with tighter request, retry and cost ceilings.

## Publishing backlog

1. Pause new scheduling when continued queue growth increases risk.
2. Keep verification and reconciliation workers available.
3. Separate jobs that are safe to retry from jobs with duplicate risk.
4. Reconcile remote IDs before attempting a second publish.
5. Communicate delays without claiming a post failed when state is uncertain.

## Rollback decision

Rollback is favored when:

- the defect maps clearly to the current release
- the previous release is compatible with the migrated database
- mitigation would take longer than rollback
- customer harm continues

Forward repair is favored when:

- the migration is not backward compatible
- provider state changed irreversibly
- rollback would create duplicate publication or billing actions
- the defect is data-specific and unaffected by application version

## After resolution

Complete a blameless review covering:

- customer impact
- detection gap
- containment speed
- technical root cause
- contributing process failures
- why existing tests or gates missed it
- reconciliation performed
- concrete prevention work

Convert prevention items into tracked work with owners and deadlines. Update this runbook when the actual response differed from the documented process.
