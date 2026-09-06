import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { z } from "zod";
import cases from "../evals/discovery-cases.json";
import { detailOutput, searchOutput } from "../src/schemas";

const endpoint = new URL(process.env.MCP_SMOKE_URL ?? "https://inspia.ai/mcp");
if (
  endpoint.protocol !== "https:" &&
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
)
  throw new Error("Use HTTPS or loopback");
const directory = resolve(".validation", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(directory, { recursive: true });
const client = new Client(
  { name: "inspia-discovery-verification", version: "0.1.0" },
  { versionNegotiation: { mode: "auto" } },
);
const results: Array<Record<string, unknown>> = [];
const details = new Map<string, z.infer<typeof detailOutput>["prompt"]>();
const metadataProblems: string[] = [];
let calls = 0;
let lastCallAt = 0;

async function call(name: string, args: Record<string, unknown>) {
  await Bun.sleep(Math.max(0, 1500 - (Date.now() - lastCallAt)));
  lastCallAt = Date.now();
  calls++;
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const latencyMs = Math.round(performance.now() - started);
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return { data: result.structuredContent, latencyMs };
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  for (const sample of cases) {
    const { id, intent, expectedFirstId, ...args } = sample;
    try {
      const response = await call("search_prompts", { ...args, limit: 3 });
      const data = searchOutput.parse(response.data);
      const issues: string[] = [];
      if (new Set(data.items.map((item) => item.id)).size !== data.items.length)
        issues.push("duplicate_ids");
      if (data.items.some((item) => item.mediaType !== args.mediaType))
        issues.push("media_filter_mismatch");
      if (args.subcategory && data.items.some((item) => item.subcategory !== args.subcategory))
        issues.push("subcategory_filter_mismatch");
      if (data.items.some((item) => !item.creator?.name || !item.creator.handle || !item.sourceUrl))
        issues.push("missing_attribution");
      if (data.items.some((item) => item.width <= 0 || item.height <= 0))
        issues.push("missing_dimensions");
      if (expectedFirstId && data.items[0]?.id !== expectedFirstId)
        issues.push("exact_title_not_first");
      for (const item of data.items) {
        if (item.category === "images" && item.mediaType !== "image")
          issues.push("category_media_mismatch");
      }
      results.push({
        id,
        intent,
        args,
        latencyMs: response.latencyMs,
        searchMode: data.searchMode,
        degraded: data.degraded,
        issues,
        items: data.items,
        hasMore: data.hasMore,
      });
      console.info(
        `${id}: ${data.items.length} results, ${data.searchMode}, ${response.latencyMs}ms, ${issues.length} contract issues`,
      );
    } catch (error) {
      results.push({ id, intent, args, error: String(error) });
      console.info(`${id}: FAILED`);
    }
  }
  // Read top results for semantic review; this is evidence, not an automated relevance score.
  const selected = new Set<string>(["x-2053716739624468964"]);
  for (const result of results) {
    const items = result.items as z.infer<typeof searchOutput>["items"] | undefined;
    if (items?.[0]) selected.add(items[0].id);
  }
  for (const promptId of selected) {
    try {
      const response = await call("get_prompt", { promptId });
      const { prompt } = detailOutput.parse(response.data);
      if (!prompt.originalPrompt.trim())
        metadataProblems.push(`${promptId}: empty original prompt`);
      details.set(promptId, prompt);
      console.info(`detail: ${promptId}, ${prompt.originalPrompt.length} chars`);
    } catch (error) {
      metadataProblems.push(`${promptId}: ${String(error)}`);
    }
  }
} finally {
  await client.close();
  const report = {
    checkedAt: new Date().toISOString(),
    endpoint: endpoint.href,
    protocolClient: "@modelcontextprotocol/client@2.0.0",
    casesHash: createHash("sha256").update(JSON.stringify(cases)).digest("hex"),
    calls,
    evaluation:
      "Contract assertions plus ungraded relevance evidence. Titles and taxonomy are not a relevance ground truth; inspect full prompts and media separately.",
    results,
    details: Object.fromEntries(details),
    metadataProblems,
  };
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  console.info(`Report: ${directory}/report.json`);
}
if (results.some((r) => r.error || (r.issues as string[])?.length) || metadataProblems.length)
  process.exitCode = 1;
