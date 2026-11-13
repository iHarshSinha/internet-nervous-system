# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/web/Dockerfile .

# ---- build: compile the React app to static files
FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/server/package.json apps/server/package.json
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @ins/shared build && pnpm --filter @ins/web build

# ---- runtime: Caddy serves the static files and proxies /api and /socket.io
FROM caddy:2-alpine AS runtime

# Never run as root inside the container. The official image lets the caddy
# binary bind ports 80 and 443 without root.
RUN addgroup -S caddy && adduser -S -G caddy caddy \
  && mkdir -p /data /config \
  && chown -R caddy:caddy /data /config

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv

USER caddy
EXPOSE 8080

# Caddy's admin API listens on localhost:2019 whatever the site address is.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:2019/config/ || exit 1
