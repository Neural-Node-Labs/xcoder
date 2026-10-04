# ---- build: compile TypeScript (agent + kernel); the UI lives in xcoder's AGI tab ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY kernel ./kernel
COPY scripts ./scripts
RUN npm run build

# ---- production deps only ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:20-alpine
RUN apk add --no-cache tini \
 && addgroup -g 1001 agi && adduser -D -u 1001 -G agi agi
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Kernel + code are root-owned and read-only: the agent (uid 1001) cannot modify them.
RUN chown -R root:root /app && chmod -R a-w /app
ENV NODE_ENV=production DATA_DIR=/data AGENT_UID=1001 AGENT_GID=1001
EXPOSE 7000
# PID 1 = supervisor (runs as root, drops the agent to uid 1001)
ENTRYPOINT ["/sbin/tini", "--", "node", "dist/kernel/supervisor.js"]
