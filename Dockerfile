# syntax=docker/dockerfile:1
# One image for hosts that run a single container per service (Railway): the
# server (Express + Socket.IO + ingest thread) also serves the built web app,
# so the browser talks to one origin. The Compose stack uses
# apps/server/Dockerfile and apps/web/Dockerfile (Caddy) instead.
#
#   docker build -t ins .
#   docker run -p 3000:3000 -e MONGODB_URI=... ins

# ---- build: install, compile the shared contracts, the server and the web app
FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Dependencies from the lockfile only, so this layer stays cached until it changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @ins/shared build \
  && pnpm --filter @ins/server build \
  && pnpm --filter @ins/web build \
  && node apps/web/scripts/precompress.mjs
# A production-only copy of the server: compiled code and its runtime dependencies.
RUN pnpm --filter @ins/server deploy --prod /out

# ---- runtime: Node, the server, the web app's static files
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/apps/web/dist ./web
COPY --chown=node:node deploy/seed/scenarios ./scenarios
ENV WEB_DIR=/app/web SCENARIO_DIR=/app/scenarios

# Never run as root inside the container.
USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
