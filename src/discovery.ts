import { marked } from "marked";
import type { z } from "zod";
import type { Config } from "./config";
import { CursorCodec } from "./cursor";
import { DiscoveryError } from "./errors";
import { SOURCE_MODELS, SUBJECTS } from "./filter-vocabulary";
import type { filtersOutput, modelsOutput, SearchInput, summarySchema } from "./schemas";
import { upstreamDetail, upstreamModels, upstreamPage } from "./schemas";
import { type InspiaClient, TtlCache } from "./upstream";

type Filters = z.infer<typeof filtersOutput>;
type Catalog = z.infer<typeof upstreamModels>;
type Item = z.infer<typeof upstreamPage>["items"][number];
type Category = Filters["categories"][number];
const SITE = "https://inspia.ai";
const categoryFor = (type?: "image" | "video") =>
  type === "image" ? "images" : type === "video" ? "videos" : "all";

export function summarize(item: Item): z.infer<typeof summarySchema> {
  return {
    id: item.id,
    title: item.title,
    // The public list API has no prompt excerpt. Never substitute a title as original prompt text.
    promptExcerpt: null,
    mediaType: item.media.type,
    media: item.media,
    previewUrl: item.media.type === "image" ? item.media.url : (item.media.posterUrl ?? null),
    width: item.media.width,
    height: item.media.height,
    sourceModel: item.model ?? null,
    sourceModelFamily: item.modelFamily ?? null,
    creator: item.author
      ? {
          name: item.author.name,
          handle: item.author.handle,
          avatarUrl: item.author.avatarUrl || null,
        }
      : null,
    sourcePlatform: item.source?.platform ?? null,
    sourceUrl: item.source?.postUrl ?? null,
    sourceMetrics: { likes: item.metrics?.likes ?? null, views: item.metrics?.views ?? null },
    canonicalUrl: `${SITE}/prompt/${encodeURIComponent(item.id)}`,
    useUrl: `${SITE}/?use=${encodeURIComponent(item.id)}`,
    category: item.categorySlug,
    subcategory: item.subcategorySlug ?? null,
    subjects: item.facets?.subjects ?? [],
    tags: item.tags ?? [],
    publishedAt: item.publishedAt ?? null,
  };
}

export function parseCategories(markdown: string): Category[] {
  const tokens = marked.lexer(markdown);
  const start = tokens.findIndex(
    (token) => token.type === "heading" && token.text === "Prompt categories",
  );
  if (start < 0)
    throw new DiscoveryError(
      "UPSTREAM_INVALID_RESPONSE",
      "The public category index is unavailable.",
    );
  const section = tokens.slice(start + 1);
  const end = section.findIndex((token) => token.type === "heading");
  const links: { value: string; label: string; url: string; category: string }[] = [];
  marked.walkTokens(end < 0 ? section : section.slice(0, end), (token) => {
    if (token.type !== "link") return;
    let url: URL;
    try {
      url = new URL(token.href, SITE);
    } catch {
      return;
    }
    if (url.origin !== SITE || url.search || url.hash || url.username || url.password) return;
    const match = /^\/prompts\/(images|videos)(?:\/([a-z0-9-]+))?$/.exec(url.pathname);
    if (!match?.[1]) return;
    links.push({
      category: match[1],
      value: match[2] ?? match[1],
      label: token.text.replace(/ prompts$/, ""),
      url: url.href,
    });
  });
  const categories = new Map<string, Category>();
  for (const link of links) {
    if (link.value !== link.category) continue;
    categories.set(link.category, {
      mediaType: link.category === "images" ? "image" : "video",
      value: link.value,
      label: link.label,
      url: link.url,
      subcategories: [],
    });
  }
  for (const link of links) {
    const category = categories.get(link.category);
    if (
      category &&
      link.value !== link.category &&
      !category.subcategories.some((s) => s.value === link.value)
    ) {
      category.subcategories.push({ value: link.value, label: link.label, url: link.url });
    }
  }
  return [...categories.values()];
}

