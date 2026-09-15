import { z } from "zod";

const credits = z.string().regex(/^\d+$/);
const record = z.record(z.string(), z.json());
export const creditsSchema = z.object({
  availableCredits: credits,
  perRequestLimit: credits.nullable(),
  dailyLimit: credits.nullable(),
  dailyRemaining: credits.nullable(),
  checkedAt: z.iso.datetime(),
});
const asset = z.object({
  id: z.uuid(),
  kind: z.enum(["image", "video", "audio"]),
  mimeType: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  bytes: z.number().nonnegative(),
  url: z.url(),
  direction: z.enum(["input", "output"]),
  role: z.string(),
  position: z.number().int(),
});
export const taskSchema = z.object({
  id: z.uuid(),
  workflowId: z.uuid(),
  type: z.enum(["image_generation", "video_generation", "image_to_prompt"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "canceled"]),
  stage: z.string(),
  input: z.object({
    prompt: z.string().optional(),
    model: z.string().optional(),
    options: record.optional(),
    referenceAssetIds: z.array(z.uuid()).optional(),
    imageAssetId: z.uuid().optional(),
    instruction: z.string().optional(),
  }),
  output: z
    .object({
      prompt: z.string().optional(),
      model: z.string().optional(),
      assetIds: z.array(z.uuid()).optional(),
      videoAssetId: z.uuid().optional(),
      posterAssetId: z.uuid().optional(),
    })
    .nullable(),
  errorCode: z.string().nullable(),
  errorRetryable: z.boolean(),
  reservedPoints: credits.nullable(),
  billingCreditStatus: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  assets: z.array(asset),
  taskUrl: z.url(),
  retryAfterSeconds: z.number().nullable(),
});
export const quoteSchema = z.object({
  quoteId: z.uuid(),
  type: z.literal("image_generation"),
  credits,
  pricingVersion: z.string(),
  capabilityHash: z.string(),
  catalogVersion: z.string(),
  normalizedInput: z.object({
    prompt: z.string(),
    model: z.string(),
    options: record,
    referenceAssetIds: z.array(z.uuid()).optional(),
  }),
  expiresAt: z.iso.datetime(),
});
export const assetSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["image", "video", "audio"]),
  mimeType: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  bytes: z.number().nonnegative(),
  downloadEndpoint: z.url(),
  preview: z
    .object({
      mimeType: z.literal("image/webp"),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      derived: z.literal(true),
    })
    .optional(),
});
