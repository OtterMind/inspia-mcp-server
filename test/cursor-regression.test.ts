import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { CursorCodec } from "../src/cursor";
import { DiscoveryService } from "../src/discovery";
import { searchInput, searchOutput } from "../src/schemas";
import { InspiaClient } from "../src/upstream";
import { fakeUpstream, fixtureItem } from "./fixtures";

const origin = "https://inspia.ai";
const secret = "cursor-regression-secret-32-characters";
const config = loadConfig({ MCP_CURSOR_SECRET: secret });
function legacyToken(filters: string, upstream = "old-upstream", expires = 2000) {
  const payload = Buffer.from(JSON.stringify({ v: 1, filters, upstream, expires })).toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(origin)
    .update("\n")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

describe("cursor compatibility and size budgets", () => {
  for (const [label, query] of [
    ["360 Chinese characters", "极简产品摄影".repeat(60)],
    ["500 Chinese characters", "极".repeat(500)],
    ["500 ASCII characters", "a".repeat(500)],
    ["500 UTF-16 units of emoji", "📷".repeat(250)],
    ["URL-sensitive characters", "&?=%/+ #".repeat(60)],
  ] as const) {
    test(`${label} with a maximum-size upstream token stays compact and round-trips`, () => {
      const args = searchInput.parse({ query, mediaType: "image", limit: 3 });
      const filters = new URLSearchParams({
        category: "images",
        sort: "featured",
        limit: "3",
        q: args.query ?? "",
      }).toString();
      const codec = new CursorCodec(secret, origin, () => 1000);
      const token = codec.encode("a".repeat(2048), filters);
      expect(token.length).toBeLessThan(3200);
      expect(searchInput.safeParse({ ...args, cursor: token }).success).toBe(true);
      expect(searchOutput.shape.nextCursor.safeParse(token).success).toBe(true);
      expect(codec.decode(token, filters)).toBe("a".repeat(2048));
      expect(() => codec.decode(token, `${filters}&subject=people`)).toThrow();
    });
  }

  test("old v1 tokens keep their original expiry and filter binding", () => {
    let now = 1999;
    const codec = new CursorCodec(secret, origin, () => now);
    const token = legacyToken("original-filters");
    expect(codec.decode(token, "original-filters")).toBe("old-upstream");
    expect(() => codec.decode(token, "changed-filters")).toThrow();
    now = 2000;
    expect(() => codec.decode(token, "original-filters")).toThrow();
  });

  test("unsupported upstream tokens cannot be wrapped into successful MCP cursors", () => {
    const codec = new CursorCodec(secret, origin);
    for (const upstream of ["", "a".repeat(2049), "\u0000".repeat(2048)]) {
      expect(() => codec.encode(upstream, "filters")).toThrow();
    }
  });

  test("output schema rejects tokens the input schema cannot accept", () => {
    expect(searchOutput.shape.nextCursor.safeParse("x".repeat(6001)).success).toBe(false);
  });

  test("oversized upstream cursor returns a specific non-retryable error", async () => {
    const upstream = fakeUpstream(() =>
      Response.json({ items: [fixtureItem], total: 2, nextCursor: "x".repeat(2049) }),
    );
    const service = new DiscoveryService(new InspiaClient(config, upstream.fetcher), config);
    await expect(
      service.search(searchInput.parse({ query: "极".repeat(500) })),
    ).rejects.toMatchObject({ code: "UPSTREAM_CURSOR_UNSUPPORTED", retryable: false });
  });
});

for (const era of ["modern", "legacy"] as const) {
  test(`${era} HTTP client traverses three pages for the reproduced long Chinese query`, async () => {
    const query = "极简产品摄影".repeat(60);
    const upstreamTokens = [1, 2].map((page) =>
      Buffer.from(
        JSON.stringify({
          version: 1,
          sort: "Relevance",
          category: "images",
          subcategory: "",
          subject: "",
          model: "",
          query,
          surface: "",
          variant: null,
          values: [page, `fixture-page-${page}`],
        }),
      ).toString("base64url"),
    );
    const seenQueries: string[] = [];
    const seenCursors: Array<string | null> = [];
    const upstream = fakeUpstream((url) => {
      if (url.pathname !== "/api/prompts") return undefined;
      seenQueries.push(url.searchParams.get("q") ?? "");
      const cursor = url.searchParams.get("cursor");
      seenCursors.push(cursor);
      const page = cursor === null ? 0 : upstreamTokens.indexOf(cursor) + 1;
      if (cursor !== null && page === 0) throw new Error("Unexpected upstream cursor");
      return Response.json({
        items: [{ ...fixtureItem, id: `fixture-page-${page}` }],
        nextCursor: upstreamTokens[page] ?? null,
        total: 3,
        search: { mode: "hybrid" },
      });
    });
    const app = createApp(config, upstream.fetcher);
    const fetcher = (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("Host", new URL(request.url).host);
      return app.fetch(request);
    };
    const endpoint = new URL("http://localhost:8788/mcp");
    const client =
      era === "modern"
        ? new Client(
            { name: "cursor-regression", version: "1" },
            { versionNegotiation: { mode: "auto" } },
          )
        : new LegacyClient({ name: "cursor-regression-legacy", version: "1" });
    try {
      if (client instanceof Client)
        await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: fetcher }));
      else await client.connect(new LegacyTransport(endpoint, { fetch: fetcher }));
      let cursor: string | undefined;
      const ids: string[] = [];
      for (let page = 0; page < 3; page++) {
        const response = await client.callTool({
          name: "search_prompts",
          arguments: { query, mediaType: "image", limit: 3, ...(cursor ? { cursor } : {}) },
        });
        expect(response.isError).not.toBe(true);
        const result = searchOutput.parse(response.structuredContent);
        ids.push(...result.items.map((item) => item.id));
        cursor = result.nextCursor ?? undefined;
        expect(result.hasMore).toBe(page < 2);
      }
      expect(ids).toEqual(["fixture-page-0", "fixture-page-1", "fixture-page-2"]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(seenQueries).toEqual([query, query, query]);
      expect(seenCursors).toEqual([null, ...upstreamTokens]);
    } finally {
      await client.close();
      await app.close();
    }
  });
}