async function mapBounded<T, R>(
  items: readonly T[],
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        const item = items[current];
        if (item !== undefined) results[current] = await mapper(item);
      }
    }),
  );
  return results;
}

export class DiscoveryService {
  private readonly cursor: CursorCodec;
  private readonly categoryCache = new TtlCache<Category[]>(300_000);
  private readonly filterCache = new TtlCache<Filters>(300_000);
  constructor(
    private readonly client: InspiaClient,
    config: Pick<Config, "cursorSecret" | "upstreamOrigin">,
  ) {
    this.cursor = new CursorCodec(config.cursorSecret, config.upstreamOrigin);
  }

  async search(input: SearchInput) {
    if (input.subcategory && !input.mediaType)
      throw new DiscoveryError("INVALID_FILTER", "subcategory requires mediaType.");
    if (input.query && input.sort)
      throw new DiscoveryError(
        "INVALID_FILTER",
        "Text searches use relevance. Omit sort when using query.",
      );
    if (
      input.sourceModel &&
      input.mediaType &&
      SOURCE_MODELS.find((m) => m.value === input.sourceModel)?.mediaType !== input.mediaType
    ) {
      throw new DiscoveryError(
        "INVALID_FILTER",
        "The source model does not belong to this media type.",
      );
    }
    const query = input.query?.trim().toLocaleLowerCase("en-US") ?? "";
    const params = new URLSearchParams({
      category: categoryFor(input.mediaType),
      sort: input.sort ?? "featured",
      limit: String(input.limit),
    });
    if (query) params.set("q", query);
    if (input.subcategory) params.set("subcategory", input.subcategory);
    if (input.subject) params.set("subject", input.subject);
    if (input.sourceModel) params.set("model", input.sourceModel);
    const signature = params.toString();
    if (input.cursor) params.set("cursor", this.cursor.decode(input.cursor, signature));
    if (input.subcategory) {
      const categories = await this.categories();
      if (
        !categories
          .find((category) => category.mediaType === input.mediaType)
          ?.subcategories.some((s) => s.value === input.subcategory)
      ) {
        throw new DiscoveryError(
          "INVALID_FILTER",
          "This subcategory is not published. Call list_prompt_filters.",
        );
      }
    }
    const page = await this.client.json("/api/prompts", upstreamPage, params);
    if (
      page.items.length > input.limit ||
      (page.nextCursor && (page.nextCursor === params.get("cursor") || !page.items.length))
    ) {
      throw new DiscoveryError(
        "UPSTREAM_INVALID_RESPONSE",
        "Inspia returned inconsistent pagination.",
        true,
      );
    }
    const mode = page.search?.mode;
    return {
      items: page.items.map(summarize),
      nextCursor: page.nextCursor ? this.cursor.encode(page.nextCursor, signature) : null,
      hasMore: page.nextCursor !== null,
      searchMode: !query
        ? ("browse" as const)
        : mode === "degraded-keyword"
          ? ("keyword" as const)
          : (mode ?? ("unknown" as const)),
      degraded: Boolean(query && (mode === "degraded-keyword" || !mode || mode === "unknown")),
    };
  }

  private async detail(promptId: string) {
    const detail = await this.client.json(`/api/prompts/${promptId}`, upstreamDetail);
    if (detail.prompt.id !== promptId)
      throw new DiscoveryError("UPSTREAM_INVALID_RESPONSE", "Inspia returned a different prompt.");
    return detail;
  }

  async getPrompt(promptId: string) {
    const { prompt } = await this.detail(promptId);
    return {
      prompt: {
        ...summarize(prompt),
        originalPrompt: prompt.prompt,
        sourceLocale: prompt.sourceLocale,
        translations: prompt.promptLocalizations,
        mediaItems: [prompt.media, ...prompt.additionalMedia],
      },
    };
  }

  async related(promptId: string, limit: number) {
    const { related } = await this.detail(promptId);
    const unique = related.filter(
      (p, i) => p.id !== promptId && related.findIndex((x) => x.id === p.id) === i,
    );
    return { promptId, items: unique.slice(0, limit).map(summarize), maxAvailable: 8 };
  }

