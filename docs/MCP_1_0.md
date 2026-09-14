# Inspia MCP 1.0

## API Keys Only

Create a key at https://inspia.ai/account/api-keys and configure the client to
send `Authorization: Bearer <key>`. Store it in client credential storage or
an environment variable, never a prompt, URL or committed config.
MCP OAuth support was removed in production on 2026-09-07 (site 3b40d48,
MCP 4c5756f). See deploy/README.md for verification and network limitations.
Former OAuth clients must replace saved credentials with an API key.
Website Google and email OTP login remain available.

JWTs/other token formats are rejected before contacting the site. API keys
are verified on every private request through /api/mcp/access. Authentication
failures use a plain Bearer challenge with API-key guidance. OAuth metadata
and authorization-server discovery are no longer exposed.

| Tool | Behavior |
| --- | --- |
| get_credits | Account Credits; connection limit fields are null |
| get_task | Owner-private task by taskId or original idempotencyKey |
| read_asset | Private metadata or bounded derived WebP preview |
| quote_generation | Five-minute single-image quote; no consumption |
| generate_image | Submit a quote with a durable idempotency key |

The five public discovery tools remain anonymous. Modern and 2025-era MCP
transport support remains; only OAuth authentication is removed.

## Generation

Use list_models for available image models/options and show quoted Credits
before submission. API keys use account Credits with no connection caps.
Null limit fields never mean free generation. Submit only quoteId and a key
matching `[A-Za-z0-9_-]{16,128}`; retain it after timeout and recover using
get_task. Respect retryAfterSeconds when polling.

The site owns quote/key validation, Task creation, Billing and R2. Unknown
consumption stays awaiting_credit. Success requires committed owned assets.
The MCP service never accesses a database or generation provider directly.

## Deployment and Testing

Deploy with matching API-key-only site code. Preserve historical migration
files/tables and ownership relations; this removal needs no new migration.
Keep /mcp routed to this service, /api/mcp/* and /account/api-keys to the site.
MCP_RESOURCE_URL is obsolete; retain INSPIA_BASE_URL and MCP_ACCOUNT_ENABLED.

`bun run check` verifies keys, JWT rejection, absent OAuth discovery, scoped
boundaries, output projection and public protocol compatibility.
`MCP_SMOKE_URL=https://inspia.ai/mcp bun run test:live` tests public discovery.
Site docs/MCP_1_0.md describes isolated key and generation integration tests.

Disable MCP_ACCOUNT_ENABLED for discovery-only operation, or the site's
INSPIA_MCP_GENERATION_ENABLED to stop new generations. Keep the Task worker
running so accepted tasks finish or refund. Paid live tests need authorization.
