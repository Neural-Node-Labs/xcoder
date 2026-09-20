# xcoder

**A DAG-based SDLC orchestration platform.** xcoder breaks a task into an inspectable
pipeline of software-development stages, runs each stage in its own isolated sub-agent, and
never trusts a stage's own claim of success — every deliverable is independently re-checked by
a Validation Gate before the pipeline is allowed to advance.

Ships three ways to use it: a CLI (`xcoder`), an HTTP API, and a web dashboard.

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

This starts four containers:

| Service    | Description                                         | Port |
|------------|------------------------------------------------------|------|
| `postgres` | PostgreSQL 16, with a named volume for persistence    | 5432 |
| `ollama`   | Local LLM backend — `ollama-pull-model` pulls `granite4:1b` (default) plus alternates on first start | 11434 |
| `api`      | xcoder HTTP API — waits for Postgres and Ollama, runs migrations, then serves | 3001 |
| `ui`       | The dashboard, built and served via nginx (proxies `/api` to `api`) | 5173 |

**Ollama is the default LLM backend** — `agent/config/llm.yaml` is mounted read-only into
the `api` container and points at `http://ollama:11434/v1`, so `docker compose up` works
with no API key at all. Swap it for a cloud provider by editing `agent/config/llm.yaml`
(see the provider examples inside that file) and putting the matching key in a `.env` file
next to `docker-compose.yml` (`docker compose` loads it automatically) — see `.env.example`
for the full list of variables.
The `api` container's entrypoint (`docker-entrypoint.sh`) waits for PostgreSQL to accept
connections and runs the idempotent `--initialize-db` step on every start, so there's no
separate init command to run.

Once it's up: the dashboard is at `http://localhost:5173` and the API at
`http://localhost:3001/api/v1`.

To build/run just the API image standalone (e.g. against an external Postgres):

```bash
docker build -t xcoder-api .
docker run -p 3001:3001 --env-file .env \
  -e DATABASE_URL=postgres://user:pass@host:5432/xcoder \
  xcoder-api
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

xcoder requires PostgreSQL — there is no other supported backend. Connection settings come
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
`lean`, `simple`, `swarm`, `agentic`, `brain`, `procedure`, and `assistant` — reachable via
`--engine <name>`, a dedicated CLI flag (`--react`, `--lean`, …), or the `engine` field on
`/api/v1/chat`.

`assistant` is the odd one out in that list — it's not an SDLC engine. It's the same bare
ReAct loop as `simple`, pointed at a conversational system prompt instead of "complete this
deliverable and stop." It's what the dashboard's **Chat** tab (next to **Task**, under Run a
Task) talks to: direct back-and-forth conversation and small one-off requests, with full access
to the same tools, skills, and MCP servers every other engine has — just without DAG planning
or multi-stage delegation. There's no server-side chat session; the UI replays the running
transcript as context on each turn (see `ChatPanel.tsx`).

## MCP (Model Context Protocol)

`mcp_tool` lets any engine call tools exposed by an MCP server — the same way an editor like
Claude Desktop would. It's a small, dependency-free client (see `src/tools/mcpTool.ts`) that
speaks MCP's JSON-RPC protocol directly over two transports, so no `@modelcontextprotocol/sdk`
dependency is needed:

- **stdio** — spawns the server as a local subprocess, via `command` (+ optional `args`), e.g.
  `npx @modelcontextprotocol/server-filesystem /some/dir`. Every call spawns a fresh process.
- **streamable-http** — calls an already-running network MCP server instead, via `url`, e.g.
  `http://codegraph-mcp:8900/mcp`. No process to spawn; each call is one self-contained POST.

Two actions either way:

- `action: "list"` — discover what tools a server offers and their input schema
- `action: "call"` — invoke one, with `toolName` + `toolArgs`

The bundled CodeGraph MCP server (see below) has its own shortcut: `command: "codegraph-mcp"`
resolves to whichever transport can actually reach it — the docker-compose `codegraph-mcp`
service over the network, or a local stdio spawn — with the right credentials either way, no
path/URL/args needed.

## Sign in with Google

Set `XCODER_GOOGLE_CLIENT_ID` (an OAuth "Web application" client id from Google Cloud Console —
see `.env.example`) to turn on Google sign-in. Once configured:

- End users see a "Sign in with Google" button on the login screen and can self-register/log in
  with their Google account — no admin action needed.
- Admins can also add a Google-linked account ahead of time from the **Users** page (email only,
  no password) — it activates the first time that person signs in with Google.

The ID token is verified server-side (`google-auth-library`, see `src/api/googleAuth.ts`)
before any session is issued. Leave the variable unset and the button never appears —
`GET /api/v1/auth/google/config` reports `{ enabled: false }`.

## Local models (Ollama)

No API key required. Point `agent/config/llm.yaml` at a `provider: ollama` model and xcoder
talks to `http://localhost:11434` with no `Authorization` header at all — see
`NO_AUTH_PROVIDERS` in `src/config/loadConfig.ts`.

## Project layout