  private categories() {
    return this.categoryCache.get("categories", async () =>
      parseCategories(await this.client.text("/llms.txt")),
    );
  }

  filters(mediaType?: "image" | "video") {
    return this.filterCache.get(mediaType ?? "all", async () => {
      const categories = await this.categories();
      const count = async (key: string, value: string) => {
        const page = await this.client.json(
          "/api/prompts",
          upstreamPage,
          new URLSearchParams({
            category: categoryFor(mediaType),
            sort: "newest",
            limit: "1",
            [key]: value,
          }),
        );
        return page.total;
      };
      const facets = [
        ...SUBJECTS.map((subject) => ({ kind: "subject" as const, ...subject })),
        ...SOURCE_MODELS.filter((m) => !mediaType || m.mediaType === mediaType).map((model) => ({
          kind: "model" as const,
          ...model,
        })),
      ];
      const counts = await mapBounded(facets, async (facet) => ({
        facet,
        count: await count(facet.kind, facet.value),
      }));
      const subjects: Filters["subjects"] = [];
      const sourceModels: Filters["sourceModels"] = [];
      for (const { facet, count: total } of counts) {
        if (total <= 0) continue;
        if (facet.kind === "subject")
          subjects.push({ value: facet.value, label: facet.label, count: total });
        else
          sourceModels.push({
            value: facet.value,
            label: facet.label,
            mediaType: facet.mediaType,
            count: total,
          });
      }
      return {
        categories: categories.filter((x) => !mediaType || x.mediaType === mediaType),
        subjects,
        sourceModels,
        checkedAt: new Date().toISOString(),
        vocabularyVersion: "inspia-fec2f43" as const,
      };
    });
  }

  async models(taskType?: string): Promise<z.infer<typeof modelsOutput>> {
    // Never cache an enabled/stale decision beyond the upstream's own capability freshness policy.
    const catalog = await this.client.json("/api/task-types", upstreamModels);
    return {
      catalogVersion: catalog.catalogVersion,
      stale: catalog.stale,
      websiteGenerationEnabled: catalog.enabled && catalog.submissionEnabled && !catalog.stale,
      mcpGenerationEnabled: false,
      models: catalog.models
        .filter((model) => !taskType || model.supportedTasks.includes(taskType))
        .map((model) => modelOutput(model, catalog)),
      note: "Discovery only: this MCP cannot generate or spend Credits. Source-catalog models are separate. The public API does not expose authoritative capability hashes or exact quotes; capabilityHash is null. optionsSchema describes website model options, not an MCP submission tool.",
    };
  }
}

function modelOutput(model: Catalog["models"][number], catalog: Catalog) {
  const properties: Record<string, z.core.JSONSchema.JSONSchema> = {};
  const defaults: Record<string, string | number | boolean> = {};
  for (const [name, parameter] of Object.entries(model.parameters)) {
    const property: z.core.JSONSchema.JSONSchema = {};
    if (parameter.type === "select") property.enum = parameter.options ?? [];
    else property.type = parameter.type === "text" ? "string" : parameter.type;
    if (parameter.min !== undefined) property.minimum = parameter.min;
    if (parameter.max !== undefined) property.maximum = parameter.max;
    if (parameter.step !== undefined) property.multipleOf = parameter.step;
    if (parameter.default !== undefined) {
      property.default = parameter.default;
      defaults[name] = parameter.default;
    }
    properties[name] = property;
  }
  return {
    id: model.modelKey,
    providerModelId: model.id,
    displayName: model.displayName,
    provider: model.provider,
    type: model.type,
    supportedTasks: model.supportedTasks,
    available: model.available && catalog.enabled && catalog.submissionEnabled && !catalog.stale,
    parameters: model.parameters,
    defaults,
    optionsSchema: { type: "object", properties, additionalProperties: false } as z.infer<
      typeof modelsOutput
    >["models"][number]["optionsSchema"],
    maxPromptChars: model.capabilities.maxPromptChars ?? null,
    referenceImages: model.capabilities.inputImages ?? null,
    capabilityHash: null,
  };
}
