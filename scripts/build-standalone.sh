#!/usr/bin/env bash
# Builds xcoder into a ready-to-run tree WITHOUT Docker — the bare-metal equivalent of what
# Dockerfile's build stage does, run in place on this checkout instead of inside a container
# image. After this finishes, `node dist/cli/index.js --serve` (or --ui) is a complete,
# self-contained server: it serves its own API, its own dashboard (ui/dist), and the embedded
# CodeGraph Explorer (integrations/codegraph/codegraph-ui/dist) all from one process/port — see
# server.ts's XCODER_UI_DIST / CODEGRAPH_UI_DIST mounts.
#
# Usage:
#   scripts/build-standalone.sh              # backend + dashboard + CodeGraph Explorer UI
#   scripts/build-standalone.sh --with-codegraph-python
#                                             # also provisions the CodeGraph Python venv
#                                             # (integrations/codegraph/codegraph + codegraph-mcp)
#                                             # so CodeGraph itself can run without Docker too —
#                                             # requires python3 + pip on this machine.
#   scripts/build-standalone.sh --prod-only   # after building, prune devDependencies from
#                                             # node_modules (smaller footprint; skip this if
#                                             # you'll keep developing/testing in this checkout)
#
# See STANDALONE.md for what this produces and how to run/install it as a daemon.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WITH_CODEGRAPH_PYTHON=0
PROD_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --with-codegraph-python) WITH_CODEGRAPH_PYTHON=1 ;;
    --prod-only) PROD_ONLY=1 ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--with-codegraph-python] [--prod-only]" >&2
      exit 1
      ;;
  esac
done

log() { echo "[build-standalone] $*"; }

# ─── 1. Node.js version check ────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "[build-standalone] node was not found on PATH. Install Node.js 20+ first (see STANDALONE.md)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[build-standalone] Found Node.js $(node -v), but xcoder requires >=20 (see package.json's \"engines\")." >&2
  exit 1
fi
log "Node.js $(node -v) OK"

# ─── 2. Backend (src/ -> dist/) ──────────────────────────────────────────────────────────
log "Installing backend dependencies..."
npm ci
log "Compiling backend (tsc)..."
npm run build

# ─── 3. Dashboard (ui/ -> ui/dist/) ──────────────────────────────────────────────────────
log "Building dashboard (ui/)..."
npm run ui:build

# ─── 4. Embedded CodeGraph Explorer (integrations/codegraph/codegraph-ui -> .../dist/) ───
log "Building embedded CodeGraph Explorer..."
npm run codegraph:ui:build

# ─── 5. Optional: CodeGraph's own Python backend ─────────────────────────────────────────
if [ "$WITH_CODEGRAPH_PYTHON" -eq 1 ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "[build-standalone] --with-codegraph-python was given but python3 was not found on PATH." >&2
    exit 1
  fi
  log "Provisioning CodeGraph's Python venv..."
  npm run codegraph:install
else
  log "Skipping CodeGraph's Python backend (pass --with-codegraph-python to include it)."
fi

# ─── 6. .env ──────────────────────────────────────────────────────────────────────────────
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  log "Created .env from .env.example — edit it before running as a daemon (DATABASE_*, an LLM API key or Ollama, XCODER_TOKEN_TTL_MS, etc.)."
fi

# ─── 7. Optional: prune devDependencies ──────────────────────────────────────────────────
if [ "$PROD_ONLY" -eq 1 ]; then
  log "Pruning devDependencies from node_modules..."
  npm prune --omit=dev
fi

log "Done. Everything needed to run is in this checkout — no Docker required:"
log "  node dist/cli/index.js --serve   # API only"
log "  node dist/cli/index.js --ui      # API + dashboard, same process/port"
log "See STANDALONE.md for running this as a background daemon (systemd/launchd)."
