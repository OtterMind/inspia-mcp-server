import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { searchOutput } from "../src/schemas";

const endpoint = new URL(process.env.MCP_SMOKE_URL ?? "https://inspia.ai/mcp");
if (
  endpoint.protocol !== "https:" &&
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
)
  throw new Error("Use HTTPS or loopback");
const client = new Client(
  { name: "inspia-boundary-verification", version: "0.1.0" },
  { versionNegotiation: { mode: "auto" } },
);
const checks: Array<{ name: string; passed: boolean; evidence: unknown }> = [];
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  for (const [name, tool, args] of [
    ["reject excessive limit", "search_prompts", { limit: 21 }],
    ["reject excessive query", "search_prompts", { query: "x".repeat(501) }],
    ["reject unknown fields", "search_prompts", { userId: "someone-else" }],
    ["reject malformed cursor", "search_prompts", { cursor: "bad" }],
    [
      "reject incompatible model/media",
      "search_prompts",
      { mediaType: "video", sourceModel: "gpt-image-2" },
    ],
    [
      "missing prompt is error",
      "get_prompt",
      { promptId: "inspia-verification-does-not-exist-8eaf7610" },
    ],
  ] as const) {
    const result = await client.callTool({ name: tool, arguments: args });
    checks.push({ name, passed: result.isError === true, evidence: result.content });
    await Bun.sleep(1500);
  }
  const query = "极简产品摄影".repeat(60);
  const first = await client.callTool({
    name: "search_prompts",
    arguments: { query, mediaType: "image", limit: 3 },
  });
  if (first.isError)
    checks.push({
      name: "accepted long query remains pageable",
      passed: false,
      evidence: { queryChars: query.length, firstPageError: first.content },
    });
  else {
    const page = searchOutput.parse(first.structuredContent);
    if (page.nextCursor) {
      let cursor: string | null = page.nextCursor;
      let pageCount = 1;
      let nextPageError: unknown = null;
      const ids = page.items.map((item) => item.id);
      while (cursor && pageCount < 3) {
        await Bun.sleep(1500);
        const next = await client.callTool({
          name: "search_prompts",
          arguments: { query, mediaType: "image", limit: 3, cursor },
        });
        if (next.isError) {
          nextPageError = next.content;
          break;
        }
        const nextPage = searchOutput.parse(next.structuredContent);
        ids.push(...nextPage.items.map((item) => item.id));
        cursor = nextPage.nextCursor;
        pageCount++;
      }
      const uniqueResultCount = new Set(ids).size;
      checks.push({
        name: "accepted long query remains pageable",
        passed: nextPageError === null && uniqueResultCount === ids.length,
        evidence: {
          queryChars: query.length,
          cursorChars: page.nextCursor.length,
          firstPageCount: page.items.length,
          pageCount,
          uniqueResultCount,
          duplicateIds: ids.length - uniqueResultCount,
          nextPageError,
        },
      });
    } else
      checks.push({
        name: "accepted long query remains pageable",
        passed: false,
        evidence: "Inconclusive: no next page available for this query",
      });
  }
} finally {
  await client.close();
  const directory = resolve(".validation", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "boundaries.json"),
    JSON.stringify(
      { checkedAt: new Date().toISOString(), endpoint: endpoint.href, checks },
      null,
      2,
    ),
  );
  console.info(
    JSON.stringify(
      {
        passed: checks.filter((c) => c.passed).length,
        failed: checks.filter((c) => !c.passed).length,
        checks,
        report: resolve(directory, "boundaries.json"),
      },
      null,
      2,
    ),
  );
}
if (checks.some((check) => !check.passed)) process.exitCode = 1;