```
src/                    backend: CLI, HTTP API, engines, tools, telemetry, database
ui/                     web dashboard (Vite + React + TypeScript)
integrations/codegraph/ bundled CodeGraph system (API server, MCP server, Explorer UI) — see below
migrations/postgres/    versioned SQL migrations, tracked in the _migrations table (see src/db/migrations.ts)
agent/                  (not included — see below) install-level config: llm.yaml, xcoder.md, skills/
.agent/                 per-workspace runtime state: tasks/, logs/, index/, plans/, reports/
Dockerfile              API/CLI image (multi-stage build, non-root, HEALTHCHECK)
docker-entrypoint.sh    waits for Postgres, resolves Docker-secrets *_FILE vars, runs --initialize-db
docker-compose.yml      postgres + api + ui, wired together for local/dev use
docker-compose.prod.yml overlay: Docker secrets + resource reservations (see Docker section below)
ui/Dockerfile           dashboard image (Vite build served via non-root nginx)
.github/workflows/      CI: typecheck/build/test for api + ui, plus a full docker compose smoke test
```

`agent/` (no leading dot) is the install/config directory — `agent/config/llm.yaml` for LLM
provider configuration and `agent/xcoder.md` for the engineering protocol markdown that gets
folded into every engine's system prompt. It is intentionally not part of this repository
checkout; create it at the project root (or point `XCODER_HOME` at wherever it lives) before
running anything that needs an LLM.

`.agent/` (with a leading dot) is fully managed by xcoder itself — nothing under it needs to
be created by hand, and `xcoder purge` removes it entirely.

## CodeGraph (bundled)

xcoder ships the full CodeGraph system — a structural code-graph API, an MCP server, and a
React Explorer UI — under `integrations/codegraph/`, not just a client pointed at a
separately-hosted instance. It runs in one of two shapes depending on how you run xcoder:

**docker-compose** (`docker compose up`): CodeGraph runs as its own `codegraph-api` and
`codegraph-mcp` services (see `docker-compose.yml`) — xcoder's `api` container has no Python
runtime, so this is the shape that works there. They start with the rest of the stack (no
profile flag). `api` has no `depends_on` edge to them, so xcoder's core services never wait on
CodeGraph: if it's slow or down, xcoder runs without it and the CodeGraph page says so and keeps
retrying. The `api` image builds the Explorer UI in (with the `/codegraph-ui/` base path) and
serves it at `/codegraph-ui`. To run without CodeGraph:
`docker compose up --scale codegraph-api=0 --scale codegraph-mcp=0`. On startup, xcoder logs in to `codegraph-api` as its auto-seeded admin over the
compose network and wires the resulting API key into `codegraph_tool` automatically; no URL or
key to type in. `codegraph-mcp` runs its MCP server over a real network transport
(`streamable-http`, not stdio — see below) so `mcp_tool` reaches it the same way.

**Local dev** (`npm run serve`, no Docker), from **Platform > Tools** in the dashboard:

1. One-time setup: `npm run codegraph:install` (creates a Python venv under
   `integrations/codegraph/codegraph/.venv` and installs CodeGraph's pinned dependencies).
2. Click **Start bundled CodeGraph**. xcoder spawns the API server as a child process,
   authenticates as its auto-seeded admin, and wires the resulting API key into `codegraph_tool`
   automatically.
3. Click **Open Explorer** for the full CodeGraph UI, embedded at `/codegraph-ui` and
   pre-authenticated via a same-origin SSO bridge.

Either way, every engine — including the chat-first `assistant` engine — gets `codegraph_tool`
once CodeGraph is connected:

- **`action: "index_workspace"`** zips the current project (respecting the same exclusion rules
  as the project-download route), uploads it to CodeGraph as a project, triggers indexing, and
  sets it as the default project — do this first for a project that hasn't been indexed yet.
  Also available as an **"Index this workspace"** button on the CodeGraph Explorer page for
  people who'd rather not go through chat.
- full-text search, dependency/impact analysis, and symbol path-finding once indexed.

`mcp_tool` can reach the bundled MCP server via `command: "codegraph-mcp"` — it resolves to
whichever transport can actually reach it: the `codegraph-mcp` service's `streamable-http`
endpoint if `XCODER_CODEGRAPH_MCP_URL` is set (docker-compose does this for you), otherwise a
local stdio spawn of the bundled server.

Prefer to run CodeGraph yourself (e.g. an existing shared deployment)? Use "Advanced: connect an
external instance instead" under Platform > Tools, or set `XCODER_CODEGRAPH_URL` /
`XCODER_CODEGRAPH_API_KEY` — see `.env.example` for this and every other CodeGraph-related
variable (admin password, ports, data dir, etc.) across all three deployment shapes.

## Try it with no API key at all

```bash
xcoder --task "add a health check endpoint" --mock
```

`--mock` swaps in `AutoMockLlmClient` (`src/llm/mockClient.ts`) for the real provider — no API
key, no network call, works with any task and any engine. Every stage/phase completes in one
step with a `[MOCK]`-prefixed result, so you can try engine selection, the SDLC DAG, the
Validation Gate, plan approval, and the web dashboard end-to-end before configuring a real LLM.
Combine with `--serve`/`--ui` to run the API server itself in mock mode, or set
`XCODER_MOCK_LLM=true` directly for a long-running server.

Add `--verbose` for a startup banner (engine/provider/model/mock status) and much higher detail
in the thought/action/observation console output.

## CLI

```
xcoder [task]                    run a task through the default (sdlc) engine
xcoder --task "..." --sdlc       explicit engine selection
xcoder --task "..." --mock       run without a real LLM connection (see above)
xcoder --task "..." --verbose    print a startup banner and full-detail console output
xcoder --chat                    interactive chat mode
xcoder --serve                   start the HTTP API only
xcoder --ui                      start the API and the web dashboard together
xcoder purge                     remove all xcoder-generated state (.agent/)
xcoder --help                    full flag reference
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
