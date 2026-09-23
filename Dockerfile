# syntax=docker/dockerfile:1
#
# Production image for the storefront. Multi-stage so the runtime layer carries
# no compiler, no dev dependencies and no source, and runs as an unprivileged
# user. The same image is used for the app, for `npm run migrate` on deploy and
# for the retention purge container; only the command differs.

# --- dependencies -----------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# --- production dependencies only -------------------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# tini keeps signal handling sane so `compose restart` does not orphan a
# half-finished request or a running purge.
RUN apk add --no-cache tini

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist         ./dist
COPY package.json ./

# Not compiled by tsc, but needed at runtime. Paths are kept identical to the
# repo layout so template and asset lookups resolve the same in dev and prod.
COPY src/views          ./src/views
COPY src/public         ./src/public
COPY db/migrations      ./db/migrations

# uploads and exports are volumes in docker-compose.yml; create them owned by
# the runtime user so the app can write without running as root.
RUN mkdir -p src/public/uploads exports \
    && chown -R node:node /app/src/public/uploads /app/exports

USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/main.js"]
