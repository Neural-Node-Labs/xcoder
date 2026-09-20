# --- CodeGraph Explorer UI build stage -----------------------------------------
# The Explorer is served BY this api container at /codegraph-ui (see server.ts), so its static
# bundle has to be inside this image — previously it wasn't copied in at all, which is why the
# embedded Explorer came up as an empty panel under docker-compose (the mount 404'd).
# --base=/codegraph-ui/ is required: without it Vite emits /assets/... URLs, which resolve
# against the xcoder SPA's root instead of this mount and the page renders blank.
FROM node:20-slim AS codegraph-ui-build
WORKDIR /cgui
COPY integrations/codegraph/codegraph-ui/package.json integrations/codegraph/codegraph-ui/package-lock.json ./
RUN npm ci
COPY integrations/codegraph/codegraph-ui/ ./
RUN npx vite build --base=/codegraph-ui/

# --- Build stage -------------------------------------------------------------
FROM kalilinux/kali-rolling AS build
WORKDIR /app

# Install Node.js, npm, and build tools
RUN apt-get update && apt-get install -y \
  curl \
  gnupg \
  nodejs \
  npm \
  && rm -rf /var/lib/apt/lists/*

# Install ALL dependencies (including devDependencies needed for compiling)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies
RUN npm prune --omit=dev

# --- Runtime stage -------------------------------------------------------------
FROM kalilinux/kali-rolling AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install Node.js and runtime utilities
RUN apt-get update && apt-get install -y \
  curl \
  gnupg \
  nodejs \
  npm \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Resolves to integrations/codegraph/codegraph-ui/dist relative to dist/api/ — see
# CODEGRAPH_UI_DIST in src/api/codegraphProcess.ts. Only the built static files, not the source.
COPY --from=codegraph-ui-build /cgui/dist ./integrations/codegraph/codegraph-ui/dist
COPY package.json ./
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Runs as a non-root user
RUN useradd --create-home --shell /bin/bash xcoder \
  && chown -R xcoder:xcoder /app
USER xcoder

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://localhost:3001/api/v1/health').then(r=>{if(!r.ok)throw new Error(String(r.status))}).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/cli/index.js", "--serve"]