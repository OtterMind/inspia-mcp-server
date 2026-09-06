# Production Operations

Verified on 2026-09-07. Public endpoint: **https://inspia.ai/mcp**.

## Installed Layout

| Item | Location |
| --- | --- |
| Host | Existing Inspia host, `47.89.251.12` |
| Application source revision | `8c39eeb3f1cdce86d44dd52c01ae37a4161652da` |
| Release | `/opt/inspia-mcp/releases/8c39eeb` |
| Previous release retained for rollback | `/opt/inspia-mcp/releases/2c01ea2` |
| Active release symlink | `/opt/inspia-mcp/current` |
| Pinned runtime | `/opt/inspia-mcp/runtime/bun`, version 1.3.14, Linux x64 baseline |
| Service | `inspia-mcp.service`, non-login user/group `inspia-mcp` |
| Private environment | `/etc/inspia-mcp.env`, root-owned mode 0600 |
| Listener | `127.0.0.1:8788` |
| Site configuration | `/etc/nginx/conf.d/promptguide.conf` |
| HTTP rate-limit zone | `/etc/nginx/conf.d/inspia-mcp-limits.conf` |
| Exact location include | `/etc/nginx/snippets/inspia-mcp-location.conf` |
| First-deployment site backup | `/opt/inspia-mcp/backups/initial-2c01ea2/promptguide.conf` |

The deployed application came from the clean Git archive of the revision above.
Production dependencies were installed from the frozen lockfile on the server,
then the bundle was built on Linux. Service/proxy files are maintained alongside
this document; they are deployment assets, separate from that application revision.

Bun was downloaded from the official `oven-sh/bun` release `bun-v1.3.14`.
`bun-linux-x64-baseline.zip` was checked against the published `SHASUMS256.txt`:

```text
a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7
```

## Process and Network Boundaries

The website and MCP share a host and HTTPS endpoint, not a process. Deployment
did not restart `promptguide.service` or any Task/Catalog worker. No database
credentials, migrations, private APIs or generation providers are needed.

The MCP service starts at boot, restarts on failure, and is limited to 512 MiB
memory and one CPU's quota. It can read its root-owned release but cannot modify
system files. Its cursor secret is generated once on the host and is never
printed or included in release archives.

Nginx applies 60 requests/minute per client IP with a burst of 20. Only published
Cloudflare IP ranges are trusted for `CF-Connecting-IP`, and this real-IP
configuration is scoped to `/mcp`. Refresh those ranges when Cloudflare changes
them. The process itself sees the local proxy peer and applies an aggregate
600 requests/minute limit with up to 8 concurrent tool requests.

The HTTPS server includes:

```nginx
include /etc/nginx/snippets/inspia-mcp-location.conf;
```

Preserve this line when updating or replacing the main site's Nginx template.
Keep the rate-limit file in HTTP context and the location file inside the
`inspia.ai` HTTPS server. Do not expose port 8788 on a public interface.

## Verification

The pagination update passed GitHub CI run `34045932928` for the exact source
revision above. A candidate service on loopback port 8790 passed the five-tool
smoke and seven boundary checks before the active symlink was switched.

After switching production, the public endpoint passed both suites again:
the 360-character Chinese query produced a 2,466-character cursor and three
pages with nine distinct IDs. A real v1 cursor issued before deployment still
worked afterward, with no overlap between its first and second page. Codex's
native MCP tools also successfully paginated the long query against production.

Production cursor/pagination source hashes matched the local release. MCP was
active with zero automatic restarts; the website retained its prior process and
returned HTTP 200. No Nginx configuration or environment secrets changed during
this patch deployment. The temporary candidate service and SSH tunnel were
removed after validation.

The source revision identifies the application; later documentation-only commits
do not require restarting it. The service still advertises package version 0.1.0.

The initial release passed:

- GitHub CI run `34040339309`, plus local lint, typecheck, 16 tests and build.
- Server-local process health and full public-data MCP smoke through an SSH tunnel.
- `nginx -t` before a graceful Nginx reload.
- Full smoke through `https://inspia.ai/mcp`: all five tools, Chinese search,
  signed next-page cursors, changed-filter rejection, modern MCP and legacy
  initialization/tool calls.
- The website's homepage still returned HTTP 200 and its application PID stayed
  unchanged during deployment.

Run the existing public read-only smoke from a development checkout:

```sh
MCP_SMOKE_URL=https://inspia.ai/mcp bun run test:live
```

The public URL responds with 405 to browser GET requests by design. Tools use
POST. `/healthz` is available on the loopback listener only, and indicates process
liveness rather than upstream readiness.

Server-side inspection:

```sh
systemctl status inspia-mcp
journalctl -u inspia-mcp -n 50 --no-pager
curl -fsS http://127.0.0.1:8788/healthz
```

Do not print the environment file while diagnosing failures.

## Subsequent Releases

Deployments require an explicit operator request; pushing Git does not publish.

1. Use a clean, reviewed revision with passing CI. Keep the existing environment
   and cursor secret; do not generate a new secret on every release.
2. Extract that revision into a new `/opt/inspia-mcp/releases/<revision>` directory.
   Set `PATH=/opt/inspia-mcp/runtime:$PATH`, run
   `bun install --frozen-lockfile --production`, then `bun run build`.
3. Preserve root ownership and grant the `inspia-mcp` group read/traverse access.
   Validate the candidate on a separate loopback port before switching `current`.
4. Record the previous symlink, switch it atomically, and restart only
   `inspia-mcp.service`. Run the public smoke again; restore the previous symlink
   and restart MCP if verification fails.
5. Nginx changes need their own backup, `nginx -t` and graceful reload. Preserve
   unrelated site edits and confirm the website remains healthy.

## Initial-Deployment Rollback

For an immediate rollback of this initial deployment, compare the active Nginx
site with the backup first. If unrelated site changes were made afterward,
remove only the MCP include instead of restoring the entire old file.

When no later site changes exist:

```sh
cp -p /opt/inspia-mcp/backups/initial-2c01ea2/promptguide.conf /etc/nginx/conf.d/promptguide.conf
nginx -t && systemctl reload nginx
systemctl disable --now inspia-mcp.service
```

The unused limit-zone and snippet files can remain. Retain the private environment,
release and backups for recovery. This rollback does not restart the Inspia app.
