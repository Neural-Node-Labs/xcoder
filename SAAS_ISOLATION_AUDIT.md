# Multi-tenant isolation audit

Scope: the whole `xcoder` repo as a single-tenant app being deployed as a SaaS. Method: code reading of the API, auth, stores, tools, cache, proxies and compose files, then a fix per finding with a regression test (`src/saas/__tests__/saas.isolation.test.ts`, 27 tests). Everything below is gated by `XCODER_SAAS_MODE=true`; with it off, behaviour is unchanged.

**Status key:** FIXED = closed in code and tested · MITIGATED = default-off / reduced, residual risk remains · OPEN = not fixed, needs the work described.

## Critical

| # | Finding (where) | Impact | Status |
|---|---|---|---|
| C1 | No tenant concept at all: users, tokens, projects had no tenant (`auth.ts`, `projectStore.ts`) | Everyone shares one namespace | FIXED – `tenantId` on user and token, tenant context (AsyncLocalStorage) per request, tenant store with suspend/delete |
| C2 | `requireAdmin` = global admin; `/users` lists/edits/deletes every account; project store `allowAnyOwner` override reads any user's project (`routes.ts`, `projectStore.ts`) | A tenant "admin" sees and controls all tenants | FIXED – in SaaS mode `requireAdmin` = SaaS owner only, legacy `admin` string has no privileges, no cross-owner project override for anyone, tenant admins use `/tenant/users` which only sees their tenant |
| C3 | `resolveProjectCwd` falls back to `process.cwd()` (the platform checkout: source, `.env`, logs) when no project is chosen | Tenant tasks run in and read the platform's own directory | FIXED – refused in SaaS mode |
| C4 | `/telemetry` serves the server's `thinking/llm/sys` logs, which contain every tenant's prompts | Direct cross-tenant read | FIXED – platform staff only |
| C5 | Audit log is one global file; entries have no tenant | Cross-tenant disclosure / flooding | FIXED – tenant members write to a per-tenant log; `/audit-log` is platform-only; `/tenant/audit-log` for tenant admins |
| C6 | LLM response cache key had no tenant | A byte-identical prompt from another tenant is served from the first tenant's cached answer | FIXED – tenant id is in the key; requests with no tenant scope bypass the cache |
| C7 | `run_command`, ssh, docker, MCP tools run as the API process with its full env (LLM keys, `DATABASE_URL`, AGI tokens) | Tenant code can read other tenants' workspaces and every platform secret | MITIGATED – off by default per tenant, only the SaaS owner can enable per tenant, env is allowlist-scrubbed in SaaS mode. **Still not a sandbox**: enable only if commands run in a per-tenant container/microVM |
| C8 | Network tools (web search, URL fetch, crawl, API test, GitHub) reach internal services from the server | SSRF to Postgres, Redis, AGI, cloud metadata | MITIGATED – off by default per tenant, owner-only to enable. No egress filter was added |
| C9 | AGI agent and CodeGraph are single shared instances (one memory, one goal, one admin key) | Cannot be made tenant-safe | FIXED by exclusion – platform staff only; tenants get 403 on routes, the CodeGraph proxy and the tools |
| C10 | `plans`, `plan_tasks`, `phase_reports`, `wbs_entries` tables had no tenant/owner column; routes returned by id or listed everything | FIXED – `tenant_id` column (default `'default'`, added by `initializeDatabase` for existing installs), every read/write filtered by the request's tenant, fails closed with no scope (`tenantStores.test.ts`). **Still OPEN**: Postgres task logs (`/task-history/:id/logs`, keyed by task id only) stay off in SaaS mode |

## High

