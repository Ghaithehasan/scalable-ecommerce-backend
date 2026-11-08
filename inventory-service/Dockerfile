# syntax=docker/dockerfile:1
#
# IMPORTANT: the build context is the REPOSITORY ROOT, not this directory,
# because proto/ is shared with the main application and must not be copied
# into this package. Build it with:
#
#   docker build -f inventory-service/Dockerfile -t inventory-service .
#
# docker-compose.yml in this directory already sets `context: ..`.

# ---- build stage: compiles TypeScript with the dev dependencies present ----
FROM node:24-slim AS builder
WORKDIR /app

COPY inventory-service/package.json inventory-service/package-lock.json ./
# The cache mount and retry settings are not cosmetic. On a slow or unreliable
# link a single dropped connection fails the whole install (ECONNRESET), and
# without a persistent npm cache every retry starts downloading from scratch.
# The mount keeps already-fetched tarballs between attempts.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000

COPY inventory-service/tsconfig.json inventory-service/tsconfig.build.json ./
COPY inventory-service/nest-cli.json ./
COPY inventory-service/src ./src
RUN npm run build

# ---- runtime stage: production dependencies and compiled output only -------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copying from the builder FIRST is deliberate: it makes BuildKit finish that
# stage before this one starts. Otherwise the two npm installs run in parallel
# and compete for the same bandwidth. Serialised, this second install is served
# almost entirely from the shared npm cache mount above.
COPY --from=builder /app/dist ./dist

COPY inventory-service/package.json inventory-service/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000

# The contract travels with the image so the server can load it at startup.
# buf and ts-proto are NOT needed here: src/generated is committed and was
# already compiled in the builder stage.
COPY proto ./proto
ENV PROTO_DIR=/app/proto

ENV GRPC_HOST=0.0.0.0
ENV GRPC_PORT=50051

USER node
EXPOSE 50051
CMD ["node", "dist/main"]
