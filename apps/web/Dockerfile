# syntax=docker/dockerfile:1

# SeatSync web image. Next.js emits a self-contained standalone server, which is
# copied into a slim runtime image (no pnpm install and no dev dependencies).
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="$PNPM_HOME:$PATH" \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter web...

FROM base AS builder
# Next evaluates rewrites() at build time and bakes the destination into
# routes-manifest.json, so the in-network API target must be present here, not
# only at runtime.
ARG API_PROXY_TARGET=http://localhost:4000
ENV API_PROXY_TARGET=$API_PROXY_TARGET
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/shared ./packages/shared
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
RUN pnpm --filter web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
