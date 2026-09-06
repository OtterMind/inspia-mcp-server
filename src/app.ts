import { createMcpHandler, hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import type { Config } from "./config";
import { DiscoveryService } from "./discovery";
import { createServer } from "./server";
import { type Fetcher, InspiaClient, readBounded } from "./upstream";

export function createApp(config: Config, fetcher?: Fetcher) {
  const service = new DiscoveryService(new InspiaClient(config, fetcher), config);
  const handler = createMcpHandler(() => createServer(service), {
    legacy: "stateless",
    responseMode: "json",
  });
  const rates = new Map<string, { count: number; reset: number }>();
  let concurrent = 0;

  function rateLimit(ip: string) {
    const now = Date.now();
    let entry = rates.get(ip);
    if (!entry || entry.reset <= now) {
      if (rates.size >= 10_000) {
        for (const [key, value] of rates) if (value.reset <= now) rates.delete(key);
        if (rates.size >= 10_000) return 60;
      }
      entry = { count: 0, reset: now + 60_000 };
      rates.set(ip, entry);
    }
    entry.count++;
    return entry.count > config.rateLimit ? Math.ceil((entry.reset - now) / 1000) : 0;
  }

  async function route(request: Request, ip: string): Promise<Response> {
    const url = new URL(request.url);
    const hostError = hostHeaderValidationResponse(request, config.allowedHosts);
    if (hostError || !config.allowedHosts.includes(url.hostname.toLowerCase()))
      return json({ error: "Host is not allowed" }, 403);
    const origin = request.headers.get("origin");
    if (origin !== null && !config.allowedOrigins.includes(origin))
      return json({ error: "Origin is not allowed" }, 403);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({
        status: "ok",
        service: "inspia-mcp-server",
        version: "0.1.0",
        enabled: config.enabled,
        upstreamChecked: false,
      });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        name: "Inspia",
        version: "0.1.0",
        endpoint: "/mcp",
        transport: "Streamable HTTP",
        mode: "read-only-discovery",
        website: "https://inspia.ai",
      });
    }
    if (url.pathname !== "/mcp") return json({ error: "Not found" }, 404);
    if (!config.enabled) return json({ error: "Discovery is disabled" }, 503);
    if (request.headers.has("authorization"))
      return json(
        { error: "Discovery is anonymous. Remove Authorization; credentials are not accepted." },
        400,
      );
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          Allow: "POST, OPTIONS",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    if (request.method !== "POST")
      return json(
        {
          error:
            "Use POST for Streamable HTTP. Session GET/DELETE and legacy SSE are not supported.",
        },
        405,
        { Allow: "POST, OPTIONS" },
      );
    const retryAfter = rateLimit(ip);
    if (retryAfter)
      return json({ error: "Rate limited" }, 429, { "Retry-After": String(retryAfter) });
    if (concurrent >= config.maxConcurrent)
      return json({ error: "Server is busy" }, 503, { "Retry-After": "2" });
    concurrent++;
    try {
      let body: string;
      try {
        body = await readBounded(
          new Response(request.body, { headers: request.headers }),
          64 * 1024,
        );
      } catch {
        return json({ error: "Request body exceeds 64 KiB or could not be read" }, 413);
      }
      const forwarded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
      });
      return await handler.fetch(forwarded);
    } finally {
      concurrent--;
    }
  }

  return {
    async fetch(request: Request, ip = "local"): Promise<Response> {
      let response: Response;
      try {
        response = await route(request, ip);
      } catch {
        response = json({ error: "The MCP request could not be completed" }, 500);
      }
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "private, no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Vary", "Origin");
      const origin = request.headers.get("origin");
      if (origin && config.allowedOrigins.includes(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set(
          "Access-Control-Expose-Headers",
          "MCP-Protocol-Version, WWW-Authenticate, Retry-After",
        );
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
    close: () => handler.close(),
  };
}

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, headers });
}
