import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DiscoveryError } from "./errors";
import {
  CURSOR_TTL_MS,
  mcpCursorSchema,
  unsupportedUpstreamCursor,
  upstreamCursorSchema,
} from "./pagination";

const commonPayload = {
  upstream: upstreamCursorSchema,
  expires: z.number().int(),
};
const payloadSchema = z.discriminatedUnion("v", [
  z.strictObject({ v: z.literal(1), filters: z.string(), ...commonPayload }),
  z.strictObject({
    v: z.literal(2),
    filterHash: z.string().regex(/^[a-f0-9]{64}$/),
    ...commonPayload,
  }),
]);

function hashFilters(filters: string) {
  return createHash("sha256").update(filters).digest("hex");
}

export class CursorCodec {
  constructor(
    private readonly secret: string,
    private readonly origin: string,
    private readonly now = Date.now,
  ) {}
  encode(upstream: string, filters: string): string {
    if (!upstreamCursorSchema.safeParse(upstream).success) throw unsupportedUpstreamCursor();
    const payload = Buffer.from(
      JSON.stringify({
        v: 2,
        filterHash: hashFilters(filters),
        upstream,
        expires: this.now() + CURSOR_TTL_MS,
      }),
    ).toString("base64url");
    const cursor = `${payload}.${this.sign(payload)}`;
    if (!mcpCursorSchema.safeParse(cursor).success) throw unsupportedUpstreamCursor();
    return cursor;
  }
  decode(value: string, filters: string): string {
    try {
      mcpCursorSchema.parse(value);
      const parts = value.split(".");
      if (parts.length !== 2) throw new Error();
      const [payload = "", signature = ""] = parts;
      if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature))
        throw new Error();
      const expected = Buffer.from(this.sign(payload));
      if (!timingSafeEqual(expected, Buffer.from(signature))) throw new Error();
      const parsed = payloadSchema.parse(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      );
      const matchesFilters =
        parsed.v === 1 ? parsed.filters === filters : parsed.filterHash === hashFilters(filters);
      if (parsed.expires <= this.now() || !matchesFilters) throw new Error();
      return parsed.upstream;
    } catch {
      throw new DiscoveryError(
        "INVALID_CURSOR",
        "The cursor is invalid, expired, or belongs to different filters. Start a new search.",
      );
    }
  }
  private sign(payload: string) {
    return createHmac("sha256", this.secret)
      .update(this.origin)
      .update("\n")
      .update(payload)
      .digest("base64url");
  }
}
