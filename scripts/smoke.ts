import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.MCP_SMOKE_URL ?? "http://127.0.0.1:8788/mcp");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) &&
  endpoint.protocol !== "https:"
)
  throw new Error("Remote MCP smoke endpoints must use HTTPS");
const modern = new Client(
  { name: "inspia-live-smoke", version: "0.1.0" },
  { versionNegotiation: { mode: "auto" } },
);
const legacy = new LegacyClient({ name: "inspia-legacy-smoke", version: "0.1.0" });
try {
  await modern.connect(new StreamableHTTPClientTransport(endpoint));
  const tools = await modern.listTools();
  assert.equal(tools.tools.length, 5);
  const search = await modern.callTool({ name: "search_prompts", arguments: { limit: 2 } });
  assert.ok(!search.isError, JSON.stringify(search));
  const data = search.structuredContent as {
    items: { id: string; canonicalUrl: string; sourceUrl: string | null }[];
    nextCursor: string | null;
  };
  const first = data.items[0];
  assert.ok(first, "The live catalog must contain a published prompt");
  assert.match(first.canonicalUrl, /^https:\/\/inspia\.ai\/prompt\//);
  for (const [name, args] of [
    ["get_prompt", { promptId: first.id }],
    ["find_related_prompts", { promptId: first.id, limit: 2 }],
    ["list_prompt_filters", { mediaType: "image" }],
    ["list_models", {}],
    ["search_prompts", { query: "极简 产品 摄影", limit: 2 }],
  ] as const) {
    const result = await modern.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
    assert.ok(result.structuredContent);
    console.info(`PASS modern ${name}`);
  }
  if (data.nextCursor) {
    const page = await modern.callTool({
      name: "search_prompts",
      arguments: { limit: 2, cursor: data.nextCursor },
    });
    assert.ok(!page.isError, JSON.stringify(page));
    const second = page.structuredContent as { items: { id: string }[] };
    assert.ok(second.items.every((x) => !data.items.some((y) => y.id === x.id)));
    const invalid = await modern.callTool({
      name: "search_prompts",
      arguments: { query: "different", limit: 2, cursor: data.nextCursor },
    });
    assert.equal(invalid.isError, true);
    console.info("PASS signed pagination and changed-filter rejection");
  }
  await legacy.connect(new LegacyTransport(endpoint));
  assert.equal((await legacy.listTools()).tools.length, 5);
  const legacyResult = await legacy.callTool({
    name: "get_prompt",
    arguments: { promptId: first.id },
  });
  assert.ok(!legacyResult.isError);
  console.info("PASS legacy initialize, tools/list and get_prompt");
  console.info(
    `Read-only live smoke passed against ${endpoint.origin}. No generation, account or paid tools were called.`,
  );
} finally {
  await modern.close();
  await legacy.close();
}
