# Meta App Review — permission justifications

Replace every placeholder with the exact current permission name from the authenticated Meta capability spike.

## Basic account permission

Brandloom uses this permission only to identify the professional Instagram account selected by the customer, display that identity for confirmation and verify that the destination remains accessible.

## Content publishing permission

Brandloom uses this permission only after a customer has completed Brandloom's approval workflow. The published payload is an immutable snapshot of the exact approved content version. Users can pause publishing, cancel queued jobs, disconnect the account and export a manual fallback package.

## Reviewer safeguards to demonstrate

1. Connect a test Instagram professional account through official OAuth.
2. Confirm the username and destination account.
3. Open approved content and run deterministic preflight.
4. Schedule or publish the frozen version.
5. Show the verified remote publication and audit trail.
6. Edit the source content and show that the scheduled snapshot does not change silently.
7. Revoke access and show that future jobs are blocked.
