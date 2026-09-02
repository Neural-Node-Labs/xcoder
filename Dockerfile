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