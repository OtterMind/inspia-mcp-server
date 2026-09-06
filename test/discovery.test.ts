import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { CursorCodec } from "../src/cursor";
import { DiscoveryService, parseCategories } from "../src/discovery";
import { searchInput } from "../src/schemas";
import { InspiaClient, readBounded, TtlCache } from "../src/upstream";
import { fakeUpstream, fixtureItem, indexFixture, modelsFixture, originalPrompt } from "./fixtures";

const config = loadConfig({ MCP_CURSOR_SECRET: "a".repeat(32) });
function setup(overrides?: Parameters<typeof fakeUpstream>[0]) {
  const upstream = fakeUpstream(overrides);
  return {
    ...upstream,
    service: new DiscoveryService(new InspiaClient(config, upstream.fetcher), config),
  };
}

describe("discovery", () => {
  test("search uses public GET, bounded summaries, attribution and signed next-page cursors", async () => {
    const { service, calls } = setup();
    const args = searchInput.parse({ query: "  海报  ", limit: 1 });
    const first = await service.search(args);
    expect(first.searchMode).toBe("hybrid");
    expect(first.items[0]?.sourceUrl).toBe("https://x.com/fixture/status/123");
    expect(first.items[0]?.canonicalUrl).toBe("https://inspia.ai/prompt/fixture-poster");
    expect(first.items[0]?.promptExcerpt).toBeNull();
    expect(JSON.stringify(first)).not.toContain("do-not-return");
    expect(calls[0]?.searchParams.get("limit")).toBe("1");
    const second = await service.search({ ...args, cursor: first.nextCursor ?? "" });
    expect(second.items[0]?.id).toBe("fixture-second");
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    await expect(
      service.search({ ...args, query: "different", cursor: first.nextCursor ?? "" }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(calls).toHaveLength(2);
  });

  test("full text and translations are preserved separately; internal fields are stripped", async () => {
    const { service } = setup();
    const result = await service.getPrompt("fixture-poster");
    expect(result.prompt.originalPrompt).toBe(originalPrompt);
    expect(result.prompt.translations["zh-CN"]).toBe("海报提示词翻译");
    expect(result.prompt.mediaItems).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("do-not-return");
    expect(JSON.stringify(result)).not.toContain("private-user");
    expect((await service.related("fixture-poster", 1)).items[0]?.id).toBe("fixture-related");
    await expect(service.getPrompt("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("invalid filters fail before upstream queries", async () => {
    const { service, calls } = setup();
    await expect(
      service.search(searchInput.parse({ subcategory: "posters-graphics" })),
    ).rejects.toMatchObject({ code: "INVALID_FILTER" });
    await expect(
      service.search(searchInput.parse({ query: "test", sort: "newest" })),
    ).rejects.toMatchObject({ code: "INVALID_FILTER" });
    await expect(
      service.search(searchInput.parse({ mediaType: "video", sourceModel: "gpt-image-2" })),
    ).rejects.toMatchObject({ code: "INVALID_FILTER" });
    expect(calls).toHaveLength(0);
    await expect(
      service.search(searchInput.parse({ mediaType: "image", subcategory: "not-published" })),
    ).rejects.toMatchObject({ code: "INVALID_FILTER" });
    expect(calls).toHaveLength(1);
  });

  test("published categories use Markdown AST and source filters require live nonzero counts", async () => {
    const { service, calls } = setup((url) =>
      url.pathname === "/api/prompts"
        ? Response.json({
            items: [],
            nextCursor: null,
            total: url.searchParams.get("model") === "midjourney" ? 0 : 12,
          })
        : undefined,
    );
    expect(parseCategories(indexFixture)).toHaveLength(2);
    const results = await service.filters("image");
    expect(results.categories).toHaveLength(1);
    expect(results.categories[0]?.subcategories.map((x) => x.value)).toEqual(["posters-graphics"]);
    expect(results.sourceModels.map((x) => x.value)).toEqual(["gpt-image-2", "nano-banana"]);
    expect(results.subjects).toHaveLength(6);
    const count = calls.length;
    await service.filters("image");
    expect(calls).toHaveLength(count);
    expect(
      calls
        .filter((x) => x.pathname === "/api/prompts")
        .every((x) => x.searchParams.get("sort") === "newest"),
    ).toBe(true);
  });

  test("keyword degradation is distinct from empty results and upstream failures", async () => {
    const { service } = setup(() =>
      Response.json({
        items: [],
        nextCursor: null,
        total: 0,
        search: { mode: "degraded-keyword", semantic: "unavailable" },
      }),
    );
    const result = await service.search(searchInput.parse({ query: "poster" }));
    expect(result).toMatchObject({ items: [], searchMode: "keyword", degraded: true });
    const broken = setup(() => Response.json({ secret: "do-not-return" }, { status: 500 }));
    await expect(broken.service.search(searchInput.parse({}))).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });

  test("models are live, stale disables availability, and private capability fields do not leak", async () => {
    let stale = false;
    const { service, calls } = setup(() => Response.json({ ...modelsFixture, stale }));
    const live = await service.models("image_generation");
    expect(live.models[0]?.available).toBe(true);
    expect(live.mcpGenerationEnabled).toBe(false);
    expect(live.models[0]?.capabilityHash).toBeNull();
    expect(live.models[0]?.optionsSchema).toMatchObject({
      additionalProperties: false,
      properties: { quality: { enum: ["low", "high"] } },
    });
    expect(JSON.stringify(live)).not.toContain("do-not-return");
    stale = true;
    const expired = await service.models();
    expect(expired.models[0]?.available).toBe(false);
    expect(expired.websiteGenerationEnabled).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("unknown search modes degrade honestly and invalid upstream data fails closed", async () => {
    const unknown = setup(() =>
      Response.json({
        items: [fixtureItem],
        nextCursor: null,
        total: 1,
        search: { mode: "future" },
      }),
    );
    expect(await unknown.service.search(searchInput.parse({ query: "x" }))).toMatchObject({
      searchMode: "unknown",
      degraded: true,
    });
    const wrong = setup(() =>
      Response.json({
        items: [{ ...fixtureItem, media: { ...fixtureItem.media, url: "javascript:alert(1)" } }],
        nextCursor: null,
        total: 1,
      }),
    );
    await expect(wrong.service.search(searchInput.parse({}))).rejects.toMatchObject({
      code: "UPSTREAM_INVALID_RESPONSE",
    });
  });
});

test("cursor expiration, tampering, replica secrets and upstream binding", () => {
  let now = 1000;
  const codec = new CursorCodec("secret", "https://inspia.ai", () => now);
  const cursor = codec.encode("upstream", "filter");
  expect(codec.decode(cursor, "filter")).toBe("upstream");
  expect(() => codec.decode(`${cursor}x`, "filter")).toThrow();
  expect(() =>
    new CursorCodec("other", "https://inspia.ai", () => now).decode(cursor, "filter"),
  ).toThrow();
  expect(() =>
    new CursorCodec("secret", "https://other.example", () => now).decode(cursor, "filter"),
  ).toThrow();
  now += 900_001;
  expect(() => codec.decode(cursor, "filter")).toThrow();
});

test("configuration refuses credentials, public cleartext upstream, wildcard hosts and weak secrets", () => {
  for (const env of [
    { INSPIA_BASE_URL: "https://secret:password@inspia.ai" },
    { INSPIA_BASE_URL: "http://inspia.ai" },
    { MCP_HOST: "0.0.0.0" },
    { MCP_ALLOWED_HOSTS: "*" },
    { MCP_ALLOWED_ORIGINS: "*" },
    { MCP_PORT: "invalid" },
  ])
    expect(() => loadConfig(env)).toThrow();
  expect(loadConfig({ INSPIA_BASE_URL: "http://localhost:3000" }).upstreamOrigin).toBe(
    "http://localhost:3000",
  );
});

test("streaming responses enforce byte limits without trusting Content-Length", async () => {
  await expect(readBounded(new Response("too long"), 3)).rejects.toMatchObject({
    code: "RESPONSE_TOO_LARGE",
  });
  expect(await readBounded(new Response("abc"), 3)).toBe("abc");
});

test("failed cache fills are retried and concurrent fills share one request", async () => {
  const cache = new TtlCache<number>(1000);
  let calls = 0;
  const load = async () => {
    calls++;
    return 5;
  };
  expect(await Promise.all([cache.get("x", load), cache.get("x", load)])).toEqual([5, 5]);
  expect(calls).toBe(1);
  await expect(
    cache.get("bad", async () => {
      throw new Error("failure");
    }),
  ).rejects.toThrow();
  expect(await cache.get("bad", load)).toBe(5);
});
