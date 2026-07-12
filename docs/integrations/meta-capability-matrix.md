# Meta Instagram capability matrix

Verified on: 2026-07-12

## Verification status

Meta's official developer documentation returned a login gate from this implementation environment. Therefore every Meta endpoint, scope, API base URL and PKCE switch is environment-configurable. Production access must not be enabled until an authenticated capability spike is completed against the Meta app that will be submitted for review.

## Required spike

Record the result of each test with the Meta app ID, Graph/API version, test account and date.

| Capability | Implementation support | Production verification required |
|---|---:|---:|
| OAuth authorization-code flow | Yes | Yes |
| Random state and one-time callback | Yes | Yes |
| PKCE S256 | Configurable | Confirm provider acceptance |
| Account identity discovery | Yes | Confirm response fields |
| Image container and publish | Yes | Confirm endpoints and scopes |
| Carousel child/parent containers | Yes | Confirm item and media constraints |
| Reel container, processing poll and publish | Yes | Confirm codecs, duration and status fields |
| Story publication | Blocked by default | Verify before enabling |
| Long-lived token exchange | Configurable | Confirm token lifecycle |
| Refresh token/access token flow | Configurable | Confirm current endpoint |
| Webhook verification/signature | Yes | Confirm subscribed event payloads |
| Native platform scheduling | Not used | Not required for Phase 4 |

## Configuration boundary

The adapter reads these values rather than scattering provider assumptions through the application:

- `META_APP_ID`
- `META_APP_SECRET`
- `META_REDIRECT_URI`
- `META_OAUTH_AUTHORIZE_URL`
- `META_OAUTH_TOKEN_URL`
- `META_LONG_LIVED_TOKEN_URL`
- `META_REFRESH_TOKEN_URL`
- `META_GRAPH_BASE_URL`
- `META_REQUIRED_SCOPES`
- `META_OAUTH_USE_PKCE`
- `META_WEBHOOK_VERIFY_TOKEN`

## Production evidence to attach

- Successful connection screenshot
- Exact granted scopes
- Account type and prerequisites
- Immediate image publication and verification
- Carousel publication and order verification
- Reel processing and publication
- Revoked-token behaviour
- Duplicate-suppression test
- App Review permission justifications
