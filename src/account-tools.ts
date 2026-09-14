import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { assetSchema, creditsSchema, quoteSchema, taskSchema } from "./account-schemas";
import type { AccountService } from "./accounts";
import { publicError } from "./errors";
import { portableOutput } from "./portable-schema";

const record = z.record(z.string(), z.json());
const output = (schema: z.ZodType) => portableOutput(z.object({ result: schema }));
const id = z.uuid();
const intentKey = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function registerAccountTools(server: McpServer, accounts: AccountService, token?: string) {
  async function run(
    schema: z.ZodType,
    path: string,
    body?: Record<string, unknown>,
    params?: URLSearchParams,
  ) {
    try {
      if (!token)
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "AUTH_REQUIRED: Connect your Inspia account" }],
        };
      const data = schema.parse(await accounts.request(path, token, body, params));
      return {
        structuredContent: { result: data },
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    } catch (error) {
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(publicError(error)) }],
      };
    }
  }
  server.registerTool(
    "get_credits",
    {
      description:
        "Read your Inspia Credits balance. API keys use the account balance; connection limit fields are always null. Requires credits:read.",
      inputSchema: z.strictObject({}),
      outputSchema: output(creditsSchema),
      annotations: read,
    },
    () => run(creditsSchema, "/api/mcp/credits"),
  );
  server.registerTool(
    "get_task",
    {
      description:
        "Read your task by taskId or the original idempotencyKey, exactly one. Use for recovery; never submit another generation just because a response was interrupted.",
      inputSchema: z.strictObject({ taskId: id.optional(), idempotencyKey: intentKey.optional() }),
      outputSchema: output(taskSchema),
      annotations: read,
    },
    (args) =>
      run(
        taskSchema,
        "/api/mcp/tasks",
        undefined,
        new URLSearchParams(
          Object.entries(args).filter(
            (pair): pair is [string, string] => typeof pair[1] === "string",
          ),
        ),
      ),
  );
  server.registerTool(
    "quote_generation",
    {
      description:
        "Quote one image using the final prompt and current website model options. No Task or Credits consumption occurs. Show exact Credits before submitting. Requires generation:create.",
      inputSchema: z.strictObject({
        modelId: z.string().min(1).max(160),
        prompt: z.string().min(1).max(10000),
        options: record.default({}),
        referenceAssetIds: z.array(id).max(20).optional(),
        sourcePromptId: z.string().max(160).optional(),
      }),
      outputSchema: output(quoteSchema),
      annotations: { ...read, readOnlyHint: false, idempotentHint: false },
    },
    (args) => run(quoteSchema, "/api/mcp/quotes", args),
  );
  server.registerTool(
    "generate_image",
    {
      description:
        "Submit the exact single-image intent frozen in quoteId, using the account Credits balance. This consumes Credits. Keep the SAME idempotencyKey when retrying a timed-out request. Returns a durable task; use get_task for status.",
      inputSchema: z.strictObject({ quoteId: id, idempotencyKey: intentKey }),
      outputSchema: output(taskSchema),
      annotations: { ...read, readOnlyHint: false },
    },
    async (args) => {
      const response = await run(taskSchema, "/api/mcp/generate", args);
      if (response.isError || !response.structuredContent) return response;
      if (!token) return response;
      const task = response.structuredContent.result as z.infer<typeof taskSchema>;
      if (task.status !== "succeeded") return response;
      const images = await Promise.all(
        task.assets
          .filter((asset) => asset.kind === "image" && asset.direction === "output")
          .map(async (asset) => {
            try {
              const data = await accounts.request(
                `/api/mcp/assets/${asset.id}`,
                token,
                undefined,
                new URLSearchParams({ representation: "preview" }),
              );
              const preview = z
                .object({
                  preview: z.object({
                    mimeType: z.literal("image/webp"),
                    data: z.string().max(699_050),
                  }),
                })
                .parse(data).preview;
              return { type: "image" as const, data: preview.data, mimeType: preview.mimeType };
            } catch {
              return null;
            }
          }),
      );
      return {
        ...response,
        content: [
          ...response.content,
          ...images.filter(
            (image): image is { type: "image"; data: string; mimeType: "image/webp" } =>
              image !== null,
          ),
        ],
      };
    },
  );
  server.registerTool(
    "read_asset",
    {
      description:
        "Read your private asset metadata or a bounded derived image preview. Original downloads require client-managed Bearer authentication; never expose tokens in prompts or URLs.",
      inputSchema: z.strictObject({
        assetId: id,
        representation: z.enum(["metadata", "preview"]).default("metadata"),
      }),
      outputSchema: output(assetSchema),
      annotations: read,
    },
    async (args) => {
      try {
        if (!token)
          return {
            isError: true,
            content: [
              { type: "text" as const, text: "AUTH_REQUIRED: Connect your Inspia account" },
            ],
          };
        const data = await accounts.request(
          `/api/mcp/assets/${args.assetId}`,
          token,
          undefined,
          new URLSearchParams({ representation: args.representation }),
        );
        const parsed = z
          .object({
            preview: z
              .object({
                mimeType: z.literal("image/webp"),
                data: z.string().max(699_050),
                width: z.number(),
                height: z.number(),
                derived: z.literal(true),
              })
              .optional(),
          })
          .parse(data);
        const { preview: _preview, ...metadata } = data;
        const result = assetSchema.parse({
          ...metadata,
          ...(parsed.preview
            ? {
                preview: {
                  width: parsed.preview.width,
                  height: parsed.preview.height,
                  derived: true,
                  mimeType: parsed.preview.mimeType,
                },
              }
            : {}),
        });
        return {
          structuredContent: { result },
          content: [
            { type: "text" as const, text: JSON.stringify(result) },
            ...(parsed.preview
              ? [
                  {
                    type: "image" as const,
                    data: parsed.preview.data,
                    mimeType: parsed.preview.mimeType,
                  },
                ]
              : []),
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify(publicError(error)) }],
        };
      }
    },
  );
}
