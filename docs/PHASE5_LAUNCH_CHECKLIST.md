# Phase 5 production launch checklist

## Billing

- Create Stripe products and monthly prices for Solo, Growth and Agency.
- Insert live/test price IDs into `billing_prices` for provider `stripe`.
- Configure Checkout success and cancellation URLs.
- Configure the customer portal for payment method, invoices, cancellation and plan changes.
- Configure failed-payment recovery and confirm the intended grace period.
- Register `/webhooks/billing` and subscribe only to required subscription, invoice and Checkout events.
- Replay duplicate and out-of-order webhook fixtures.
- Verify the webhook endpoint receives the raw body unchanged.

## Entitlements and usage

- Load test `reserve_workspace_usage` with concurrent requests.
- Confirm a failed generation releases its reservation.
- Confirm 50/75/90/100 percent warnings in the UI and notifications roadmap.
- Populate `model_cost_rates` with reviewed provider pricing.
- Set workspace and global spend alert thresholds in the monitoring platform.
- Verify read-only customers can view and export but cannot generate or schedule new work.

## Data and security

- Apply migrations on a disposable Supabase branch.
- Verify RLS with owner, admin, editor, reviewer, publisher and unrelated-user sessions.
- Restore a database backup and validate critical commercial records.
- Verify exports omit provider secrets and credential ciphertext.
- Verify deletion revokes publishing credentials before workspace destruction.
- Review privacy, terms, acceptable use, refund, cancellation and subprocessor disclosures with qualified advisers.

## Operations

- Add platform administrators explicitly; do not seed a universal admin.
- Connect error tracking and structured log redaction.
- Add alerts for billing-event failure, entitlement mismatch, reservation leakage, cost anomaly and delayed publishing.
- Prepare support runbooks for payment failure, invoice request, plan change, export, deletion and suspected account compromise.
- Keep `BILLING_PROVIDER_MODE=mock` until every sandbox item above passes.
