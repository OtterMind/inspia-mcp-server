import { z } from "zod";
import { DiscoveryError } from "./errors";

export const MAX_MCP_CURSOR_CHARS = 6000;
export const MAX_UPSTREAM_CURSOR_CHARS = 2048;
export const CURSOR_TTL_MS = 15 * 60_000;

export const mcpCursorSchema = z.string().min(1).max(MAX_MCP_CURSOR_CHARS);
export const upstreamCursorSchema = z.string().min(1).max(MAX_UPSTREAM_CURSOR_CHARS);

export function unsupportedUpstreamCursor() {
  return new DiscoveryError(
    "UPSTREAM_CURSOR_UNSUPPORTED",
    "Inspia cannot paginate this query within the supported cursor size. Shorten the query or filters and start a new search.",
  );
}
