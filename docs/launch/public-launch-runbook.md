# Public Launch Operations Runbook

## Before assessment

- Confirm the production Phase 7 release is active and matches the deployed commit and migration target.
- Confirm Phase 8 production activation is active for that release.
- Record a current Phase 9 production beta-gate pass.
- Confirm a checksum-verified production restore drill completed within 30 days.
- Resolve critical/high security findings and SEV1/SEV2 incidents.
- Review every launch checklist item with evidence and expiry.
- Confirm legal, support, billing, publishing, cancellation, export and deletion procedures are published and staffed.

## Gate and opening sequence

1. Create a production launch program for the immutable version.
2. Complete and verify the generated checklist.
3. Run the public launch assessment.
4. Inspect the full summary; do not rely only on the green label.
5. Confirm the active release and provider activation IDs are correct.
6. Type `OPEN PUBLIC ACCESS` and record the operational reason.
7. Verify `/public/v10/status` reports registration open.
8. Complete one normal signup and one beta-invite signup.
9. Confirm billing, onboarding, export and deletion paths.
10. Record post-launch health and incident ownership.

## Immediate pause

Type `PAUSE PUBLIC ACCESS` with a reason when:

- a cross-workspace authorization concern appears
- incorrect-account publishing is suspected
- signup, billing or deletion is materially broken
- security or privacy controls fail
- support cannot safely absorb new accounts
- a SEV1/SEV2 incident is opened

Pausing blocks new public signups and restores invite-only mode. Existing accounts, data and subscriptions remain intact. Apply Phase 7 circuit breakers separately when writes, generation or publishing must also stop.

## Waitlist operations

- Keep the consent version synchronized between Worker and web build configuration.
- Never export plaintext emails because Brandloom stores only hashes.
- Use an approved external communication system only after a separate consent-compatible integration is implemented.
- Mark entries unsubscribed or blocked rather than deleting attribution evidence arbitrarily.

## Growth operations

- Review aggregate funnel metrics, not individual browsing histories.
- Require a written hypothesis and primary metric before starting an experiment.
- Do not change a running experiment’s identity or variants.
- Treat experiment results as evidence, not automatic authority.
- Lifecycle actions remain proposed until approved; this release has no automatic email sender.

## First 72 hours

- Review production health, publishing, billing and signup metrics at least daily.
- Reassess the launch gate after any deployment or critical configuration change.
- Monitor support volume, failed payments, publishing uncertainty and deletion requests.
- Keep rollback and public-access pause controls immediately available.
- Document every significant incident and corrective action.
