import type { z } from "zod";
import type { Config } from "./config";
import { DiscoveryError } from "./errors";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new DiscoveryError("RESPONSE_TOO_LARGE", "The response exceeds the supported size.");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes)
        throw new DiscoveryError("RESPONSE_TOO_LARGE", "The response exceeds the supported size.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class InspiaClient {
  constructor(
    private readonly config: Pick<Config, "upstreamOrigin" | "timeoutMs">,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async text(path: string, params?: URLSearchParams): Promise<string> {
    if (
      !(
        path === "/llms.txt" ||
        path === "/api/prompts" ||
        path === "/api/task-types" ||
        /^\/api\/prompts\/[A-Za-z0-9_-]+$/.test(path)
      )
    ) {
      throw new DiscoveryError("INTERNAL_ERROR", "Unsupported Inspia read endpoint.");
    }
    const url = new URL(path, this.config.upstreamOrigin);
    if (params) url.search = params.toString();
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          Accept: path === "/llms.txt" ? "text/plain" : "application/json",
          "User-Agent": "Inspia-MCP/0.1.0",
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404)
          throw new DiscoveryError("NOT_FOUND", "The published prompt was not found.");
        if (response.status === 400)
          throw new DiscoveryError(
            "INVALID_FILTER",
            "Inspia rejected a filter. Refresh list_prompt_filters and retry.",
          );
        if (response.status === 429) {
          const seconds = Number(response.headers.get("retry-after"));
          throw new DiscoveryError(
            "UPSTREAM_RATE_LIMITED",
            "Inspia is rate limiting requests. Retry later.",
            true,
            Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 30,
          );
        }
        throw new DiscoveryError(
          "UPSTREAM_UNAVAILABLE",
          "Inspia is temporarily unavailable.",
          true,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (
        !(path === "/llms.txt"
          ? contentType.includes("text/plain")
          : contentType.includes("application/json"))
      ) {
        await response.body?.cancel();
        throw new DiscoveryError(
          "UPSTREAM_INVALID_RESPONSE",
          "Inspia returned an unexpected response format.",
          true,
        );
      }
      return await readBounded(response, 2 * 1024 * 1024);
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      throw new DiscoveryError(
        "UPSTREAM_UNAVAILABLE",
        "The Inspia read request failed or timed out.",
        true,
      );
    }
  }

  async json<T extends z.ZodType>(
    path: string,
    schema: T,
    params?: URLSearchParams,
  ): Promise<z.infer<T>> {
    const text = await this.text(path, params);
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      throw new DiscoveryError(
        "UPSTREAM_INVALID_RESPONSE",
        "Inspia's public response no longer matches the supported contract.",
        true,
      );
    }
  }
}

export class TtlCache<T> {
  private readonly entries = new Map<string, { expires: number; value: Promise<T> }>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 16,
  ) {}
  get(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const entry = { expires: Date.now() + this.ttlMs, value: loader() };
    this.entries.set(key, entry);
    void entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }
}
