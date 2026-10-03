# One image, one origin: the API and the built client are served by the same
# Express process. That is what makes CORS unnecessary in production and what
# makes `maxReplicas: 1` coherent - there is one thing to deploy, not two that
# have to agree on a version.
#
# Built from the REPOSITORY ROOT, not from this directory, because npm
# workspaces need the root package.json and lockfile to resolve:
#   docker build -f applications/viewer/Dockerfile -t metrion-viewer .

FROM node:22-alpine AS build
WORKDIR /repo

# Manifests first, so a dependency install is only re-run when a manifest
# actually changes rather than on every source edit.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY applications/agent/package.json applications/agent/
COPY applications/viewer/package.json applications/viewer/
COPY applications/viewer/client/package.json applications/viewer/client/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY applications/viewer applications/viewer

# @metrion/db first: the viewer's tsconfig.build.json references it as a
# project (tsc -b resolves that reference on disk, same trap the ingest
# Dockerfile already accounts for), and its own DB access
# (applications/viewer/src/lib/db.ts) imports @metrion/db at runtime, not just
# at the type level - unlike @metrion/shared, which erases completely.
#
# The client is built by Vite and is deliberately outside the root `tsc -b`
# project graph, so JSX never enters the collector's build. Build the server
# and the client separately, each with its own toolchain.
RUN npm run build --workspace @metrion/db \
 && npm run build --workspace @metrion/viewer \
 && npm run build --workspace @metrion/viewer-client

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only: no TypeScript, no Vite, no test tooling in the
# image that faces the internet.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY applications/agent/package.json applications/agent/
COPY applications/viewer/package.json applications/viewer/
COPY applications/viewer/client/package.json applications/viewer/client/
RUN npm ci --omit=dev --workspace @metrion/viewer --include-workspace-root \
 && npm cache clean --force

COPY --from=build /repo/applications/viewer/dist ./dist
# Same reason as the ingest Dockerfile: @metrion/db is a real runtime
# dependency here, not type-only, so the compiled pool.js has to actually be
# on disk at the workspace symlink's target for `createPool()` to resolve.
COPY --from=build /repo/packages/db/dist ./packages/db/dist
# `/app/package.json` is the workspace root manifest and has no `"type":
# "module"`, so without this marker Node reparses every compiled file as ESM
# after first failing to read it as CommonJS - it works, but it warns on every
# boot and pays the reparse cost. Same trap, and same fix, as the collector's
# deploy (see organizational/deployment-runbook.md).
RUN echo '{"type":"module"}' > ./dist/package.json
# The client's built assets, where `static-frontend.ts` looks for them: a
# `public/` sibling of `dist/`.
COPY --from=build /repo/applications/viewer/client/dist ./public

# The legal documents the /impressum, /privacy, /terms and /third-party-notices routes render. They
# MUST be in the image: Austrian ECG requires the Impressum to be reachable
# from the deployed site, and without this copy those routes 404 in production
# while passing every local test.
COPY IMPRESSUM.md PRIVACY.md TERMS_OF_USE.md THIRD_PARTY_NOTICES.md ./

# node:alpine ships an unprivileged `node` user. Running as root in a
# container that serves the public internet buys nothing.
USER node

EXPOSE 8080
CMD ["node", "dist/main.js"]
