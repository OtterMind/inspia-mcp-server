# Inspia MCP 1.0

## API Key Access

The matching site adds `/account/api-keys` as the primary access-management
page. Create a named key with a chosen expiration, copy it once, and configure
the MCP client to send it as a Bearer token. Keep the secret in the client's
credential storage or environment, not in prompts, URLs or committed config.
The service continues to verify every key with the main site. Expired/revoked
keys are rejected and existing OAuth connections continue to work.

API keys use account Credits directly. Credit replies have null connection
limits, and a non-expiring key has null principal expiresAt. Null does not
mean zero Credits. Existing OAuth grants retain their authorized limits.
The site's key creation dialog explains private-data access and spending.
There are no tools for keys to manage themselves or increase permissions.

This addition requires site migration `0003_api_keys.sql` plus both updated
services. It has not been deployed as part of local implementation. Existing
OAuth setup below remains valid for clients that already use it.

1.0 adds five opt-in account tools to the five anonymous discovery tools.
Production remains on 0.1 until the matching site release, migrations and
flags are explicitly deployed. This is an independent service; it never
opens PostgreSQL or calls Billing, generation providers or R2 directly.

| Tool | Scope | Behavior |
| --- | --- | --- |
| `get_credits` | `credits:read` | Authoritative Billing balance and connection limits |
| `get_task` | `tasks:read` | Owner-private task status by task ID or original idempotency key |
| `read_asset` | `assets:read` | Metadata or bounded derived WebP preview as MCP image content |
| `quote_generation` | `generation:create` | Immutable five-minute single-image quote; no consumption |
| `generate_image` | `generation:create` | Submit the frozen quote with a durable idempotency key |

Use `list_models` to choose a currently available image model and valid options.
Show the quoted Credits before generating. `generate_image` accepts only
`quoteId` and `idempotencyKey`; it cannot silently change the quoted prompt.
The key must match `[A-Za-z0-9_-]{16,128}`. Keep it unchanged after a timeout.
Use `get_task` for recovery, with exactly one of `taskId` or `idempotencyKey`.
Task polling is read-only; follow `retryAfterSeconds`.

Reference inputs are existing owned image asset IDs. Uploads, videos, publishing,
shared result links, cancellation and batch generation are outside 1.0.
Private download endpoints require client-managed Authorization headers;
tokens must never appear in prompts, URLs, logs or returned tool data.

## OAuth and Budgets

The site uses the official Better Auth OAuth provider 1.6.27 with authorization
code + S256 PKCE, dynamic client registration and rotating refresh tokens.
Discovery stays anonymous. Private calls return an HTTP 401 resource metadata
challenge, or HTTP 403 with required scopes. Clients must request the resource
and chosen scopes; generation also needs tasks:read for subsequent polling and
assets:read to retrieve images.

The consent screen and `/account/connections` belong to Inspia. Generation is
unchecked initially. Each connection starts with zero per-request and daily
Credits limits. Daily usage is measured by UTC day and includes pending work.
Lowering a limit blocks new work; it does not cancel accepted tasks. Connection
revocation rejects subsequent requests and refreshes; reauthorization creates
a new grant identity. Revocation does not cancel already accepted tasks.

Quoted cost, input, pricing and capability versions are revalidated at submission.
A user-level PostgreSQL lock serializes task creation and budget allocation.
Billing consumes once per task ID; an unknown result remains awaiting_credit.
Budget is released on confirmed Billing failure or refund, not while a refund
is pending. There is no separate Credits ledger in the MCP service or website.

## Configuration

Site (after its additive MCP migration):

```dotenv
INSPIA_MCP_ENABLED=true
INSPIA_MCP_GENERATION_ENABLED=false
INSPIA_MCP_RESOURCE_URL=https://inspia.ai/mcp
```

MCP service:

```dotenv
INSPIA_BASE_URL=https://inspia.ai
MCP_ACCOUNT_ENABLED=true
MCP_RESOURCE_URL=https://inspia.ai/mcp
```

Keep both resource URLs identical. Enable site generation only after validating
the read-only OAuth flow and the existing Billing/Task worker/R2 configuration.
For local work use site origin `http://127.0.0.1:3001`, MCP resource
`http://127.0.0.1:8791/mcp`, and MCP_PORT=8791. Existing host/origin allowlists,
timeouts, body limits and rate limits still apply.

The HTTPS proxy must keep `/mcp` pointing to this service. Route
`/.well-known/oauth-protected-resource/mcp`,
`/.well-known/oauth-authorization-server/api/auth`, `/api/auth/*`, `/api/mcp/*`,
`/mcp/sign-in`, `/mcp/resume`, `/mcp/authorize` and `/account/connections` to
the main site. The exact `/mcp` Nginx location must not become a prefix match.
Forward Authorization unchanged and disable caching on all private responses.

## Validation and Rollback

`bun run check` includes anonymous 0.1 compatibility and modern/legacy SDK
account tools, scoped challenges, output projection and bounded image content.
The matching main-site `docs/MCP_1_0.md` covers migration and isolated OAuth,
budget, idempotency and Billing failure tests. Local integration mocks external
Billing/catalog services and does not run a paid provider submission.

Disable `INSPIA_MCP_GENERATION_ENABLED` to stop new MCP generations. Disable
`MCP_ACCOUNT_ENABLED` for discovery-only service operation. Disable the site's
`INSPIA_MCP_ENABLED` to reject account API access and stop OAuth issuance.
Keep the additive schema and existing Task worker so accepted tasks can finish
or refund. No migration, release, production enablement or paid smoke test is
performed by the normal test commands.
