# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/server/Dockerfile .

# ---- build: install all dependencies, compile TypeScript, then extract a
#      production-only copy of the server (no dev dependencies, no sources)
FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Download dependencies using only the lockfile, so this layer stays cached
# until the lockfile changes, however much the source code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @ins/shared build && pnpm --filter @ins/server build
RUN pnpm --filter @ins/server deploy --prod /out

# ---- runtime: only Node, the compiled server and its production dependencies
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Small, committed scenario files the admin can trigger (for example the Facebook outage).
COPY --chown=node:node deploy/seed/scenarios ./scenarios
ENV SCENARIO_DIR=/app/scenarios

# Never run as root inside the container.
USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
