# Meta data deletion behaviour

When a customer disconnects a Meta connection, Brandloom:

- stops new publication jobs for the connection;
- marks queued jobs as requiring action;
- removes encrypted credential material;
- records the disconnection timestamp;
- preserves non-secret publication audit records needed to explain prior customer-authorised actions.

Workspace deletion must remove platform connections, account mappings, snapshots, jobs and audit records through database cascades according to the product's retention policy.
