# xcoder — Pre-SaaS-launch security review

Scope: multi-tenant safety (many subscribed users, isolation between their workspaces and
running agents) and general production-deployment hardening. This document records what was
found, what was fixed in this pass, what was verified (and how), and — just as importantly —
what remains open and requires an infrastructure decision before launch, not just more code.

Severity scale: **CRITICAL** (exploitable now, direct account/data compromise or full outage),
**HIGH** (serious but narrower blast radius or requires a specific precondition), **MEDIUM**
(hardening, defense-in-depth), **INFO** (architectural note, not a vulnerability by itself).

---

## Fixed this pass

### 1. CRITICAL — Broken access control: any user could self-escalate to admin

`GET/POST/PUT/DELETE /users` and `PUT/DELETE /settings/llm-key` had no role check at all —
`authMiddleware` only confirms "is this a valid token," never "does this token's user have
permission for this action." Concretely, before this fix, any regular authenticated user
could:
- `PUT /users/<their own id>` with `{"role": "admin"}` — instant self-privilege-escalation,
  no new account needed.
- Enumerate every username and role on the platform (`GET /users`).
- Delete any other tenant's account (`DELETE /users/:id`).
- Overwrite or delete the single platform-wide LLM API key used by every tenant
  (`PUT`/`DELETE /settings/llm-key`), which is a platform-wide denial-of-service or a way to
  silently redirect the platform's LLM billing to an attacker-supplied key.

One route's comment literally claimed `// admin only — protected by authMiddleware`, which was
false — a good example of a comment asserting a security property that the code next to it
didn't actually enforce.

**Fix**: added a real `requireAdmin` middleware (`src/api/auth.ts`) that checks
`user.role === "admin"`, applied to all 6 affected routes in `src/api/routes.ts`.
**Verified**: `src/api/__tests__/auth.test.ts` — a "user"-role token is rejected with 403; an
"admin"-role token passes; a request with no attached user is rejected. Run for real (not just
type-checked) in a vitest harness: 10/10 pass.

### 2. CRITICAL — User accounts existed only in server process memory

`storedUsers` was a plain in-memory array. Every restart — a deploy, a crash, a routine
autoscale event — silently and permanently wiped every account on the platform, admin included,
with no recovery path. For a subscription SaaS this is a data-loss/availability defect on its
own, independent of any attacker.

**Fix**: `src/api/userStorePersistence.ts` persists the same array to a local JSON file
(`~/.xcoder/users.json`, mode `0600` since it contains password hashes) on every mutation, and
loads it on startup with the id counter correctly resumed from the highest existing id.
**Caveat, stated plainly**: this is single-instance-only. A real production deployment behind
a load balancer runs more than one app process; a local file is invisible across instances. The
correct end state is migrating this table onto the existing `db/` layer already used for
projects/task history (see `src/db/initialize.ts`) so every instance shares one database. Treat
this fix as "no longer wiped on restart," not as "ready for horizontal scaling" — that's the
top item in the Open Items section below.

### 3. CRITICAL (architectural) — No sandboxing between tenants' shell/network tool calls

