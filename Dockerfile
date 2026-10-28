# syntax=docker/dockerfile:1

# ---- build stage: compiles TypeScript with the dev dependencies present ----
FROM node:24-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: production dependencies and the compiled output only ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Runs unprivileged; the image ships no source, tests or build tooling.
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
