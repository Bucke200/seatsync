# syntax=docker/dockerfile:1

# SeatSync API image.
#
# Decision: the API runs through `tsx` (rather than a tsc-compiled dist). The
# workspace package `@seatsync/shared` ships TypeScript source, so compiling
# only `apps/api` would leave an unresolvable TS import at runtime. tsx is
# already the dev runner and resolves workspace TS files exactly like `pnpm dev`.
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="$PNPM_HOME:$PATH" \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.8.1 --activate
WORKDIR /app

# Install only the api workspace and its workspace dependencies from the root
# lockfile, so the image can never drift from the checked-in dependency graph.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter api...

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

# pnpm's workspace layout uses relative symlinks; copy the root store, the api's
# links and the shared package directory together so those links still resolve.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared ./packages/shared

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY apps/api/src ./apps/api/src
COPY apps/api/migrations ./apps/api/migrations
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/shared/src ./packages/shared/src

WORKDIR /app/apps/api
EXPOSE 4000
USER node
CMD ["node", "--import", "tsx", "src/server.ts"]
