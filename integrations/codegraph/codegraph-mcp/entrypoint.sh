#!/bin/sh
set -e

CODEGRAPH_API_URL="${CODEGRAPH_API_URL:-http://localhost:8000}"

# In docker-compose, CODEGRAPH_API_KEY is deliberately NOT set — codegraph-api generates its
# admin's real API key the first time it boots (there's no way to know it ahead of time), so
# this container logs in as that admin itself to fetch one. Anyone running the image directly
# with a key they already have (the README's "Option A: Docker" flow) can still pass
# CODEGRAPH_API_KEY explicitly and this step is skipped entirely.
if [ -z "$CODEGRAPH_API_KEY" ]; then
  if [ -z "$ADMIN_PASSWORD" ]; then
    echo "[codegraph-mcp] Neither CODEGRAPH_API_KEY nor ADMIN_PASSWORD is set — cannot authenticate to $CODEGRAPH_API_URL." >&2
    exit 1
  fi
  echo "[codegraph-mcp] CODEGRAPH_API_KEY not set — logging in to $CODEGRAPH_API_URL as admin to fetch one ..." >&2
  # Declared and assigned separately (not `export VAR="$(cmd)"` in one statement) so a failure
  # in fetch_api_key.py actually aborts the script under `set -e` — combining them masks the
  # command substitution's exit status behind `export`'s own (near-always-successful) one,
  # which would otherwise let this silently continue into `exec python3 server.py` with an
  # empty/broken CODEGRAPH_API_KEY instead of failing loudly here.
  FETCHED_API_KEY="$(python3 fetch_api_key.py "$CODEGRAPH_API_URL" "$ADMIN_PASSWORD")"
  export CODEGRAPH_API_KEY="$FETCHED_API_KEY"
  echo "[codegraph-mcp] Got API key." >&2
fi

exec python3 server.py
