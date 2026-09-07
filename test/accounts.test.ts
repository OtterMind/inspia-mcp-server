import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccountService } from "../src/accounts";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Fetcher } from "../src/upstream";
import { fakeUpstream } from "./fixtures";

function setup() {
  const calls: string[] = [];
  const upstream = fakeUpstream();
  const fixtureId = "c49d6d90-1f54-4d53-a82f-67a85f5012ca";
  const config = loadConfig({
    MCP_ACCOUNT_ENABLED: "true",
    MCP_RESOURCE_URL: "http://localhost:8788/mcp",
    MCP_CURSOR_SECRET: "x".repeat(32),
  });
  const fetcher: Fetcher = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (!path.startsWith("/api/mcp/")) return upstream.fetcher(input, init);
    calls.push(path);
    const token = new Headers(init?.headers).get("authorization");
    if (token === "Bearer revoked")
      return Response.json({ code: "INVALID_TOKEN" }, { status: 401 });
    if (path === "/api/mcp/access")
      return Response.json({
        userId: "user",
        clientId: "client",
        connectionId: "connection",
        scopes:
          token === "Bearer limited"
            ? []
            : ["credits:read", "assets:read", "generation:create", "tasks:read"],
        expiresAt: token?.startsWith("Bearer inspia_sk_") ? null : Date.now() / 1000 + 600,
      });
    if (path === "/api/mcp/credits")
      return Response.json({
        availableCredits: "100",
        perRequestLimit: token?.startsWith("Bearer inspia_sk_") ? null : "10",
        dailyLimit: token?.startsWith("Bearer inspia_sk_") ? null : "50",
        dailyRemaining: token?.startsWith("Bearer inspia_sk_") ? null : "40",
        checkedAt: new Date().toISOString(),
        internalSecret: "must-not-leak",
      });
    if (path === "/api/mcp/quotes")
      return Response.json({
        quoteId: fixtureId,
        type: "image_generation",
        credits: "2",
        pricingVersion: "price-version",
        capabilityHash: "live-hash",
        catalogVersion: "catalog-v1",
        normalizedInput: {
          prompt: "Exact original prompt",
          model: "test/image",
          options: { count: 1 },
          modelConfigSnapshot: { secret: "must-not-leak" },
        },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      });
    if (path === "/api/mcp/tasks" || path === "/api/mcp/generate")
      return Response.json({
        id: fixtureId,
        workflowId: fixtureId,
        type: "image_generation",
        status: "queued",
        stage: "awaiting_credit",
        input: {
          prompt: "Exact original prompt",
          model: "test/image",
          options: { count: 1 },
          modelConfigSnapshot: { secret: "must-not-leak" },
        },
        output: null,
        errorCode: null,
        errorRetryable: false,
        reservedPoints: "2",
        billingCreditStatus: "unknown",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        assets: [],
        taskUrl: "https://inspia.ai/tasks",
        retryAfterSeconds: 5,
        providerRequestId: "must-not-leak",
      });
    if (path.startsWith("/api/mcp/assets/"))
      return Response.json({
        id: path.split("/").pop(),
        kind: "image",
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        bytes: 4000,
        downloadEndpoint: "https://inspia.ai/api/mcp/assets/asset",
        authRequired: true,
        storageKey: "must-not-leak",
        preview: { mimeType: "image/webp", width: 32, height: 32, derived: true, data: "YWJj" },
      });
    throw new Error("Unexpected endpoint");
  };
  const app = createApp(config, fetcher);
  const transportFetch =
    (token?: string): Fetcher =>
    async (input, init) => {
      const request = new Request(input, init);
      request.headers.set("Host", "localhost:8788");
      if (token) request.headers.set("Authorization", token);
      return app.fetch(request);
    };
  return { app, calls, transportFetch, config, fetcher };
}
for (const legacy of [false, true])
  test(`${legacy ? "legacy" : "modern"} account tools validate outputs and preserve anonymous discovery`, async () => {
    const { app, transportFetch } = setup();
    const client = legacy
      ? new LegacyClient({ name: "test", version: "1" })
      : new Client({ name: "test", version: "1" });
    const url = new URL("http://localhost:8788/mcp");
    try {
      await client.connect(
        legacy
          ? new LegacyTransport(url, { fetch: transportFetch("Bearer valid") })
          : new StreamableHTTPClientTransport(url, { fetch: transportFetch("Bearer valid") }),
      );
      expect((await client.listTools()).tools).toHaveLength(10);
      const credits = await client.callTool({ name: "get_credits", arguments: {} });
      expect(credits.isError).not.toBe(true);
      expect(JSON.stringify(credits)).not.toContain("must-not-leak");
      const asset = await client.callTool({
        name: "read_asset",
        arguments: { assetId: "c49d6d90-1f54-4d53-a82f-67a85f5012ca", representation: "preview" },
      });
      expect(asset.isError).not.toBe(true);
      expect(asset.content).toHaveLength(2);
      expect(JSON.stringify(asset.structuredContent)).not.toContain("YWJj");
      expect(JSON.stringify(asset)).not.toContain("must-not-leak");
      for (const [name, args] of [
        ["get_task", { taskId: "c49d6d90-1f54-4d53-a82f-67a85f5012ca" }],
        ["quote_generation", { modelId: "test/image", prompt: "Exact original prompt" }],
        [
          "generate_image",
          { quoteId: "c49d6d90-1f54-4d53-a82f-67a85f5012ca", idempotencyKey: "same-original-key" },
        ],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).not.toContain("must-not-leak");
      }
      expect(
        (
          await client.callTool({
            name: "generate_image",
            arguments: { quoteId: "c49d6d90-1f54-4d53-a82f-67a85f5012ca", idempotencyKey: "short" },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await app.close();
    }
  });
test("non-expiring API keys work through the MCP transport with nullable account limits", async () => {
  const { app, transportFetch } = setup();
  const client = new Client({ name: "key-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost:8788/mcp"), {
        fetch: transportFetch(`Bearer inspia_sk_${"a".repeat(64)}`),
      }),
    );
    const result = await client.callTool({ name: "get_credits", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      result: {
        availableCredits: "100",
        perRequestLimit: null,
        dailyLimit: null,
        dailyRemaining: null,
        checkedAt: expect.any(String),
      },
    });
  } finally {
    await client.close();
    await app.close();
  }
});

test("HTTP authorization challenges, resource metadata, anonymous discovery and revoked tokens", async () => {
  const { app, calls, transportFetch } = setup();
  try {
    const metadata = await app.fetch(
      new Request("http://localhost:8788/.well-known/oauth-protected-resource/mcp", {
        headers: { Host: "localhost:8788" },
      }),
    );
    expect((await metadata.json()).resource).toBe("http://localhost:8788/mcp");
    for (const [token, status] of [
      [undefined, 401],
      ["Bearer limited", 403],
      ["Bearer revoked", 401],
    ] as const) {
      const response = await transportFetch(token)("http://localhost:8788/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_credits", arguments: {} },
        }),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("WWW-Authenticate")).toContain("credits:read");
    }
    expect(calls).not.toContain("/api/mcp/credits");
    const client = new Client({ name: "anonymous", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://localhost:8788/mcp"), {
          fetch: transportFetch(),
        }),
      );
      expect(
        (await client.callTool({ name: "search_prompts", arguments: { limit: 1 } })).isError,
      ).not.toBe(true);
    } finally {
      await client.close();
    }
  } finally {
    await app.close();
  }
});
test("account upstream refuses path injection, redirects and malformed credentials", async () => {
  const { app, config, fetcher } = setup();
  try {
    const service = new AccountService(config, fetcher);
    await expect(service.request("/api/admin", "Bearer valid")).rejects.toThrow(
      "Invalid account endpoint",
    );
    await expect(service.request("/api/mcp/credits", "Basic abc")).rejects.toThrow(
      "Invalid authorization",
    );
    const redirect = new AccountService(
      config,
      async () =>
        new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
    );
    await expect(redirect.request("/api/mcp/credits", "Bearer valid")).rejects.toThrow();
  } finally {
    await app.close();
  }
});
