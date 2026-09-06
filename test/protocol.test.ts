import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { fakeUpstream, originalPrompt } from "./fixtures";

function setup(extra: Record<string, string> = {}) {
  const upstream = fakeUpstream();
  const config = loadConfig({ MCP_CURSOR_SECRET: "x".repeat(32), ...extra });
  const app = createApp(config, upstream.fetcher);
  const versions: string[] = [];
  const fetcher = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    // A real HTTP connection supplies Host; the in-process fetch substitute must do so too.
    request.headers.set("Host", new URL(request.url).host);
    versions.push(request.headers.get("MCP-Protocol-Version") ?? "initialize");
    return app.fetch(request);
  };
  return { app, fetcher, calls: upstream.calls, versions };
}
const endpoint = new URL("http://localhost:8788/mcp");
const expectedTools = [
  "search_prompts",
  "get_prompt",
  "find_related_prompts",
  "list_prompt_filters",
  "list_models",
];

describe("MCP clients over real SDK HTTP transports", () => {
  test("SDK v2 negotiates modern MCP and calls all five tools", async () => {
    const { app, fetcher, versions } = setup();
    const client = new Client(
      { name: "modern-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(endpoint, { fetch: fetcher });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(versions).toContain("2026-07-28");
      expect(tools.tools.map((x) => x.name)).toEqual(expectedTools);
      for (const tool of tools.tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.outputSchema).toBeDefined();
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(JSON.stringify(tool.outputSchema)).not.toMatch(/"type":\[/);
      }
      const search = await client.callTool({ name: "search_prompts", arguments: { limit: 1 } });
      expect(search.isError).not.toBe(true);
      expect((search.structuredContent as { hasMore: boolean }).hasMore).toBe(true);
      const detail = await client.callTool({
        name: "get_prompt",
        arguments: { promptId: "fixture-poster" },
      });
      expect(detail.isError).not.toBe(true);
      expect(
        (detail.structuredContent as { prompt: { originalPrompt: string } }).prompt.originalPrompt,
      ).toBe(originalPrompt);
      for (const [name, args] of [
        ["find_related_prompts", { promptId: "fixture-poster" }],
        ["list_prompt_filters", { mediaType: "image" }],
        ["list_models", {}],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toBeDefined();
      }
    } finally {
      await client.close();
      await app.close();
    }
  });

  test("SDK v1 initializes and reads structured results with 2025-era protocol", async () => {
    const { app, fetcher, versions } = setup();
    const client = new LegacyClient({ name: "legacy-test", version: "1.0.0" });
    const transport = new LegacyTransport(endpoint, { fetch: fetcher });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.version).toBe("0.1.0");
      expect((await client.listTools()).tools.map((x) => x.name)).toEqual(expectedTools);
      expect(versions).toContain("2025-11-25");
      expect(
        (await client.callTool({ name: "get_prompt", arguments: { promptId: "fixture-poster" } }))
          .isError,
      ).not.toBe(true);
    } finally {
      await client.close();
      await app.close();
    }
  });

  test("strict schemas, unknown tools, invalid cursor and not found never call private APIs", async () => {
    const { app, fetcher, calls } = setup();
    const client = new Client({ name: "validation-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: fetcher }));
      for (const args of [
        { limit: 21 },
        { query: "x".repeat(501) },
        { userId: "other" },
        { limit: "2" },
        { cursor: "bad" },
      ]) {
        const result = await client.callTool({ name: "search_prompts", arguments: args });
        expect(result.isError).toBe(true);
      }
      expect(calls).toHaveLength(0);
      const result = await client.callTool({
        name: "get_prompt",
        arguments: { promptId: "missing" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("NOT_FOUND");
      expect(JSON.stringify(result)).not.toContain("do-not-return");
      await expect(client.callTool({ name: "generate_image", arguments: {} })).rejects.toThrow();
    } finally {
      await client.close();
      await app.close();
    }
  });
});

describe("HTTP boundary", () => {
  test("exact Origin and Host allowlists, credential rejection and CORS", async () => {
    const { app, calls } = setup();
    try {
      const request = (headers: Record<string, string> = {}, url: string | URL = endpoint) =>
        new Request(url, {
          method: "POST",
          headers: { Host: new URL(url).host, ...headers },
          body: "{}",
        });
      expect((await app.fetch(request({ Origin: "https://evil.example" }))).status).toBe(403);
      expect((await app.fetch(request({ Host: "evil.example" }))).status).toBe(403);
      expect((await app.fetch(request({}, "http://evil.example/mcp"))).status).toBe(403);
      expect((await app.fetch(request({ Authorization: "Bearer never-forward" }))).status).toBe(
        400,
      );
      const cors = await app.fetch(
        new Request(endpoint, {
          method: "OPTIONS",
          headers: { Host: endpoint.host, Origin: "http://localhost:8788" },
        }),
      );
      expect(cors.status).toBe(204);
      expect(cors.headers.get("access-control-allow-origin")).toBe("http://localhost:8788");
      expect(cors.headers.get("cache-control")).toBe("private, no-store");
      expect(calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  test("body bounds, per-peer rate limit, health and kill switch", async () => {
    const { app } = setup({ MCP_RATE_LIMIT: "1" });
    const disabled = setup({ MCP_ENABLED: "false" });
    try {
      const post = (body = "{}") =>
        new Request(endpoint, {
          method: "POST",
          headers: { Host: endpoint.host, "Content-Type": "application/json" },
          body,
        });
      expect((await app.fetch(post("x".repeat(65537)), "large")).status).toBe(413);
      await app.fetch(post(), "peer");
      const limited = await app.fetch(post(), "peer");
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(
        (await app.fetch(new Request(endpoint, { headers: { Host: endpoint.host } }))).status,
      ).toBe(405);
      expect(
        (
          await app.fetch(
            new Request("http://localhost:8788/healthz", { headers: { Host: endpoint.host } }),
          )
        ).status,
      ).toBe(200);
      expect((await disabled.app.fetch(post())).status).toBe(503);
    } finally {
      await app.close();
      await disabled.app.close();
    }
  });
});
