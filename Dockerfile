# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION}-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock tsconfig.json mikro-orm.config.ts ./
COPY --chown=bun:bun migrations ./migrations
COPY --chown=bun:bun src ./src
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