This is the finding closest to your direct question ("ensure no 2 instances of agent touch
other users' workspace"), and it's the one that **cannot be fully closed by application code
alone** — stated here honestly rather than papered over.

`run_command_tool` runs an arbitrary shell command with the full privileges of the server
process (`src/tools/runCommandTool.ts` — this is documented as intentional, "unrestricted shell
access by design," not a bug). The `ssh_*`/`docker_*` tools extend that same unrestricted
execution to remote hosts. In a shared-infrastructure deployment where every tenant's task runs
as the same OS user on the same filesystem, a task using these tools can, in principle, read or
write any other tenant's project directory, make arbitrary outbound network connections
(including to cloud metadata endpoints — a classic SSRF-to-credential-theft path in cloud
deployments), or otherwise act with the server process's full privileges. No path-confinement
check, no per-request validation, nothing at the application layer closes this completely for a
tool whose entire purpose is running an arbitrary command.

**What was fixed**: two things, both real but both mitigations, not a complete fix:
- `src/api/server.ts` now defaults `XCODER_RESTRICT_TO_WORKSPACE=true` specifically for the
  API server process (the multi-tenant-facing surface), confining `read_tool`/`write_edit_tool`
  to the resolved project directory unless the operator explicitly overrides it. The CLI's
  default is unchanged (single-user, local invocation — a different risk profile).
- `src/tools/toolDispatcher.ts` — the single choke point every engine's tool calls pass through
  regardless of which tool schema list they were given — now enforces two kill switches:
  `XCODER_DISABLE_SHELL_TOOLS` (blocks `run_command_tool` and every `ssh_*`/`docker_*` tool)
  and `XCODER_DISABLE_NETWORK_TOOLS` (blocks `playwright_run_tool`,
  `crawl_and_generate_playwright_test_tool`, `crawl_site_mapper_tool`, `summarize_url_tool`,
  `api_test_tool`, `github_tool`). Enforced at dispatch, not just by hiding the tool from the
  LLM's schema list, so it holds even if some future code path hands a custom tool list to a
  sub-agent.
  **Verified**: `src/tools/__tests__/toolKillSwitch.test.ts` — 6/6 pass, confirming each listed
  tool is actually blocked when its switch is set, unrelated tools are unaffected, and both
  switches are independently toggleable and off by default.

**The actual fix, which is infrastructure, not code**: if `run_command_tool`/`ssh_*`/`docker_*`
are going to be offered to untrusted multi-tenant users (which is most of the point of an
agentic coding platform), the only complete answer is running each task's tool execution in a
real isolation boundary — a container or microVM per task/tenant (gVisor, Firecracker, or
equivalent), a filesystem that only that tenant's container can see, and restricted/no shared
network egress. Until that's in place, treat `XCODER_DISABLE_SHELL_TOOLS=true` and
`XCODER_DISABLE_NETWORK_TOOLS=true` as the honest production default, accepting a
less-capable (but safe) agent, rather than deploying a shell-capable agent on shared
infrastructure with no isolation. This is the single most important decision to make before
launch.

### 4. HIGH — Auth tokens never expired

Once issued, a Bearer token was valid forever, with no server-side way to force it to expire —
only an explicit logout (`revokeToken`) removed it. A token leaked once (a logged request, a
compromised device, a future XSS bug in the dashboard) stayed valid indefinitely.

**Fix**: tokens now carry `expiresAt` (default 7-day TTL, `XCODER_TOKEN_TTL_MS` to override),
enforced in `validateToken()` and `authMiddleware`, with both lazy eviction on access and a
periodic sweep. **Verified**: 3 tests in `auth.test.ts` confirm a fresh token validates, an
expired token is rejected by both `validateToken` and `authMiddleware` directly (403, not
silently treated as valid).

### 5. HIGH — No rate limiting on task submission

`/login` had rate limiting; `/chat` and `/chat/plan` — the endpoints that trigger real LLM cost
and real CPU/memory-consuming ReAct/SDLC-DAG execution — had none. In a subscription SaaS with
multiple tenants sharing server capacity, this is a direct noisy-neighbor and cost-exhaustion
vector: one tenant hammering task submission degrades or costs money for every other tenant.

**Fix**: `checkTaskRateLimit(userId)` in `auth.ts` (default: 30 task submissions/hour/user,
independently tunable from the login limiter via `XCODER_TASK_RATE_MAX`/
`XCODER_TASK_RATE_WINDOW_MS`), wired into both `/chat` and `/chat/plan`, returning 429 with a
`retryAfterMs`. **Verified**: 4 tests confirm the limit is enforced, one user's limit doesn't
affect another user's counter, and the login and task limiters don't interfere with each other
— this last check caught a real bug I introduced while building this (see below).

**Bug caught during this fix, corrected before shipping**: the existing periodic
cleanup sweep for the rate-limit store used the login limiter's 15-minute window to decide what
counted as "stale" for every entry, including the new hour-long task-limiter entries — which
would have silently trimmed still-valid task-submission timestamps every 15 minutes and let the
per-user task limit quietly reset early, undermining the protection before it even shipped.
Fixed by sweeping on "no activity for the longest configured window" rather than the shorter
one; the read-path check in `checkRateLimitWithConfig` was always correctly scoped regardless.

### 6. MEDIUM — CORS defaulted to a wildcard

`app.use(cors())` with no options is the `cors` package's default of
`Access-Control-Allow-Origin: *` — any website can make cross-origin requests to the API.
Bearer-token auth (not cookies) limits the worst-case impact versus cookie-based sessions, but
a wildcard is still inappropriate for a production API.

**Fix**: `XCODER_CORS_ORIGIN` (comma-separated allowlist); with nothing configured, the
default is now same-origin-only rather than wildcard.

---

## Reviewed and found sound — no changes needed

- **SQL injection**: every query across `src/db/` uses parameterized placeholders; no
  string-interpolated SQL was found anywhere in the codebase.
- **File upload/download path handling** (`src/api/projectRoutes.ts`): both routes resolve
  through a `safeResolve()` helper that rejects any path escaping the project root — no
  zip-slip or path-traversal issue found.
- **Password hashing**: scrypt via Node's built-in `crypto`, not a weak/fast hash.
- **Per-project workspace isolation** (metadata + filesystem layer, built in an earlier pass):
  confirmed still correct — every project is scoped to `PROJECTS_ROOT/<userId>/...`, every
  route enforces ownership from the verified token, admin oversight is explicit opt-in. This is
  the right foundation; item 3 above is about the tools that can bypass it, not a flaw in this
  layer itself.

---

## Open items — recommended before or shortly after launch, not fixed in this pass

Listed by priority, with why each matters and roughly what it would take.

1. **Migrate the user store from a local JSON file onto the shared `db/` layer.** Required for
   any horizontally-scaled (multi-instance) deployment — the current fix (item 2 above) only
   solves single-instance restart safety. The schema/migration pattern already exists for
   projects and task history; this is "more of the same," not new architecture.
2. **Decide the tool-sandboxing story before enabling shell/network tools for untrusted users**
   (item 3 above). Either invest in per-tenant container/microVM isolation, or ship with
   `XCODER_DISABLE_SHELL_TOOLS`/`XCODER_DISABLE_NETWORK_TOOLS` on by default and clearly
   communicate the capability trade-off to users.
3. **Move the token store off in-memory too**, for the same horizontal-scaling reason as the
   user store — a Redis-backed or DB-backed session store so any instance can validate any
   token, not just the instance that issued it.
4. **Per-tenant resource/concurrency limits beyond request-rate**: the new rate limiter caps how
   often a user can *submit* a task, but not how many tasks they can run *concurrently*, nor any
   CPU/memory/wall-clock ceiling on a single run. Worth adding once usage patterns from real
   tenants are known.
5. **Structured audit logging** of admin actions (user creation/role changes/deletions, LLM key
   changes) — currently these succeed or fail with no separate durable audit trail beyond
   whatever the general request logs capture.
6. **Secrets at rest**: the LLM API key file (`llmKeyStore.ts`) is plaintext on disk, protected
   only by file permissions (`0600`). Acceptable for a single trusted host; consider a real
   secrets manager (cloud KMS, Vault, etc.) for a managed production environment.

---

## How this was verified

Every fix in this document was checked two ways: a `tsc`-based syntax pass, and — after that
methodology missed a real bug this session (a doc comment whose text happened to contain `*/`,
which prematurely closed the block comment and broke the actual build; `tsc` alone didn't flag
it, but running the real test suite through `vitest`/`esbuild` did) — a full run of the actual
test suite in a disposable harness with real dependencies installed. The new/changed tests for
this review total **16** (`auth.test.ts`: 10, `toolKillSwitch.test.ts`: 6), all passing. The
full backend suite: **570/598** passing, with the remaining 28 failures confirmed — by matching
error text against every prior session's run — to be the same pre-existing, purely
environmental gap (a `agent/` root directory with skills/config that was never part of this
`src`-only working copy), not a regression from anything in this review.

---

## Addendum — infrastructure changes since this review

Not a re-review; noting two places where subsequent work touches findings above.

- **Item 2 fix / Open item 1** (user store persistence): the database layer this review
  pointed to (`src/db/`) is now backed by PostgreSQL specifically (migrated from
  `better-sqlite3`), with `docker-compose.yml` provisioning it alongside the API. Open item 1
  — migrating `userStorePersistence.ts`'s local JSON file onto this layer — is unchanged and
  still open; the target now has a concrete, running Postgres instance to migrate onto rather
  than a backend-agnostic abstraction.
- **Open item 6** (secrets at rest): Docker deployment (`docker-compose.prod.yml`) now supports
  passing `DATABASE_PASSWORD` and LLM provider keys as Docker secrets (files under
  `/run/secrets/`, resolved by `docker-entrypoint.sh`) instead of plain environment variables.
  This mitigates plaintext-in-environment exposure for *env-supplied* credentials at container
  start. It does **not** address the specific gap item 6 called out: `llmKeyStore.ts` still
  writes an admin-set platform LLM key to a local file (`0600`), unrelated to how the container
  itself was started. Item 6 remains open for that code path; a real secrets manager (cloud KMS,
  Vault, etc.) is still the recommended end state for a managed production environment.

No other findings or open items in this document are affected.