| # | Finding | Status |
|---|---|---|
| H1 | `/auth/google` auto-created a `user` for any Google account, which would be a tenant-less principal | FIXED – SaaS mode only matches pre-linked accounts |
| H2 | First-`/register` bootstrap would create a plain admin | FIXED – becomes `saas_owner`; registration then closed |
| H3 | Deleted/changed users kept working tokens until expiry (no revoke by user id) | FIXED – revoke on delete, role change, disable, password reset; suspending/deleting a tenant revokes all its sessions, and `authMiddleware` re-checks tenant status on every request |
| H4 | Workspace confinement was opt-in and used `path.resolve` (symlink escape) | FIXED – always on in SaaS mode, realpath-checked incl. non-existent targets |
| H5 | No per-tenant quotas/metering (noisy neighbour, one tenant can burn the shared LLM key) | FIXED – per-plan monthly tokens/requests/users, enforced before `/chat` and inside the LLM client; per-user rate limits already existed. `maxIterations` from the client is now capped at 200 |
| H6 | docker-compose published Postgres, Ollama, CodeGraph ports on all interfaces with default credentials | FIXED – bound to 127.0.0.1 |
| H7 | Forked sub-agent worker processes lose the tenant context | MITIGATED – fail closed: governed tools denied and cache bypassed when no tenant context exists in SaaS mode (sub-agents can't use shell/network tools there) |

## Medium / accepted / open

| # | Finding | Status |
|---|---|---|
| M1 | Usernames are globally unique (login has no tenant field); a taken name returns a generic 409 | ACCEPTED – leaks only "name unavailable". Per-tenant login (`user@tenant`) is a follow-up |
| M2 | Token store is in memory (single process) | OPEN – put sessions in Redis/DB before running >1 API replica |
| M3 | One Postgres, no row-level security; isolation is application-level | OPEN – add RLS once the tables carry `tenant_id` |
| M4 | All tenants use the platform's LLM key/provider | FIXED – per-tenant connections (see "LLM connections" below) |
| M5 | Usage/tenant/CRM data is file-based JSON (atomic writes, 0600) | ACCEPTED for one instance; move to Postgres for scale/HA |
| M6 | Deleting a tenant is a soft delete (accounts disabled, files kept) | ACCEPTED – no purge/export job yet |
| M7 | Tenant workspaces are `workspace/<userId>/…` on a shared volume | ACCEPTED – user ids are unique and the confinement is symlink-safe, but a quota on disk is not enforced |

## LLM connections (centralised, per-tenant)

All LLM resolution now goes through `src/llm/connections.ts` (`resolveLlm(purpose, tenantId)`), for the purposes **chat**, **task** and **agi**, plus a tenant **default** slot. Order: tenant purpose slot, tenant default slot, then the platform connection if the owner policy allows fallback.

| # | Finding | Status |
|---|---|---|
| L1 | Chat/plan/execute loaded the config and wrote the stored API key into `process.env`, so one tenant's request could run with, or leak, another's key | FIXED – key passed explicitly per request (`LlmConfig.api_key`); never in env, cache keys or API responses; forked workers get a scrubbed env |
| L2 | `/settings/llm-*` exposed the platform provider, base URL and key status to every tenant admin | FIXED – platform-only in SaaS mode |
| L3 | A tenant-supplied base URL is a server-side request: SSRF to metadata, localhost, internal hosts | FIXED – https only, no credentials, every resolved address must be public, re-checked on each resolve; owner may allow private URLs. Residual: DNS rebinding between check and request (use egress filtering) |
| L4 | Tenant keys at rest | FIXED – AES-256-GCM (`XCODER_SECRET_KEY`, or auto-generated `secret.key`, 0600); write-only through the API |
| L5 | AGI was one shared instance with one LLM config, memory and budget | FIXED for isolation – tenants get AGI only through an owner-provisioned dedicated instance (URL + sealed token); LLM config pushed at runtime and held in the agent's memory only; staff keep the platform instance |
| L6 | A tenant with its own key could be blocked by, or consume, the platform token allowance | FIXED – bring-your-own-key bypasses the allowance but is still recorded |

Residual: the CLI still reads the platform yaml/env; dedicated AGI instances are provisioned manually; an AGI restart runs on env defaults until the next gateway status call re-pushes; losing the master key makes stored tenant keys unreadable; Docker images were not built here.

## Security validation pass (auth, limiter, UI, injection, cross-tenant)

Regression suite: `src/saas/__tests__/saas.security.test.ts` (24 tests, SaaS mode, real HTTP). Full suite: 966 tests green.

| # | Check | Result |
|---|---|---|
| V1 | Every registered route (incl. `/saas`, `/crm`, `/llm`, `/tenant`) rejects: no header, garbage/empty bearer, wrong scheme, token only in query string | PASS. Only `POST /login`, `/register`, `/auth/google`, `/logout`, `GET /users/count`, `/auth/google/config`, `/health` are public; the test fails if a new public route appears or the public ones leak tenant/secret data |
| V2 | Logout revokes; tampered/truncated tokens refused | PASS |
| V3 | Login limiter was only per IP+username (spraying and distributed guessing were unlimited); `/register` had none; no `trust proxy`, so behind nginx every user shared one IP | FIXED – three buckets (IP+user 10, IP 40, user 25 per 15 min, tunable `XCODER_LOGIN_IP_MAX`/`XCODER_LOGIN_USER_MAX`), `/register` limited, `XCODER_TRUST_PROXY` (compose sets 1) so real client IPs are used |
| V4 | CodeGraph proxy (`/codegraph-api`) anonymous / bogus cookie / tenant admin | PASS – 401 (staff cookie only; SameSite=Strict, HttpOnly) |
| V5 | UI: the SPA shows only the login page without a verified session; the static JS/CSS bundle is public by necessity and holds no secrets or data; every data call needs a token. `/codegraph-ui` static assets are public (code only) | PASS / accepted |
| V6 | SQL injection | PASS – every `db.query` is parameterised; the only interpolations are `$n` placeholders and fixed column/table names. A static scan test fails the build if a query interpolates anything else. Injection payloads in login, ids and query params never authenticate, never return 5xx or SQL errors, and are stored as inert data |
| V7 | **`GET/POST /task-history` with an unknown or another tenant's `projectId` fell back to the server's own directory** (platform task history readable/writable by a tenant) | FIXED – returns 404 |
| V8 | `projectRoutes.ts` had its own `isAdmin` check without the SaaS guard | FIXED – no cross-owner override in SaaS mode |
| V9 | Cross-tenant: project id of another tenant on every project/workspace route (read, write, delete, download, activate, rename), other user in same tenant, traversal (`../`, absolute, encoded, backslash, null byte, sibling project paths), no-project fallback to server dir, chat session, plans, CRM, staff access to tenant content | PASS |
| V10 | Prompt injection | MITIGATED, not eliminable. Added an "untrusted content" rule to the ReAct system prompt (tool/file/web output is data); the SDLC engine already fences untrusted text and neutralises fence-closing tags (tested). The real control is blast radius: in SaaS mode tools are confined to the tenant's project (symlink-safe), shell/network/MCP tools are off for tenants, sub-process env is scrubbed of secrets, and tenant LLM keys are never in the environment |

Residual: reflected input in error text (JSON only, not HTML); limiter and sessions are in process memory (use a shared store for >1 replica); Postgres `task_history`/telemetry rows have no tenant column (task logs by id are disabled in SaaS mode); no row-level security; prompt injection can still make an agent misuse the tools it legitimately has inside its own workspace.
