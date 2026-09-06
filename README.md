# Inspia MCP Server

Read-only discovery of Inspia's attributed image and video prompts over remote
MCP Streamable HTTP. This repository implements **0.1 Discovery**, the first
milestone of the Inspia MCP design.

**Production endpoint: [https://inspia.ai/mcp](https://inspia.ai/mcp)**

Connect with **Streamable HTTP**, without an account or API key. No local server,
Bun installation, or npm package is needed to use the hosted service. It reads
public Inspia data and cannot generate media, access private accounts or spend Credits.

## Connect with Codex

Add the production server using the Codex CLI:

```sh
codex mcp add inspia --url https://inspia.ai/mcp
codex mcp get inspia --json
```

Alternatively, open **Settings > MCP servers > Add server** in the desktop app:

| Setting | Value |
| --- | --- |
| Name | `inspia` |
| Transport | Streamable HTTP |
| URL | `https://inspia.ai/mcp` |
| Authentication | None |

After adding or changing the server, select **Restart** in MCP settings to reload
the connection. A saved configuration does not mean an already-running task has
loaded the tools. Use `/mcp` to inspect connected servers.

Ask Codex:

> Use the inspia MCP to find three minimalist product photography prompts. Read
> the full text of one, preserving the creator and original source links. Call
> MCP tools directly; do not use a terminal to request the APIs.

Chinese queries also work:

> 使用 inspia MCP 搜索 3 个极简产品摄影提示词，然后读取其中一个的完整提示词，保留作者和来源链接。请直接调用 MCP，不要通过终端请求 API。

The expected calls are `search_prompts`, followed by `get_prompt` using a returned
ID. This flow was verified directly in Codex against the production endpoint on
2026-09-06, including original text, attribution and a reference image preview.

See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)
for host-specific configuration details.

## Connect with Other Clients

For MCP clients supporting the `mcpServers` remote URL format:

```json
{
  "mcpServers": {
    "inspia": {
      "url": "https://inspia.ai/mcp"
    }
  }
}
```

Client configuration formats differ. Select **Streamable HTTP**, use the `/mcp`
URL, and leave authentication empty. This service rejects Authorization headers;
do not paste account cookies, provider keys, or personal tokens into it.

Opening `/mcp` in a browser returns **405 Method Not Allowed** by design: MCP
clients send POST requests. There is no HTML landing page at this endpoint.

## Protocol Compatibility

Supported protocol implementation:

- MCP `2026-07-28`, using official `@modelcontextprotocol/server@2.0.0`.
- Stateless compatibility with `2025-11-25` clients through the same SDK factory.
- No protocol sessions, standalone GET event streams, stdio server, MCP Apps,
  sampling, or task extension. GET/DELETE on `/mcp` return 405.

Official SDK v2 and v1 HTTP clients are tested separately. The service has also
passed MCP Inspector 2.5.0 strict schema checks. Image rendering depends on the
host; returning a media URL does not save a file to the user's computer.

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

### Example Tool Call

Call `search_prompts` with:

```json
{
  "query": "minimalist product photography",
  "mediaType": "image",
  "subcategory": "ads-products",
  "limit": 3
}
```

Then call `get_prompt` with a returned `id` as `promptId`. Results include
`originalPrompt`, `creator`, `sourceUrl`, `canonicalUrl` and `mediaItems`. The
original text and existing translations remain separate; results are references,
not a guarantee that a model will reproduce the source image.

## Local Development

Requires Bun 1.3.14 or later:

```sh
git clone https://github.com/OtterMind/inspia-mcp-server.git
cd inspia-mcp-server
bun install --frozen-lockfile
bun run dev
```

The development endpoint is `http://127.0.0.1:8788/mcp`. `bun run dev` watches the
source and restarts when files change. `bun run build` followed by `bun run start`
runs the compiled bundle and does not watch source files.

Configuration is documented in [.env.example](.env.example). Local development
reads the public Inspia APIs by default and needs no database or provider keys.
Use a separate Codex entry to keep your production connection:

```sh
codex mcp add inspia-local --url http://127.0.0.1:8788/mcp
```

`GET /healthz` reports process liveness, not upstream readiness. `GET /` returns
service metadata. These routes are available on the local service; the production
website proxies only `/mcp` to it.

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
- The pending cursor patch emits v2 tokens containing a SHA-256 filter digest
  instead of the full URL-encoded filters. Valid v1 tokens remain readable until
  their original expiry. Input, output and decoder size limits share one contract.
  An upstream cursor over the website's 2,048-character limit produces
  `UPSTREAM_CURSOR_UNSUPPORTED`; it is never dropped to silently restart page one.

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

