# Inspia MCP Server

Read-only discovery of Inspia's attributed image and video prompts over remote
MCP Streamable HTTP. This repository implements **0.1 Discovery**, the first
milestone of the Inspia MCP design.

It reads the existing public Inspia APIs. It does not require a database,
account, provider key, or private API, and cannot generate media or spend Credits.

## Run

Requires Bun 1.3.14 or later.

```sh
bun install --frozen-lockfile
bun run dev
```

The default endpoint is `http://127.0.0.1:8788/mcp`. Configuration is optional for
local use; available variables are documented in `.env.example`.

For a compiled local service:

```sh
bun run build
bun run start
```

`GET /healthz` reports process liveness, not upstream readiness. `GET /` returns
service metadata. There is no website UI or legacy `/sse` endpoint.

## Connect

For MCP clients supporting the `mcpServers` remote URL format:

```json
{
  "mcpServers": {
    "inspia": {
      "url": "http://127.0.0.1:8788/mcp"
    }
  }
}
```

Client configuration formats differ. Select **Streamable HTTP**, use the `/mcp`
URL, and leave authentication empty. This service rejects Authorization headers;
do not paste account cookies, provider keys, or personal tokens into it.

Try: "Find three minimalist product photography references on Inspia, then show
the full prompt and original source for one."

Supported protocol implementation:

- MCP `2026-07-28`, using official `@modelcontextprotocol/server@2.0.0`.
- Stateless compatibility with `2025-11-25` clients through the same SDK factory.
- No protocol sessions, standalone GET event streams, stdio server, MCP Apps,
  sampling, or task extension. GET/DELETE on `/mcp` return 405.

Official SDK v2 and v1 HTTP clients are tested separately. This is not a claim
that every desktop host renders image URLs or supports every protocol version.

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `search_prompts` | Optional query, mediaType, subcategory, subject, sourceModel, sort, cursor; limit 1–20 (default 6) | Published summaries, media dimensions, preview URLs, attribution, canonical/use links, signed pagination |
| `get_prompt` | promptId | Complete original prompt, separately labeled existing translations, all public media and source attribution |
| `find_related_prompts` | promptId; limit 1–8 (default 6) | Existing Inspia related recommendations |
| `list_prompt_filters` | Optional mediaType | Published categories plus supported subject/source-model filters with live nonzero counts |
| `list_models` | Optional taskType | Website model availability, parameter schemas, defaults, catalog version and input limits |

All tools have strict input schemas, explicit output schemas, structured results,
text fallbacks and read-only annotations. `sourceModel` describes the original
creator's model; it is unrelated to current website generation availability.

Search with `query` always uses relevance. `sort` is for browsing without a query;
`popular` means imported X metrics. A `subcategory` requires `mediaType`. Obtain
the accepted source-model keys and published subcategories from
`list_prompt_filters`. Cursor requests must preserve filters and page size.

The public list API does not expose prompt excerpts, so `promptExcerpt` is null.
Use `get_prompt` for text. Original prompts are not truncated or silently rewritten.
Imported text is untrusted content, not instructions to the consuming assistant.

## Data boundaries

All reads go to an operator-configured Inspia origin (default `https://inspia.ai`):

| Public endpoint | Usage |
| --- | --- |
| `GET /api/prompts` | Search, deterministic browse and filter counts |
| `GET /api/prompts/:id` | Full public prompt and existing related results |
| `GET /llms.txt` | Published category routes, parsed with a Markdown AST |
| `GET /api/task-types` | Live website generation model options and availability |

No main-site code, credentials, database schema or runtime is changed by this
repository. It does not scrape HTML, copy the catalog, contact generation
providers or download media. Each response uses a whitelisted DTO; upstream
provenance internals and unexpected properties are discarded.

Current upstream constraints are deliberate:

- Related recommendations are limited to 8 by the public detail API.
- Subject and source-model vocabulary is an explicit API contract snapshot from
  Inspia `fec2f43`, verified against live nonzero counts, not inferred from a
  sample. Maintain `src/filter-vocabulary.ts` when that public vocabulary changes.
  Category routes come from the live machine-readable index and use its
  publication threshold; they do not include unpublished categories.
- Category and facet reads are coalesced and cached for 5 minutes. A cold
  filter query makes up to 10 count requests with concurrency capped at 3.
- Model availability is read on every call. Stale/disabled catalog state forces
  unavailable. Authoritative per-model capability hashes and exact quotes are
  not in the public API, so `capabilityHash` is explicitly null. This service
  never substitutes a locally computed hash.
- Search returns `hasMore` and `nextCursor`, not the upstream's misleading
  candidate-count-as-total. Keyword fallback is reported as `degraded` when
  appropriate. Upstream errors remain errors, not empty successes.
- Cursors expire after 15 minutes, bind to upstream origin and normalized
  filters/page size, and are HMAC signed. They do not provide a snapshot across
  catalog publications. Keep `MCP_CURSOR_SECRET` stable across replicas/restarts;
  without it, a local restart intentionally invalidates existing cursors.

## Verification

```sh
bun run lint
bun run typecheck
bun run test
bun run build
```

Tests use fixture public responses, official modern and legacy HTTP transports,
and the production request handler. They need no database or external network.
CI runs these same checks.

With the local service running, this opt-in smoke test calls all five tools,
Chinese search, pagination, cursor rejection and legacy initialization against
the real public Inspia catalog:

```sh
bun run test:live
```

Set `MCP_SMOKE_URL` to test a different MCP endpoint. The smoke makes only public
read requests. It does not submit generation or consume Credits.

## Deployment

This service is independently deployable. The proposed public
`https://inspia.ai/mcp` URL is **not deployed by this repository**; route it to
this service using the website's reverse proxy when deployment is authorized.
Only proxy the exact `/mcp` path; the existing Next.js site keeps all other routes.

For a public listener, configure these values in the runtime secret/environment
store (never in Git):

```text
MCP_HOST=0.0.0.0
MCP_PORT=8788
MCP_ALLOWED_HOSTS=inspia.ai
MCP_ALLOWED_ORIGINS=https://inspia.ai
MCP_CURSOR_SECRET=<32-or-more-random-characters>
```

TLS terminates at the reverse proxy. Preserve the public Host and MCP headers.
Requests without Origin, as used by server-side MCP clients, are accepted;
present Origin headers must match the exact configured list. Add approved
browser client origins explicitly if required, never `*`.

The process enforces a 64 KiB request limit, a 2 MiB upstream response limit,
15-second upstream timeout, a 1 MiB tool payload limit, a concurrent request
limit, and per-socket-peer rate limiting (default 60 POSTs/minute). It never trusts
client-supplied forwarding headers. Behind a reverse proxy, all traffic may share
the proxy peer quota: configure the proxy's real-client-IP rate limiter and tune
the process's aggregate limit accordingly. Per-process limits are not global
across replicas. Apply an edge limit for public deployments.

`MCP_ENABLED=false` disables the MCP route without hiding process health.
Responses use `private, no-store`. No prompt bodies, credentials or upstream
error bodies are logged. Container packaging is supplied in `Dockerfile`:

```sh
docker build -t inspia-mcp-server .
docker run --rm --env-file .env -p 127.0.0.1:8788:8788 inspia-mcp-server
```

Set the public-listener variables above before running the container, and allow
the hostnames used by your local checks as needed. A missing production cursor
secret or host allowlist fails startup.

## Next boundary

OAuth, private media, Credits, quotes and generation belong to the later Create
milestone. They require coordinated changes to the Inspia application, not
proxying website cookies through this read-only service.
