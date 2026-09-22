#!/usr/bin/env bash
# Installs xcoder as a background daemon — no Docker required. Builds it in place (unless
# --skip-build) and registers it with the host's own service manager:
#   Linux (systemd)  -> a system service, /etc/systemd/system/xcoder.service, running as its
#                       own unprivileged "xcoder" user, restarted on failure and on boot.
#   macOS (launchd)  -> a per-user LaunchAgent, running as whichever user runs this script.
#   Anything else    -> prints the foreground run command instead (Windows: see STANDALONE.md
#                       for NSSM/pm2/Task Scheduler options — this script doesn't set up a
#                       native Windows service).
#
# Usage:
#   sudo scripts/install.sh                       # Linux, systemd, default port 3001, --ui mode
#   scripts/install.sh                             # macOS, launchd (no sudo needed/used)
#   scripts/install.sh --serve-only                # API only, no dashboard (see --ui vs --serve
#                                                   #   in src/cli/index.ts)
#   scripts/install.sh --skip-build                # reuse an already-built tree
#   scripts/install.sh --with-codegraph-python      # forwarded to build-standalone.sh
#
# Safe to re-run: rebuilds and restarts the existing service/agent rather than erroring.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SKIP_BUILD=0
EXEC_MODE="--ui"
BUILD_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --serve-only) EXEC_MODE="--serve" ;;
    --with-codegraph-python) BUILD_ARGS+=("--with-codegraph-python") ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--skip-build] [--serve-only] [--with-codegraph-python]" >&2
      exit 1
      ;;
  esac
done

log() { echo "[install] $*"; }

if [ "$SKIP_BUILD" -eq 0 ]; then
  "$ROOT_DIR/scripts/build-standalone.sh" "${BUILD_ARGS[@]}"
else
  log "Skipping build (--skip-build) — reusing whatever is already in dist/, ui/dist/, etc."
fi

OS="$(uname -s)"
NODE_PATH="$(command -v node)"

# ─── Linux: systemd ───────────────────────────────────────────────────────────────────────
if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "[install] Linux + systemd detected — this needs root to create the service user and" >&2
    echo "[install] write /etc/systemd/system/xcoder.service. Re-run with sudo, e.g.:" >&2
    echo "[install]   sudo scripts/install.sh $*" >&2
    exit 1
  fi

  SERVICE_USER="xcoder"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Creating system user '$SERVICE_USER' (no login shell, no home directory needed)..."
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi

  log "Setting ownership of $ROOT_DIR to $SERVICE_USER (so the daemon can write logs/reports/.agent under it)..."
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$ROOT_DIR"

  UNIT_PATH="/etc/systemd/system/xcoder.service"
  log "Writing $UNIT_PATH..."
  sed \
    -e "s#__INSTALL_DIR__#$ROOT_DIR#g" \
    -e "s#__SERVICE_USER__#$SERVICE_USER#g" \
    -e "s#__EXEC_MODE__#$EXEC_MODE#g" \
    "$ROOT_DIR/scripts/xcoder.service.template" > "$UNIT_PATH"

  systemctl daemon-reload
  systemctl enable xcoder
  systemctl restart xcoder

  log "Done. xcoder is running as a systemd service."
  log "  Status:  systemctl status xcoder"
  log "  Logs:    journalctl -u xcoder -f"
  log "  Restart: systemctl restart xcoder"
  log "  Remove:  scripts/uninstall.sh"
  exit 0
fi

# ─── macOS: launchd ────────────────────────────────────────────────────────────────────────
if [ "$OS" = "Darwin" ]; then
  mkdir -p "$ROOT_DIR/logs"
  AGENTS_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$AGENTS_DIR"
  PLIST_PATH="$AGENTS_DIR/com.xcoder.daemon.plist"

  log "Writing $PLIST_PATH..."
  sed \
    -e "s#__INSTALL_DIR__#$ROOT_DIR#g" \
    -e "s#__NODE_PATH__#$NODE_PATH#g" \
    -e "s#__EXEC_MODE__#$EXEC_MODE#g" \
    "$ROOT_DIR/scripts/xcoder.plist.template" > "$PLIST_PATH"

  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl load -w "$PLIST_PATH"

  log "Done. xcoder is running as a launchd agent (starts on login, restarts on crash)."
  log "  Logs:    tail -f $ROOT_DIR/logs/xcoder.out.log $ROOT_DIR/logs/xcoder.err.log"
  log "  Restart: launchctl kickstart -k gui/\$(id -u)/com.xcoder.daemon"
  log "  Remove:  scripts/uninstall.sh"
  exit 0
fi

# ─── Anything else (Windows, non-systemd Linux, etc.) ──────────────────────────────────────
log "No supported native service manager detected on this OS ($OS)."
log "The build itself is complete and Docker-free — run it directly, in the foreground or"
log "under a process manager of your choice (pm2, NSSM on Windows, a screen/tmux session, etc.):"
log "  cd $ROOT_DIR && node dist/cli/index.js $EXEC_MODE"
log "See STANDALONE.md for details."
