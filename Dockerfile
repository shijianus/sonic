# syntax=docker/dockerfile:1.7
# Sonic Local Engine — reproducible multi-stage image
# Stage 1 builds the production SPA from the committed pnpm lockfile.
# Stage 2 bundles the Node engine from source.
# Stage 3 contains only runtime artefacts and runs as a non-root user.

FROM node:22-alpine AS frontend
ARG PNPM_VERSION=10.34.5
WORKDIR /app/player
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version
COPY player/package.json player/pnpm-lock.yaml player/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY player ./
RUN pnpm run build

FROM node:22-alpine AS engine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY functions ./functions
COPY server ./server
COPY tsconfig.json ./
RUN ./node_modules/.bin/esbuild server/index.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --outfile=dist-server/index.mjs \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SONIC_RUNTIME=linux-engine
ENV PORT=8080
ENV HOST=0.0.0.0
ENV SONIC_RECOMMEND_DB_PATH=/app/data/sonic-recommend.sqlite

COPY --from=frontend /app/player/dist ./dist
COPY --from=engine /app/dist-server ./dist-server
COPY scripts/backup-recommend-db.mjs ./scripts/
COPY favicon.png favicon.svg ./dist/
COPY LICENSE THIRD_PARTY_NOTICES.md package.json ./
RUN mkdir -p /app/data \
  && chown -R node:node /app/data \
  && chown -R node:node /app/dist /app/dist-server

USER node
EXPOSE 8080
STOPSIGNAL SIGTERM

# Read the service key from the environment instead of embedding it in the process argv.
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/sonic/engine/health',{headers:{'X-Sonic-Engine-Key':process.env.SONIC_ENGINE_SECRET||''}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "dist-server/index.mjs"]
