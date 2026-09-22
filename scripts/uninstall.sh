#!/usr/bin/env bash
# Removes whatever scripts/install.sh registered — the systemd service (Linux) or launchd
# agent (macOS). Does NOT delete the checkout, dist/ build output, .env, or the "xcoder" system
# user (Linux) — only unregisters the daemon itself, so re-running install.sh afterward is a
# clean re-install rather than needing to rebuild from scratch.
set -euo pipefail

log() { echo "[uninstall] $*"; }

OS="$(uname -s)"

if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "[uninstall] Removing the systemd unit needs root. Re-run with sudo." >&2
    exit 1
  fi
  if systemctl list-unit-files xcoder.service >/dev/null 2>&1 && systemctl list-unit-files xcoder.service | grep -q xcoder; then
    log "Stopping and disabling xcoder.service..."
    systemctl stop xcoder || true
    systemctl disable xcoder || true
    rm -f /etc/systemd/system/xcoder.service
    systemctl daemon-reload
    log "Removed. (The 'xcoder' system user and this checkout were left in place.)"
  else
    log "No xcoder.service found — nothing to do."
  fi
  exit 0
fi

if [ "$OS" = "Darwin" ]; then
  PLIST_PATH="$HOME/Library/LaunchAgents/com.xcoder.daemon.plist"
  if [ -f "$PLIST_PATH" ]; then
    log "Unloading and removing $PLIST_PATH..."
    launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
    rm -f "$PLIST_PATH"
    log "Removed."
  else
    log "No launchd agent found at $PLIST_PATH — nothing to do."
  fi
  exit 0
fi

log "No supported native service manager detected on this OS ($OS) — nothing was registered by install.sh, so there's nothing to remove here."
