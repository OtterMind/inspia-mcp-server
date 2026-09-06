import { z } from "zod";
import { SOURCE_MODELS, SUBJECTS } from "./filter-vocabulary";
import { mcpCursorSchema, upstreamCursorSchema } from "./pagination";

export const mediaTypeSchema = z.enum(["image", "video"]);
export const promptIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/);
export const searchInput = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Keywords or a visual idea. Omit to browse."),
  mediaType: mediaTypeSchema.optional(),
  subcategory: z
    .string()
    .regex(/^[a-z0-9-]{1,80}$/)
    .optional()
    .describe("Use list_prompt_filters; requires mediaType."),
  subject: z.enum(SUBJECTS.map((x) => x.value)).optional(),
  sourceModel: z
    .enum(SOURCE_MODELS.map((x) => x.value))
    .optional()
    .describe("Original creator model, not a generation model ID."),
  sort: z
    .enum(["featured", "newest", "popular"])
    .optional()
    .describe("For browsing only. Search uses relevance; popular means imported X metrics."),
  cursor: mcpCursorSchema.optional(),
  limit: z.number().int().min(1).max(20).default(6),
});
export type SearchInput = z.infer<typeof searchInput>;
export const getInput = z.strictObject({ promptId: promptIdSchema });
export const relatedInput = getInput.extend({ limit: z.number().int().min(1).max(8).default(6) });
export const filtersInput = z.strictObject({ mediaType: mediaTypeSchema.optional() });
export const modelsInput = z.strictObject({
  taskType: z.enum(["image_generation", "video_generation", "image_to_prompt"]).optional(),
});

const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
});
const dimension = z.number().int().nonnegative();
export const mediaSchema = z.object({
  type: mediaTypeSchema,
  url: httpUrl,
  width: dimension,
  height: dimension,
  alt: z.string().max(10000).default(""),
  posterUrl: httpUrl.optional(),
  durationMs: z.number().nonnegative().optional(),
});
export const upstreamItem = z.object({
  id: promptIdSchema,
  title: z.string().max(10000),
  media: mediaSchema,
  author: z
    .object({
      name: z.string(),
      handle: z.string(),
      avatarUrl: z.union([httpUrl, z.literal("")]).optional(),
    })
    .nullish(),
  source: z.object({ platform: z.string(), postUrl: httpUrl }).nullish(),
  model: z.string().nullish(),
  modelFamily: z.string().nullish(),
  categorySlug: z.string(),
  subcategorySlug: z.string().optional(),
  facets: z.object({ subjects: z.array(z.string()).max(100) }).optional(),
  tags: z.array(z.string()).max(100).optional(),
  metrics: z
    .object({
      likes: z.number().nonnegative().optional(),
      views: z.number().nonnegative().optional(),
    })
    .nullish(),
  publishedAt: z.string().nullish(),
});
export const upstreamPage = z.object({
  items: z.array(upstreamItem).max(100),
  nextCursor: upstreamCursorSchema.nullable(),
  total: z.number().int().nonnegative(),
  search: z
    .object({
      mode: z
        .enum(["hybrid", "keyword", "degraded-keyword", "semantic", "unknown"])
        .catch("unknown"),
    })
    .optional(),
});
export const upstreamDetail = z.object({
  prompt: upstreamItem.extend({
    prompt: z.string().max(500000),
    sourceLocale: z.string().default("und"),
    promptLocalizations: z.object({ "zh-CN": z.string().max(500000).optional() }).default({}),
    additionalMedia: z.array(mediaSchema).max(100).default([]),
  }),
  related: z.array(upstreamItem).max(100),
});

