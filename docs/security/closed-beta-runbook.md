# Closed Beta Operations Runbook

## Before recruiting

- Confirm the staging Phase 7 release is active.
- Confirm Phase 8 staging activation is active and fingerprints the current configuration.
- Apply migrations through `0019` on a disposable project first.
- Run the security and beta QA workflow.
- Record QA runs for every required suite.
- Resolve or explicitly accept every critical/high finding.
- Confirm no SEV1/SEV2 incident is open.
- Create a beta program with a reviewed consent version and a conservative capacity.
- Assess the beta gate.

## Invitation handling

- Create invitation links only from the Beta command centre.
- Deliver links through an approved private channel.
- Do not paste links into public tickets or logs.
- Links expire after the configured duration and are single-use.
- Revoke an invitation and generate a new one when delivery is uncertain.
- Never ask a tester to send an access token, password or provider credential.

## During beta

- Review critical/high feedback and security findings daily.
- Maintain current QA evidence after each release.
- Pause the program when a blocking incident or data issue is discovered.
- Use Phase 7 environment controls to pause writes, generation or publishing as needed.
- Preserve trace IDs and sanitized context; do not request raw secrets.
- Reassess the beta gate after any release, activation change, blocker or consent-version update.

## Exit and deletion

- Mark participants exited or removed rather than rewriting consent history.
- Process workspace export/deletion through Phase 5 data-rights flows.
- Revoke outstanding invitation links when a program ends.
- Complete the program only after unresolved feedback and incidents have owners.

## Incident escalation

- Suspected cross-workspace access, wrong-account publication, credential exposure or billing at scale is SEV1.
- Pause affected mutations immediately through Phase 7 controls.
- Preserve evidence without copying secrets into the incident timeline.
- Notify affected testers using the approved customer-communication process.
- Do not reopen beta until the relevant QA suites pass and the gate is reassessed.
