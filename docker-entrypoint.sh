#!/bin/sh
# xcoder container entrypoint.
#
# 1. Resolves an allowlisted set of Docker-secrets-style `${VAR}_FILE`
#    pointers into `${VAR}` (e.g. DATABASE_PASSWORD_FILE=/run/secrets/db_password
#    -> DATABASE_PASSWORD=...). See XCODER_SECRET_VARS below for the list.
# 2. Waits for PostgreSQL to accept connections.
# 3. Runs `--initialize-db` (idempotent — safe on every restart).
# 4. execs the requested command.
set -e

# Explicit allowlist of variables that may be supplied as Docker secrets via
# the `${VAR}_FILE` convention. Deliberately NOT a blanket match on every
# `*_FILE` env var in the container — unrelated tooling vars (SSL_CERT_FILE,
# PIP_CONFIG_FILE, etc.) could otherwise be swept up unintentionally. Add to
# this list if you configure a custom `api_key_env` name in agent/config/llm.yaml.
XCODER_SECRET_VARS="DATABASE_PASSWORD DATABASE_URL ANTHROPIC_API_KEY OPENAI_API_KEY DEEPSEEK_API_KEY OPENROUTER_API_KEY GROQ_API_KEY"

resolve_secret_files_into_env() {
  tmpfile=$(mktemp)
  for base_name in $XCODER_SECRET_VARS; do
    file_var="${base_name}_FILE"
    file_path=$(eval echo "\$$file_var")
    if [ -z "$file_path" ]; then
      continue
    fi
    if [ ! -f "$file_path" ]; then
      echo "[entrypoint] Warning: $file_var points to '$file_path', which does not exist. Skipping." >&2
      continue
    fi
    # Escape single quotes in the secret value, then single-quote the whole thing.
    value=$(cat "$file_path" | sed "s/'/'\\\\''/g")
    echo "export $base_name='$value'" >> "$tmpfile"
    echo "[entrypoint] Loaded $base_name from $file_var"
  done
  if [ -s "$tmpfile" ]; then
    . "$tmpfile"
  fi
  rm -f "$tmpfile"
}

resolve_secret_files_into_env

wait_for_postgres() {
  host="${DATABASE_HOST:-localhost}"
  port="${DATABASE_PORT:-5432}"

  # If DATABASE_URL is set instead of discrete host/port vars, skip the
  # host:port probe (we can't easily parse it in POSIX sh) and just retry
  # the actual init step below.
  if [ -n "$DATABASE_URL" ]; then
    return 0
  fi

  echo "[entrypoint] Waiting for PostgreSQL at ${host}:${port}..."
  attempt=0
  max_attempts=30
  until node -e "
    const net = require('node:net');
    const s = net.connect({ host: process.argv[1], port: Number(process.argv[2]) }, () => { s.end(); process.exit(0); });
    s.on('error', () => process.exit(1));
  " "$host" "$port"; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "[entrypoint] PostgreSQL did not become available after ${max_attempts} attempts." >&2
      exit 1
    fi
    sleep 1
  done
  echo "[entrypoint] PostgreSQL is accepting connections."
}

wait_for_postgres

echo "[entrypoint] Running database initialization (idempotent)..."
node dist/cli/index.js --initialize-db

echo "[entrypoint] Starting: $*"
exec "$@"
