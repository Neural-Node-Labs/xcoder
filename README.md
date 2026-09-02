# devnull

**A DAG-based SDLC orchestration platform.** devnull breaks a task into an inspectable
pipeline of software-development stages, runs each stage in its own isolated sub-agent, and
never trusts a stage's own claim of success — every deliverable is independently re-checked by
a Validation Gate before the pipeline is allowed to advance.

Ships three ways to use it: a CLI (`devnull`), an HTTP API, and a web dashboard.

## Quick start

```bash
npm install
cp .env.example .env        # fill in at least one LLM provider key (or configure Ollama — no key needed)
                             # also set DATABASE_URL (or DATABASE_HOST/PORT/etc.) to point at a running PostgreSQL instance
npm run build
npm run db:init              # one-time: creates tables in your PostgreSQL database and runs migrations

# CLI
npm run dev -- --task "add input validation to the signup form"

# API + web dashboard
npm run build
npm start -- --ui            # starts the API on :3001 and the dashboard on :5173
```

The dashboard's dev server proxies `/api` to `http://localhost:3001` (see `ui/vite.config.ts`),
so run the API server first (or via `--ui`, which starts both).

### Docker

```bash
docker compose up --build
```

This starts three containers:

| Service    | Description                                         | Port |
|------------|------------------------------------------------------|------|
| `postgres` | PostgreSQL 16, with a named volume for persistence    | 5432 |
| `api`      | devnull HTTP API — waits for Postgres, runs migrations, then serves | 3001 |
| `ui`       | The dashboard, built and served via nginx (proxies `/api` to `api`) | 5173 |

Put your LLM provider key(s) in a `.env` file next to `docker-compose.yml` before starting
(`docker compose` loads it automatically) — see `.env.example` for the full list of variables.
The `api` container's entrypoint (`docker-entrypoint.sh`) waits for PostgreSQL to accept
connections and runs the idempotent `--initialize-db` step on every start, so there's no
separate init command to run.

Once it's up: the dashboard is at `http://localhost:5173` and the API at
`http://localhost:3001/api/v1`.

To build/run just the API image standalone (e.g. against an external Postgres):

```bash
docker build -t devnull-api .
docker run -p 3001:3001 --env-file .env \
  -e DATABASE_URL=postgres://user:pass@host:5432/devnull \
  devnull-api
```

#### Production hardening

The base `docker-compose.yml` already runs every container as a non-root user, sets
per-service CPU/memory limits, and exposes an `HEALTHCHECK` on both `api` and `ui`. For a
real deployment, layer `docker-compose.prod.yml` on top:

