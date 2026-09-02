# ─── xcoder dashboard image ─────────────────────────────────────────────────
# Multi-stage build: compile the Vite/React app, then serve the static bundle
# with nginx, proxying /api to the xcoder API container.

# --- Build stage -------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime stage -------------------------------------------------------------
# nginxinc/nginx-unprivileged runs the whole nginx process (master included) as
# a non-root user and listens on an unprivileged port by default.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://localhost:8080/ || exit 1
