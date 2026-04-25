# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for @duongbkak55/ai-proxy.
# Builder: node:20-alpine compiles TypeScript.
# Runtime: distroless minimal Node image.

FROM node:20-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev deps for runtime image
RUN npm prune --omit=dev

FROM gcr.io/distroless/nodejs20-debian12:nonroot
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./

EXPOSE 11434
USER nonroot
ENV NODE_ENV=production

# Pass --config via CMD or env. Default config path: /etc/omc-proxy/config.jsonc
ENTRYPOINT ["/nodejs/bin/node", "dist/cli.js"]
CMD ["start", "--config", "/etc/omc-proxy/config.jsonc"]
