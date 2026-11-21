# Built from the REPOSITORY ROOT, same reason as the viewer's Dockerfile: npm
# workspaces need the root package.json and lockfile to resolve.
#   docker build -f applications/ingest/Dockerfile -t metrion-ingest .

FROM node:22-alpine AS build
WORKDIR /repo

# Manifests first, so a dependency install is only re-run when a manifest
# actually changes rather than on every source edit.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY applications/ingest/package.json applications/ingest/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY applications/ingest applications/ingest

RUN npm run build --workspace @metrion/db \
 && npm run build --workspace @metrion/ingest

FROM node:22-alpine AS runtime
# The base image's own npm carries unpatched dependencies and nothing here runs npm after the install below, so it is removed; OS packages are upgraded for the same reason.
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only: no TypeScript, no test tooling in the image
# that faces the internet.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY applications/ingest/package.json applications/ingest/
RUN npm ci --omit=dev --workspace @metrion/ingest --include-workspace-root \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --from=build /repo/applications/ingest/dist ./dist
# @metrion/db is a REAL runtime dependency here (unlike @metrion/shared, which
# is type-only and erases completely) - the compiled pool.js has to actually
# be on disk at the workspace symlink's target for `createPool()` to resolve.
COPY --from=build /repo/packages/db/dist ./packages/db/dist
# `/app/package.json` is the workspace root manifest and has no `"type":
# "module"`, so without this marker Node reparses every compiled file as ESM
# after first failing to read it as CommonJS - it works, but it warns on every
# boot and pays the reparse cost. Same trap as the viewer's and the
# collector's deploys (see organizational/deployment-runbook.md).
RUN echo '{"type":"module"}' > ./dist/package.json

# node:alpine ships an unprivileged `node` user. Running as root in a
# container that serves the public internet buys nothing.
USER node

EXPOSE 8090
CMD ["node", "dist/main.js"]
