import { z } from "zod";
import type { Config } from "./config";
import { DiscoveryError } from "./errors";
import { type Fetcher, readBounded } from "./upstream";

export const PRIVATE_SCOPES: Record<string, readonly string[]> = {
  get_credits: ["credits:read"],
  get_task: ["tasks:read"],
  read_asset: ["assets:read"],
  quote_generation: ["generation:create"],
  generate_image: ["generation:create"],
};
const principalSchema = z.object({
  userId: z.string(),
  clientId: z.string(),
  connectionId: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
});
export type AccountPrincipal = z.infer<typeof principalSchema>;

export class AccountError extends DiscoveryError {
  constructor(
    code: string,
    message: string,
    public readonly status: number,
    retryable = false,
  ) {
    super(code, message, retryable);
  }
}

export class AccountService {
  constructor(
    private readonly config: Config,
    private readonly fetcher: Fetcher = fetch,
  ) {}
  metadata() {
    return {
      resource: this.config.resourceUrl,
      authorization_servers: [this.config.issuerUrl],
      scopes_supported: [
        "catalog:read",
        "credits:read",
        "tasks:read",
        "assets:read",
        "generation:create",
      ],
      bearer_methods_supported: ["header"],
    };
  }
  challenge(status = 401, scopes: readonly string[] = []) {
    const url = new URL(this.config.resourceUrl);
    return Response.json(
      {
        code: status === 403 ? "INSUFFICIENT_SCOPE" : "AUTH_REQUIRED",
        error: "Connect your Inspia account with the required permissions",
      },
      {
        status,
        headers: {
          "Cache-Control": "private, no-store",
          "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"${scopes.length ? `, scope="${scopes.join(" ")}"` : ""}${status === 403 ? ', error="insufficient_scope"' : ""}`,
        },
      },
    );
  }
  async authenticate(token: string): Promise<AccountPrincipal> {
    const p = principalSchema.parse(await this.request("/api/mcp/access", token));
    if (p.expiresAt <= Date.now() / 1000)
      throw new AccountError("INVALID_TOKEN", "Authorization expired", 401);
    return p;
  }
  async request(
    path: string,
    token: string,
    body?: Record<string, unknown>,
    params?: URLSearchParams,
  ): Promise<Record<string, unknown>> {
    if (!/^Bearer [A-Za-z0-9_.-]+$/.test(token) || token.length > 16391)
      throw new AccountError("INVALID_TOKEN", "Invalid authorization", 401);
    if (
      ![
        "/api/mcp/access",
        "/api/mcp/credits",
        "/api/mcp/tasks",
        "/api/mcp/quotes",
        "/api/mcp/generate",
      ].includes(path) &&
      !/^\/api\/mcp\/assets\/[0-9a-f-]{36}$/.test(path)
    )
      throw new AccountError("INVALID_REQUEST", "Invalid account endpoint", 400);
    const url = new URL(path, this.config.upstreamOrigin);
    if (params) url.search = params.toString();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: token,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        throw new AccountError(
          "ACCOUNT_UNAVAILABLE",
          "Inspia returned an unexpected account response",
          503,
          true,
        );
      }
      const data: unknown = JSON.parse(await readBounded(response, 2 * 1024 * 1024));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Invalid account response");
      const record = data as Record<string, unknown>;
      if (!response.ok) {
        const code =
          typeof record.code === "string" && /^[A-Z_]{1,80}$/.test(record.code)
            ? record.code
            : "ACCOUNT_UNAVAILABLE";
        const message =
          response.status === 401
            ? "Reconnect your Inspia account"
            : response.status === 403
              ? "Additional account permissions are required"
              : response.status >= 500
                ? "Inspia account services are temporarily unavailable"
                : typeof record.error === "string"
                  ? record.error.slice(0, 300)
                  : "The account request was rejected";
        throw new AccountError(
          code,
          message,
          response.status,
          response.status >= 500 || response.status === 429,
        );
      }
      return record;
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      throw new AccountError(
        "ACCOUNT_UNAVAILABLE",
        "The Inspia account request failed or timed out",
        503,
        true,
      );
    }
  }
}