export const parameterSchema = z.object({
  type: z.enum(["select", "number", "boolean", "text"]),
  options: z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .max(200)
    .optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  affectsPricing: z.boolean().optional(),
});
export const upstreamModels = z.object({
  catalogVersion: z.string(),
  stale: z.boolean(),
  enabled: z.boolean(),
  submissionEnabled: z.boolean(),
  models: z
    .array(
      z.object({
        id: z.string(),
        modelKey: z.string(),
        type: z.string(),
        displayName: z.string(),
        provider: z.string(),
        supportedTasks: z.array(z.string()),
        available: z.boolean(),
        parameters: z.record(z.string(), parameterSchema),
        defaultOptions: z.record(z.string(), z.json()),
        capabilities: z.object({
          tasks: z.array(z.string()).optional(),
          maxPromptChars: z.number().int().positive().optional(),
          inputImages: z
            .object({
              max: z.number().int().nonnegative(),
              mimeTypes: z.array(z.string()),
              maxBytesPerImage: z.number().nonnegative(),
            })
            .optional(),
        }),
      }),
    )
    .max(100),
});

export const summarySchema = z.object({
  id: z.string(),
  title: z.string(),
  promptExcerpt: z.null(),
  mediaType: mediaTypeSchema,
  previewUrl: httpUrl.nullable(),
  width: dimension,
  height: dimension,
  media: mediaSchema,
  sourceModel: z.string().nullable(),
  sourceModelFamily: z.string().nullable(),
  creator: z
    .object({ name: z.string(), handle: z.string(), avatarUrl: httpUrl.nullable() })
    .nullable(),
  sourcePlatform: z.string().nullable(),
  sourceUrl: httpUrl.nullable(),
  sourceMetrics: z.object({ likes: z.number().nullable(), views: z.number().nullable() }),
  canonicalUrl: httpUrl,
  useUrl: httpUrl,
  category: z.string(),
  subcategory: z.string().nullable(),
  subjects: z.array(z.string()),
  tags: z.array(z.string()),
  publishedAt: z.string().nullable(),
});
export const searchOutput = z.object({
  items: z.array(summarySchema),
  nextCursor: mcpCursorSchema.nullable(),
  hasMore: z.boolean(),
  searchMode: z.enum(["browse", "hybrid", "keyword", "semantic", "unknown"]),
  degraded: z.boolean(),
});
export const detailOutput = z.object({
  prompt: summarySchema.extend({
    originalPrompt: z.string(),
    sourceLocale: z.string(),
    translations: z.object({ "zh-CN": z.string().optional() }),
    mediaItems: z.array(mediaSchema),
  }),
});
export const relatedOutput = z.object({
  promptId: z.string(),
  items: z.array(summarySchema),
  maxAvailable: z.number(),
});
export const filtersOutput = z.object({
  categories: z.array(
    z.object({
      mediaType: mediaTypeSchema,
      value: z.string(),
      label: z.string(),
      url: httpUrl,
      subcategories: z.array(z.object({ value: z.string(), label: z.string(), url: httpUrl })),
    }),
  ),
  subjects: z.array(z.object({ value: z.string(), label: z.string(), count: z.number() })),
  sourceModels: z.array(
    z.object({
      value: z.string(),
      label: z.string(),
      mediaType: mediaTypeSchema,
      count: z.number(),
    }),
  ),
  checkedAt: z.string(),
  vocabularyVersion: z.literal("inspia-fec2f43"),
});
export const modelsOutput = z.object({
  catalogVersion: z.string(),
  stale: z.boolean(),
  websiteGenerationEnabled: z.boolean(),
  mcpGenerationEnabled: z.literal(false),
  models: z.array(
    z.object({
      id: z.string(),
      providerModelId: z.string(),
      displayName: z.string(),
      provider: z.string(),
      type: z.string(),
      supportedTasks: z.array(z.string()),
      available: z.boolean(),
      parameters: z.record(z.string(), parameterSchema),
      defaults: z.record(z.string(), z.json()),
      optionsSchema: z.record(z.string(), z.json()),
      maxPromptChars: z.number().nullable(),
      referenceImages: z
        .object({ max: z.number(), mimeTypes: z.array(z.string()), maxBytesPerImage: z.number() })
        .nullable(),
      capabilityHash: z.null(),
    }),
  ),
  note: z.string(),
});
