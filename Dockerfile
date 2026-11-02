# syntax=docker/dockerfile:1.7
# Sonic Local Engine — reproducible multi-stage image
# Stage 1 builds the production SPA from the committed pnpm lockfile.
# Stage 2 bundles the Node engine from source.
# Stage 3 contains only runtime artefacts and runs as a non-root user.
# Base pinned to the node:22-alpine digest verified by the 2026-11-02 staging build.
# Release callers MUST first run, from the fully extracted archive:
# node scripts/release-inputs.mjs --verify release.json --index release-files.json
# The frontend stage is partial; its supplied release metadata is not a hash check.

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS frontend
ARG PNPM_VERSION=10.34.5
ARG SONIC_RELEASE_COMMIT=unknown
ARG SONIC_BUILD_TIME=
ARG SONIC_RELEASE_ID=
ARG SONIC_SOURCE_DIGEST=
ARG SONIC_RELEASE_DIRTY=
WORKDIR /app/player
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version
COPY player/package.json player/pnpm-lock.yaml player/pnpm-workspace.yaml player/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY player ./
COPY scripts/write-release-manifest.mjs scripts/release-inputs.mjs /app/scripts/
RUN pnpm run build
# A release build must use the digest of the whole source checkout, not this partial stage.
RUN set -eu; \
    if [ "${SONIC_RELEASE_COMMIT}" != "unknown" ]; then \
      SONIC_RELEASE_COMMIT="${SONIC_RELEASE_COMMIT}" SONIC_BUILD_TIME="${SONIC_BUILD_TIME}" \
      SONIC_RELEASE_ID="${SONIC_RELEASE_ID}" SONIC_SOURCE_DIGEST="${SONIC_SOURCE_DIGEST}" \
      SONIC_RELEASE_DIRTY="${SONIC_RELEASE_DIRTY}" node -e \
      'const e=process.env;if(!/^[a-f0-9]{40}$/i.test(e.SONIC_RELEASE_COMMIT)||!Number.isFinite(Date.parse(e.SONIC_BUILD_TIME))||!/^[a-f0-9]{64}$/i.test(e.SONIC_SOURCE_DIGEST)||!/^[a-zA-Z0-9._-]{7,128}$/.test(e.SONIC_RELEASE_ID)||!/^(0|1|true|false)$/.test(e.SONIC_RELEASE_DIRTY))throw Error("Release build requires valid SHA, time, source digest, identity and dirty flag")'; \
      SONIC_RELEASE_COMMIT="${SONIC_RELEASE_COMMIT}" SONIC_BUILD_TIME="${SONIC_BUILD_TIME}" \
      SONIC_RELEASE_ID="${SONIC_RELEASE_ID}" SONIC_SOURCE_DIGEST="${SONIC_SOURCE_DIGEST}" \
      SONIC_RELEASE_DIRTY="${SONIC_RELEASE_DIRTY}" node /app/scripts/write-release-manifest.mjs --partial-docker-stage --output player/dist/release.json; \
    else \
      node -e 'require("node:fs").writeFileSync("dist/release.json",JSON.stringify({schemaVersion:1,baseCommit:"unknown",sourceDigest:"unknown",releaseId:"unknown",buildTime:"unknown",dirty:true})+"\n")'; \
    fi

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS engine
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

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
ARG SONIC_RELEASE_COMMIT=unknown
ARG SONIC_BUILD_TIME=
ARG SONIC_RELEASE_ID=unknown
ARG SONIC_SOURCE_DIGEST=unknown
ARG SONIC_RELEASE_DIRTY=true
LABEL org.opencontainers.image.title="Sonic Local Engine" \
      org.opencontainers.image.revision="${SONIC_RELEASE_COMMIT}" \
      org.opencontainers.image.created="${SONIC_BUILD_TIME}" \
      tech.epocanvas.sonic.release-id="${SONIC_RELEASE_ID}" \
      tech.epocanvas.sonic.source-digest="${SONIC_SOURCE_DIGEST}" \
      tech.epocanvas.sonic.dirty="${SONIC_RELEASE_DIRTY}"
WORKDIR /app
ENV NODE_ENV=production
ENV SONIC_RUNTIME=linux-engine
ENV SONIC_RELEASE_COMMIT=${SONIC_RELEASE_COMMIT}
ENV SONIC_BUILD_TIME=${SONIC_BUILD_TIME}
ENV SONIC_RELEASE_ID=${SONIC_RELEASE_ID}
ENV SONIC_SOURCE_DIGEST=${SONIC_SOURCE_DIGEST}
ENV SONIC_RELEASE_DIRTY=${SONIC_RELEASE_DIRTY}
ENV SONIC_SHUTDOWN_TIMEOUT_MS=60000
ENV PORT=8080
ENV HOST=0.0.0.0
ENV SONIC_RECOMMEND_DB_PATH=/app/data/sonic-recommend.sqlite

COPY --from=frontend /app/player/dist ./dist
COPY --from=engine /app/dist-server ./dist-server
COPY scripts/backup-recommend-db.mjs scripts/restore-recommend-db.mjs scripts/verify-observability-and-alerts.mjs ./scripts/
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
