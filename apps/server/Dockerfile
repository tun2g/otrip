# @otrip/server — Colyseus room server (port 2567).
#
# Build context is the monorepo ROOT (pnpm workspace), so this is built with:
#   docker build -f apps/server/Dockerfile .
#
# No build step: the server runs TypeScript directly through Node's type
# stripping, which is also what lets it share @otrip/world source with the web
# app and generate the identical terrain.

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/theme/package.json packages/theme/package.json
COPY packages/world/package.json packages/world/package.json
RUN pnpm install --frozen-lockfile --filter @otrip/server...

FROM deps AS runner
COPY apps/server/src apps/server/src
COPY packages/world/src packages/world/src
COPY packages/contracts/src packages/contracts/src
ENV NODE_ENV=production
USER node
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:2567/health || exit 1
CMD ["node", "--experimental-strip-types", "apps/server/src/main.ts"]
