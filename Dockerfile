FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_HOST=0.0.0.0
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
USER bun
EXPOSE 8788
CMD ["bun", "dist/index.js"]
