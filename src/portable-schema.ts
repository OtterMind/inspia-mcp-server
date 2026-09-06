import { fromJsonSchema } from "@modelcontextprotocol/server";
import { z } from "zod";

// Some MCP hosts reject JSON Schema's type-array shorthand. Preserve null semantics with anyOf.
export function portableOutput<T extends z.ZodType>(schema: T) {
  const json = z.toJSONSchema(schema);
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Record<string, unknown>;
    for (const child of Object.values(node)) visit(child);
    if (Array.isArray(node.type)) {
      const types = node.type;
      delete node.type;
      const union = { anyOf: types.map((type) => ({ type })) };
      if (node.anyOf) node.allOf = [...(Array.isArray(node.allOf) ? node.allOf : []), union];
      else node.anyOf = union.anyOf;
    }
  }
  visit(json);
  // Zod and the SDK disagree on the type of unused JSON Schema metadata ($vocabulary).
  return fromJsonSchema<z.output<T>>(json as unknown as Parameters<typeof fromJsonSchema>[0]);
}
