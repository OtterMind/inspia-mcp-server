import { randomBytes } from "node:crypto";
import { z } from "zod";

const envSchema = z.object({
  INSPIA_BASE_URL: z.url().default("https://inspia.ai"),
  MCP_HOST: z.enum(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]).default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  MCP_ENABLED: z.enum(["true", "false"]).default("true"),
  MCP_CURSOR_SECRET: z.string().optional(),
  MCP_RATE_LIMIT: z.coerce.number().int().min(1).max(10000).default(60),
  MCP_MAX_CONCURRENT: z.coerce.number().int().min(1).max(1000).default(16),
  INSPIA_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(15000),
});

export type Config = ReturnType<typeof loadConfig>;
const split = (value: string) => [
  ...new Set(
    value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((x) => x.path.join(".")).join(", ")}`,
    );
  const e = parsed.data;
  const upstream = new URL(e.INSPIA_BASE_URL);
  const loopback = ["localhost", "127.0.0.1", "[::1]"];
  if (
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    upstream.pathname !== "/" ||
    (upstream.protocol !== "https:" &&
      !(upstream.protocol === "http:" && loopback.includes(upstream.hostname)))
  ) {
    throw new Error(
      "INSPIA_BASE_URL must be an HTTPS origin or an HTTP loopback origin, without credentials",
    );
  }
  const publicBind = e.MCP_HOST === "0.0.0.0" || e.MCP_HOST === "::";
  const secret = e.MCP_CURSOR_SECRET?.trim();
  if ((publicBind || secret) && (!secret || secret.length < 32)) {
    throw new Error("MCP_CURSOR_SECRET must contain at least 32 characters for non-loopback binds");
  }
  if (publicBind && !e.MCP_ALLOWED_HOSTS?.trim())
    throw new Error("Set MCP_ALLOWED_HOSTS for non-loopback binds");
  const allowedHosts = split(e.MCP_ALLOWED_HOSTS ?? "localhost,127.0.0.1,[::1]");
  if (!allowedHosts.length || allowedHosts.some((x) => !/^(?:[a-zA-Z0-9.-]+|\[::1\])$/.test(x))) {
    throw new Error("MCP_ALLOWED_HOSTS must contain explicit hostnames without ports or wildcards");
  }
  const allowedOrigins = split(
    e.MCP_ALLOWED_ORIGINS ??
      (publicBind
        ? ""
        : `http://localhost:${e.MCP_PORT},http://127.0.0.1:${e.MCP_PORT},http://[::1]:${e.MCP_PORT}`),
  );
  if (
    allowedOrigins.some((value) => {
      try {
        const url = new URL(value);
        return !["http:", "https:"].includes(url.protocol) || url.origin !== value;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins");
  }
  return {
    upstreamOrigin: upstream.origin,
    host: e.MCP_HOST,
    port: e.MCP_PORT,
    allowedHosts: allowedHosts.map((x) => x.toLowerCase()),
    allowedOrigins,
    enabled: e.MCP_ENABLED === "true",
    cursorSecret: secret || randomBytes(32).toString("hex"),
    rateLimit: e.MCP_RATE_LIMIT,
    maxConcurrent: e.MCP_MAX_CONCURRENT,
    timeoutMs: e.INSPIA_TIMEOUT_MS,
  };
}
