# Meta reviewer walkthrough

1. Sign in to the supplied Brandloom review workspace.
2. Open **Publishing → Connections**.
3. Select **Connect Instagram** and complete the official provider authorization flow.
4. Confirm the discovered destination account. Publishing remains disabled until this step.
5. Open a Phase 3 content item whose workflow state is `ready_to_publish` and whose required approvals are current.
6. Run preflight and review the destination, exact content version, assets, approval proof and scheduled time.
7. Publish now or schedule the item.
8. Open the publication job to inspect each state transition, safe provider errors, remote media ID and verification result.
9. Use the global pause control to demonstrate that queued dispatch is blocked.
10. Disconnect the account and confirm that credential material is removed while non-secret audit history remains.
