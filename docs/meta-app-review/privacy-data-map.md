# Meta integration privacy data map

| Data | Purpose | Storage | Exposure |
|---|---|---|---|
| OAuth state hash | Prevent callback forgery and replay | Supabase | Service and initiating user only |
| Access token | Publish authorised content | AES-GCM encrypted credential table | Service role only |
| Provider account ID and username | Confirm destination | Supabase | Workspace members |
| Granted scopes and connection health | Explain capability | Supabase | Workspace members |
| Publication snapshot | Prove exact approved payload | Supabase | Workspace members |
| Remote media ID and permalink | Verify delivery | Supabase | Workspace members |
| Safe provider error | Recovery guidance | Supabase | Workspace members |
| Raw webhook body | Event reconciliation | Supabase, bounded retention | Service role only |

Access tokens are never returned to the browser, included in analytics, or written to application logs.
