# Phase 3 T3.14 — multi-stage build for Cloud Run. Distroless runtime so
# only Node + the bundled JS ships; ~80 MB image vs ~400 MB for full slim.

# ---- builder ----
FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@11

# Copy workspace metadata first for cache-friendly install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/game-rules/package.json ./packages/game-rules/

RUN pnpm install --frozen-lockfile \
    --filter @kc/api --filter @kc/game-rules \
    --config.node-linker=hoisted

# Copy sources and build.
COPY packages/game-rules ./packages/game-rules
COPY packages/api ./packages/api

# Build game-rules first → dist/. Required because @kc/game-rules' exports
# map points at compiled JS (Node 22 refuses to strip TS types from files
# under node_modules at runtime).
RUN pnpm --filter @kc/game-rules build
RUN pnpm --filter @kc/api build

# Prune dev deps. `--legacy` for non-injected workspaces (pnpm 11+).
# `node-linker=hoisted` keeps optionalDependencies (napi-rs platform-specific
# native modules) directly under node_modules/ so runtime require() works.
RUN pnpm --filter @kc/api deploy --prod --legacy \
    --config.node-linker=hoisted /app/deploy

# ---- runtime ----
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app

COPY --from=builder /app/deploy/dist ./dist
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /app/deploy/package.json ./

ENV NODE_ENV=production
EXPOSE 8080

USER nonroot
CMD ["dist/main.js"]
