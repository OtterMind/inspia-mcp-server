import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DiscoveryError } from "./errors";

const payloadSchema = z.strictObject({
  v: z.literal(1),
  filters: z.string(),
  upstream: z.string().min(1).max(2048),
  expires: z.number().int(),
});

export class CursorCodec {
  constructor(
    private readonly secret: string,
    private readonly origin: string,
    private readonly now = Date.now,
  ) {}
  encode(upstream: string, filters: string): string {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, filters, upstream, expires: this.now() + 15 * 60_000 }),
    ).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }
  decode(value: string, filters: string): string {
    try {
      if (value.length > 6000) throw new Error();
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
      if (parsed.expires <= this.now() || parsed.filters !== filters) throw new Error();
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
