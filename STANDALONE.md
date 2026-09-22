# Running xcoder without Docker

Docker (`Dockerfile` / `docker-compose.yml`) is a convenience, not a requirement. xcoder is a
plain Node.js server that can serve its own API, its own dashboard, and the embedded CodeGraph
Explorer all from one process on one port — this document covers building and running that
directly on a host.

## Requirements

- **Node.js >= 20** (see `package.json`'s `"engines"`).
- **PostgreSQL — optional.** Only used for task-level log telemetry (`GET
  /api/v1/tasks/:id/logs`, see `routes.ts`); everything else (auth, projects, plans, users)
  works without it. If you skip it, just don't set `DATABASE_URL`/`DATABASE_HOST` — the app logs
  a note and degrades gracefully rather than failing to start. If you want it, install Postgres
  however you'd normally install it on this host (a native package, a standalone binary — it
  doesn't have to be in a container either) and point `.env` at it.
- **Python 3 — optional.** Only needed if you also want to run CodeGraph's own backend natively
  (`--with-codegraph-python` below). Without it, xcoder runs fine; the CodeGraph integration
  just stays disconnected until you connect it (Platform > Tools) to an instance running
  elsewhere.

## Build

```bash
scripts/build-standalone.sh
```

This installs dependencies, compiles the backend (`src/` → `dist/`), builds the dashboard
(`ui/` → `ui/dist/`), and builds the embedded CodeGraph Explorer
(`integrations/codegraph/codegraph-ui/` → `.../dist/`). It also copies `.env.example` to `.env`
if you don't already have one — edit that before running for real (see `.env.example`'s
comments: an LLM provider key or Ollama, `DATABASE_*` if you're using Postgres,
`XCODER_TOKEN_TTL_MS` if you want a different session length than the 60-minute default, etc.).

Options:
- `--with-codegraph-python` — also provisions CodeGraph's own Python venv, so CodeGraph can run
  natively alongside xcoder instead of needing a separate CodeGraph deployment to connect to.
- `--prod-only` — after building, prunes `devDependencies` from `node_modules`. Skip this if
  you'll keep running `npm test` / `npm run typecheck` in this same checkout.

## Run it directly

```bash
node dist/cli/index.js --ui       # API + dashboard + embedded CodeGraph Explorer, one process
node dist/cli/index.js --serve    # API only (no dashboard)
```

Both read `--port`/`--host` (defaults: `3001` / `0.0.0.0`) or the `XCODER_API_PORT`/
`XCODER_API_HOST` env vars. Once it's up, the dashboard is at `http://<host>:<port>/` — same
port as the API, no reverse proxy or second process needed.

## Install as a background daemon

```bash
sudo scripts/install.sh          # Linux: registers a systemd service
scripts/install.sh               # macOS: registers a launchd LaunchAgent (no sudo)
```

This runs the build above (skip with `--skip-build` if you already built), then:

- **Linux (systemd):** creates an unprivileged `xcoder` system user, writes
  `/etc/systemd/system/xcoder.service` (from `scripts/xcoder.service.template`), and enables +
  starts it — restarts on failure, starts on boot.
  ```bash
  systemctl status xcoder
  journalctl -u xcoder -f
  systemctl restart xcoder
  ```
- **macOS (launchd):** writes `~/Library/LaunchAgents/com.xcoder.daemon.plist` (from
  `scripts/xcoder.plist.template`) and loads it — restarts on crash, starts on login for that
  user.
  ```bash
  tail -f logs/xcoder.out.log logs/xcoder.err.log
  launchctl kickstart -k gui/$(id -u)/com.xcoder.daemon
  ```
- **Anything else** (Windows, a non-systemd Linux): the script stops short of registering a
  service and just prints the direct run command. xcoder itself has no Windows-specific
  dependency, so any general-purpose Windows service wrapper works — e.g.
  [NSSM](https://nssm.cc/) (`nssm install xcoder "C:\Program Files\nodejs\node.exe"
  "C:\path\to\xcoder\dist\cli\index.js" --ui`) or [pm2](https://pm2.keymetrics.io/)
  (`pm2 start dist/cli/index.js --name xcoder -- --ui`) — this repo just doesn't script one for
  you.

Pass `--serve-only` to run in API-only mode instead of `--ui`, or `--with-codegraph-python` to
forward that flag to the build step.

To remove the service/agent again (leaves the checkout, build output, and `.env` alone):

```bash
sudo scripts/uninstall.sh   # Linux
scripts/uninstall.sh        # macOS
```

## What's different from the Docker deployment

- **One process, one port**, instead of separate `api` / `ui` (nginx) / `postgres` / `ollama` /
  `codegraph-*` containers — the dashboard and CodeGraph Explorer are both served by the same
  Node process that serves the API (`server.ts`'s `XCODER_UI_DIST` / `CODEGRAPH_UI_DIST`
  mounts), and Postgres/CodeGraph/an LLM provider are optional rather than sibling services.
- **The Docker image's Kali Linux base** exists so the red-team SecOps tools
  (`src/tools/securityOpsTool.ts`) have `nmap` etc. available out of the box. Running natively,
  install whatever of those binaries you actually want available on the host yourself — xcoder
  doesn't require them to start, and SecOps tools that need a missing binary just report that
  clearly rather than crashing the server.
- **Secrets** come from a plain `.env` here (see `.env.example`) instead of the
  Docker-secrets-style `${VAR}_FILE` convention `docker-entrypoint.sh` resolves — set them
  directly.