```bash
mkdir -p secrets
echo -n "your-db-password" > secrets/db_password.txt
echo -n "sk-ant-..."       > secrets/anthropic_api_key.txt
chmod 600 secrets/*.txt

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

This overlay:

- Passes `DATABASE_PASSWORD` and LLM API keys as **Docker secrets** (files mounted at
  `/run/secrets/...`) instead of plain environment variables, so plaintext credentials
  never show up in `docker inspect`, shell history, or `docker compose config` output.
  `docker-entrypoint.sh` resolves any `DATABASE_PASSWORD_FILE` / `ANTHROPIC_API_KEY_FILE` /
  etc. into the corresponding plain variable at container start (the official `postgres`
  image supports `POSTGRES_PASSWORD_FILE` natively, so that side needs no extra glue).
- Adds CPU/memory **reservations** alongside the base file's limits.

`secrets/` is already covered by both `.gitignore` and `.dockerignore` — real secret files
should never be committed or baked into an image layer.

## Database

devnull requires PostgreSQL — there is no other supported backend. Connection settings come
from `DATABASE_URL` (takes precedence) or the individual `DATABASE_HOST`/`PORT`/`NAME`/`USER`/
`PASSWORD`/`SSL` vars; see `.env.example` for the full list and defaults. `src/db/config.ts`
loads them, `src/db/postgresClient.ts` wraps `pg.Pool`, and every store (`src/api/*Store.ts`,
`src/core/postgresTaskHistory.ts`, `src/telemetry/postgresTelemetry.ts`) speaks to it through
the shared `DatabaseClient` interface (`src/db/types.ts`) using `$1, $2, ...` placeholders.

`npm run db:init` (or `--initialize-db` on the CLI) creates the base tables — safe to run
repeatedly, every statement uses `IF NOT EXISTS` — and then applies any pending files under
`migrations/postgres/`. Migrations are tracked in a `_migrations` table and only ever run once;
to add one, drop a new `NNN_description.sql` file in that directory (see `src/db/migrations.ts`
for the exact runner logic).

## What's the default engine?

**`sdlc`** — a DAG-based SDLC orchestration engine. It classifies an incoming task through an
explicit, ordered rule table (not an LLM's judgment call) into a starting stage
(`requirements → design → code → test → …`), runs each stage in its own isolated sub-agent, and
independently re-checks every stage's deliverable — a stage's own self-report is never trusted.
A failed stage heals (retries with a healing prompt) up to a bounded number of attempts, then
escalates: it writes a rejection report and halts, rather than silently pushing forward on a
broken foundation. See `src/core/engine/SdlcEngine.ts` for the full design rationale.

Other registered engines remain fully available — `react` (the original ReAct loop),
`lean`, `simple`, `swarm`, `agentic`, `brain`, `procedure` — reachable via `--engine <name>`,
a dedicated CLI flag (`--react`, `--lean`, …), or the `engine` field on `/api/v1/chat`.

## Local models (Ollama)

No API key required. Point `agent/config/llm.yaml` at a `provider: ollama` model and devnull
talks to `http://localhost:11434` with no `Authorization` header at all — see
`NO_AUTH_PROVIDERS` in `src/config/loadConfig.ts`.

## Project layout

```
src/                    backend: CLI, HTTP API, engines, tools, telemetry, database
ui/                     web dashboard (Vite + React + TypeScript)
migrations/postgres/    versioned SQL migrations, tracked in the _migrations table (see src/db/migrations.ts)
agent/                  (not included — see below) install-level config: llm.yaml, devnull.md, skills/
.agent/                 per-workspace runtime state: tasks/, logs/, index/, plans/, reports/
Dockerfile              API/CLI image (multi-stage build, non-root, HEALTHCHECK)
docker-entrypoint.sh    waits for Postgres, resolves Docker-secrets *_FILE vars, runs --initialize-db
docker-compose.yml      postgres + api + ui, wired together for local/dev use
docker-compose.prod.yml overlay: Docker secrets + resource reservations (see Docker section below)
ui/Dockerfile           dashboard image (Vite build served via non-root nginx)
.github/workflows/      CI: typecheck/build/test for api + ui, plus a full docker compose smoke test
```

`agent/` (no leading dot) is the install/config directory — `agent/config/llm.yaml` for LLM
provider configuration and `agent/devnull.md` for the engineering protocol markdown that gets
folded into every engine's system prompt. It is intentionally not part of this repository
checkout; create it at the project root (or point `DEVNULL_HOME` at wherever it lives) before
running anything that needs an LLM.

`.agent/` (with a leading dot) is fully managed by devnull itself — nothing under it needs to
be created by hand, and `devnull purge` removes it entirely.

## Try it with no API key at all

```bash
devnull --task "add a health check endpoint" --mock
```

`--mock` swaps in `AutoMockLlmClient` (`src/llm/mockClient.ts`) for the real provider — no API
key, no network call, works with any task and any engine. Every stage/phase completes in one
step with a `[MOCK]`-prefixed result, so you can try engine selection, the SDLC DAG, the
Validation Gate, plan approval, and the web dashboard end-to-end before configuring a real LLM.
Combine with `--serve`/`--ui` to run the API server itself in mock mode, or set
`DEVNULL_MOCK_LLM=true` directly for a long-running server.

Add `--verbose` for a startup banner (engine/provider/model/mock status) and much higher detail
in the thought/action/observation console output.

## CLI

```
devnull [task]                    run a task through the default (sdlc) engine
devnull --task "..." --sdlc       explicit engine selection
devnull --task "..." --mock       run without a real LLM connection (see above)
devnull --task "..." --verbose    print a startup banner and full-detail console output
devnull --chat                    interactive chat mode
devnull --serve                   start the HTTP API only
devnull --ui                      start the API and the web dashboard together
devnull purge                     remove all devnull-generated state (.agent/)
devnull --help                    full flag reference
```

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | Compile `src/` to `dist/` |
| `npm run dev` | Run the CLI directly from TypeScript source (no build step) |
| `npm start` | Run the compiled CLI |
| `npm run serve` | Compiled CLI, `--serve` only |
| `npm run ui` | Compiled CLI, `--ui` (API + dashboard) |
| `npm test` | Run the backend test suite (vitest) |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:init` | Create tables in your PostgreSQL database and run pending migrations (idempotent) |

For the dashboard specifically: `cd ui && npm install && npm run dev` (or `npm run build` for a
production bundle).

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`, in three jobs:

1. **api** — `npm ci`, typecheck, build, unit tests (`vitest`)
2. **ui** — `npm ci`, typecheck (`tsc -b`), Vite build
3. **docker** (after both pass) — builds the `api` and `ui` images via `docker compose build`,
   brings up the full stack (Postgres included), polls the `api` container's `HEALTHCHECK`
   until it reports healthy, then hits `/api/v1/health` and the dashboard root from the host —
   a real smoke test of the shipped images, not just a build check.

> **Known gap:** a handful of test files under `src/` reference an `agent/` install-config
> directory (see [Project layout](#project-layout)) that isn't part of this repository
> checkout, so `npm test` currently fails on those specific files in a clean checkout —
> unrelated to the database/Docker work above. `SECURITY_REVIEW.md` confirms the same root
> cause independently. Restoring `agent/` (or updating those tests' fixtures) will get the
> `api` CI job fully green.
