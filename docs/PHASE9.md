# Brandloom Phase 9 — Security, QA and Closed Beta

Phase 9 converts an activated staging environment into a governed closed beta. It adds beta consent and capacity controls, structured QA evidence, security findings, rate limits, browser security headers and a launch gate. It does not invite real people or declare public readiness automatically.

## Product promise

A closed beta may open only when:

1. Phase 8 provider activation is active for the target environment.
2. Current QA evidence passes for authentication, RLS, publishing, billing, data rights, reliability and security.
3. No unresolved critical or high security finding exists.
4. No unresolved SEV1 or SEV2 incident exists.
5. A beta program is recruiting or active.
6. Every participant accepts the current consent version.
7. Capacity is enforced transactionally.
8. An operator records a current beta-gate assessment.

## Closed-beta data model

- `beta_programs` defines capacity, consent version and lifecycle.
- `beta_invites` stores only email and invite-token hashes.
- `beta_participants` records explicit consent and program status.
- `beta_feedback` captures sanitized context and trace IDs.
- `qa_test_runs` stores time-bound test evidence.
- `security_findings` tracks remediation and risk acceptance.
- `beta_gate_assessments` is append-only launch evidence.
- `api_rate_limit_buckets` supports atomic fixed-window limits.

## Security controls

API responses receive request IDs, no-sniff, frame denial, restrictive referrer and permissions policies, HSTS in production and `no-store` on API/webhook responses.

Mutating APIs use database-backed limits keyed by a salted hash of network and authorization context. The salt and raw identifiers are never stored together. Production fails closed when the rate-limit control cannot be reached.

The web deployment includes a restrictive Content Security Policy and other security headers through Cloudflare Pages `_headers`.

The deterministic static check rejects likely embedded credentials, browser references to server-only secrets, wildcard CORS and secret-bearing console output.

## Invitation flow

1. A platform operator creates a program.
2. The operator enters an email address.
3. Brandloom creates a random 32-byte invitation token.
4. Only the email hash and token hash are stored.
5. The one-time link is returned once for manual delivery.
6. The authenticated recipient accepts the current consent version.
7. The database locks the invitation and program, checks expiry and capacity, and creates the participant.

Phase 9 does not send email automatically.

## QA gate

Required current suites:

- `auth`
- `rls`
- `publishing`
- `billing`
- `data_rights`
- `reliability`
- `security`

Evidence may come from CI, manual testing, synthetic checks or beta validation. Expired evidence does not count.

## Workflows and evidence

`Security and beta QA` runs static security checks, the full repository check and creates `beta-qa-manifest.json`. The manifest hashes migrations and test files so the evidence is tied to the reviewed commit.

The guarded deployment workflow also runs these checks and uploads the manifest. It still does not open beta access or public access.

## Migrations

Apply in lexical order through:

- `0018_phase9_security_closed_beta.sql`
- `0019_phase9_security_integrity.sql`

## Safety boundaries

Phase 9 does not:

- email invitation links
- store plaintext invite tokens or email addresses in beta tables
- allow an expired invitation or stale consent version
- bypass program capacity
- store arbitrary secret-bearing feedback context
- let unresolved critical/high findings pass the gate
- let expired QA evidence pass the gate
- treat security scanning as a penetration test
- open public registration

## Acceptance criteria

- Invitation acceptance is atomic and consent-bound.
- Beta capacity cannot be exceeded by concurrent acceptance.
- Participant feedback context is redacted and bounded.
- API mutation limits are atomic and fail closed in production.
- Required browser and API security headers are present.
- QA evidence is tied to a commit and expires.
- Critical/high findings and SEV1/SEV2 incidents block the gate.
- The beta command centre exposes programs, invitations, participants, feedback, QA and findings without displaying stored secrets.
