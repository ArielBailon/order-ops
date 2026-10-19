# One multi-stage build for the three Nest apps:
#   docker build --build-arg APP=orderops-agent --target runtime -t orderops/orderops-agent .
#   docker build --target tools -t orderops/tools .   (migrate, policy ingest, seed)
# `runtime` is the last stage, so a plain `docker build` also produces a runtime image.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Full source plus the generated Prisma client (gitignored, so it must be built here).
FROM deps AS build
ARG APP
COPY . .
RUN npx prisma generate && npx nest build ${APP}

# The Nest build leaves node_modules packages external, so the runtime image needs them.
FROM deps AS prod-deps
RUN npm prune --omit=dev

# One-off jobs: prisma migrate deploy, npm run ingest:policies, npx prisma db seed.
FROM build AS tools
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false
# The Prisma schema engine needs OpenSSL, which the slim base image lacks. Fetch the engine
# for it now, as root, so the non-root user never has to write into node_modules.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && npx prisma --version
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
ARG APP
ENV APP=${APP}
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
# The build resolves its lazy chunks relative to dist/apps/<app>, so keep that layout.
COPY --from=build /app/dist/apps/${APP} ./dist/apps/${APP}
USER node
# `exec` replaces the shell with node so SIGTERM reaches it directly.
CMD ["sh", "-c", "exec node dist/apps/$APP/main.js"]
