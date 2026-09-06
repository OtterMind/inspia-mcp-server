import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp(config);
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: 64 * 1024,
  idleTimeout: 60,
  fetch: (request, server) => app.fetch(request, server.requestIP(request)?.address ?? "unknown"),
});
console.info(`Inspia Discovery MCP 0.1.0 listening at ${server.url}mcp`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await server.stop(true);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