For a reproducible 24-query discovery sample and a separate boundary check:

```sh
bun run test:discovery
bun run test:boundaries
```

These opt-in commands default to the public production endpoint, pace requests,
and write evidence to ignored `.validation/` directories. Contract checks are
separate from relevance review; successful requests do not establish search
quality. See the [0.1 verification report](docs/verification-0.1-2026-09-07.md).
The deployed 0.1 currently fails the long-Chinese-query pagination boundary check.
The local pending patch passes all seven boundary checks; test it by setting
`MCP_SMOKE_URL` to the locally running patched service. Production remains on the
original release until the patch is deployed.

To check production:

```sh
MCP_SMOKE_URL=https://inspia.ai/mcp bun run test:live
```

For interactive tool testing, start MCP Inspector:

```sh
bunx @modelcontextprotocol/inspector@2.5.0 --web --transport http --server-url https://inspia.ai/mcp
```

Open the local URL printed by Inspector, connect the server, and use the **Tools**
tab to edit arguments and inspect responses. The **Protocol** and **Network**
panels show requests and errors. Inspector's local access token belongs to its
debug UI; never send it as authentication to Inspia. Replace the server URL with
`http://127.0.0.1:8788/mcp` when testing local changes.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Codex cannot see the tools | Confirm the URL with `codex mcp get inspia --json`, then restart the MCP connection in settings. |
| Browser GET returns 405 | Expected; connect with an MCP client using Streamable HTTP. |
| Local connection refused | Start `bun run dev` and check the configured port. Hosted production does not need your local process. |
| HTTP 403 | Check the configured Host and exact Origin allowlists; do not disable them or add wildcards. |
| HTTP 429 | Respect `Retry-After` when present and back off; avoid tight polling loops. |
| `INVALID_CURSOR` | Start a fresh search. Cursors expire and must use the original filters and page size. |
| `UPSTREAM_CURSOR_UNSUPPORTED` | Shorten the query or filters and start a new search. The upstream pagination limit was exceeded; retrying unchanged will not help. |
| `UPSTREAM_UNAVAILABLE` | The public Inspia read failed or timed out; retry later. This is not an empty search result. |

## Deployment

Production is available at **https://inspia.ai/mcp**. It runs as an independent
systemd service on the existing Inspia host, with Nginx forwarding only the exact
`/mcp` path. The Next.js application keeps all other routes and its own process.
See [deployment operations](deploy/README.md) for the installed paths, release,
verification and rollback procedure. Git pushes run CI but do not deploy.

Production uses Bun 1.3.14 directly under systemd, with a loopback listener:

```text
MCP_HOST=127.0.0.1
MCP_PORT=8788
MCP_ALLOWED_HOSTS=inspia.ai,127.0.0.1,localhost
MCP_ALLOWED_ORIGINS=https://inspia.ai
MCP_CURSOR_SECRET=<32-or-more-random-characters>
MCP_RATE_LIMIT=600
MCP_MAX_CONCURRENT=8
```

TLS terminates at the reverse proxy. Preserve the public Host and MCP headers.
Requests without Origin, as used by server-side MCP clients, are accepted;
present Origin headers must match the exact configured list. Add approved
browser client origins explicitly if required, never `*`.

The process enforces a 64 KiB request limit, a 2 MiB upstream response limit,
15-second upstream timeout and a 1 MiB tool payload limit. Production Nginx applies
60 requests/minute per client IP with a burst of 20; the MCP process applies an
aggregate proxy-peer quota of 600 requests/minute and up to 8 concurrent requests.
Per-process limits are not global across replicas. The cursor secret remains in
the host's private environment file, never in Git.

`MCP_ENABLED=false` disables the MCP route without hiding process health.
Responses use `private, no-store`. No prompt bodies, credentials or upstream
error bodies are logged.

### Optional Docker Packaging

The [Dockerfile](Dockerfile) is an alternative to systemd, not the current
production deployment. Before running a container, set `MCP_HOST=0.0.0.0` inside
it, configure explicit allowed hosts and a persistent cursor secret, and retain
the loopback-only host port binding:

```sh
docker build -t inspia-mcp-server .
docker run --rm --env-file .env -p 127.0.0.1:8788:8788 inspia-mcp-server
```

A missing cursor secret or explicit host allowlist fails startup on a
non-loopback listener. Docker packaging has not been validated in this environment.

## Next boundary

OAuth, private media, Credits, quotes and generation belong to the later Create
milestone. They require coordinated changes to the Inspia application, not
proxying website cookies through this read-only service.
