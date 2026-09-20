# xcoder — Security & Enterprise-Readiness Review: New Integrations

**Scope:** everything added in this working session — Google sign-in, the CodeGraph integration
(bundled process manager, REST proxy, MCP client, Docker services), the generic MCP tool, and the
web search tool. This is a separate, narrower document from `SECURITY_REVIEW.md` (that one covers
the pre-existing multi-tenant/access-control review); this one covers what's new since.

**Method:** static read-through of every new/changed file, cross-referenced against this
codebase's own established patterns (e.g. `workspaceConfinement.ts`, `authMiddleware`), plus live
verification of every fix below against a real running stack — not just a code-level guess. All
582 existing tests pass throughout.

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `/codegraph-api` proxy was reachable with **no xcoder authentication at all** | **High** | **Fixed** |
| 2 | `codegraph_tool`'s `index_workspace` `path` param allowed traversal outside the workspace | **Medium** | **Fixed** |
| 3 | `codegraph-api` / `codegraph-mcp` containers ran as root | Medium | **Fixed** |
| 4 | `index-workspace` route had no rate limiting | Medium | **Fixed** |
| 5 | Default CodeGraph admin password shipped in `docker-compose.yml` | Medium | Documented; **action needed by operator** |
| 6 | `securityOpsTool.ts` / `securityOpsAllowlistStore.ts` are complete but never wired in | Info | Noted — inert, zero live risk |
| 7 | `mcp_tool` grants the LLM effectively-arbitrary process execution | Info | By design, same class as pre-existing `run_command_tool` |
| 8 | URL-fetching tools have no egress restriction — SSRF-shaped by design | Info | By design; documented residual risk |
| 9 | No audit log for admin actions (start/stop/connect CodeGraph, add Google user, etc.) | Low | Recommended follow-up |
| 10 | `codegraph-mcp` fetches its API key over plain HTTP on every start | Low | Accepted (compose-internal network only) |

---

## Detailed findings

### 1. [HIGH — Fixed] Unauthenticated access to the CodeGraph proxy, bypassing xcoder's login rate limiter

**What I found:** `/codegraph-api` and `/codegraph-ui` are mounted directly on the raw Express
`app`, ahead of the `/api/v1` router — which is where `authMiddleware` actually lives. That
placement is legitimate on its own (needed so large project .zip uploads stream through before
`express.json()` would buffer them) — but it meant the proxy had **no authentication check of
any kind**.

CodeGraph's own backend does require its own auth on every data endpoint
(`Depends(get_current_user)` on every `/api/*` route in `codegraph/app/api.py`) — so this wasn't
a raw data leak. But it meant:

- An anonymous caller with **no xcoder account** could hit `/codegraph-api/api/auth/login`
  directly and brute-force CodeGraph's admin password with **zero rate limiting** — completely
  bypassing xcoder's own 10-attempts/15-minute login limiter (`checkRateLimit` in `auth.ts`).
- Combined with finding #5 (a default, documented admin password in `docker-compose.yml`), this
  was a realistic path to full CodeGraph admin compromise by anyone who could reach the xcoder
  URL at all.

**The fix (`src/api/codegraphProxy.ts`, `src/api/routes.ts`):** the proxy now requires a valid
xcoder session before forwarding anything. This has to be **cookie-based**, not the
`Authorization: Bearer` header check `authMiddleware` uses elsewhere — the actual browser
traffic hitting this proxy is made by `codegraph-ui`'s own JS (inside the embedded iframe),
which attaches *CodeGraph's* token in that header, not xcoder's. A Bearer-token check would have
rejected every legitimate request from the embedded UI as readily as an attacker's. Cookies are
different: the browser attaches them automatically to any same-origin request regardless of
which script on the page issued it. So:

- `routes.ts` now sets an `httpOnly`, `sameSite: strict`, path-scoped (`/codegraph-api` only)
  cookie on every successful login/register/Google sign-in, cleared on logout.
- `codegraphProxy.ts` checks that cookie (falling back to a normal Bearer token for non-browser
  callers like scripts) before forwarding anything; unauthenticated requests now get a clean 401.

**Verified live**, not just by inspection: booted the real server, confirmed an anonymous POST to
`/codegraph-api/api/auth/login` returns `401` before this reaches CodeGraph at all, then
confirmed the exact same request succeeds (reaches the real proxy logic — evidenced by a
different, expected `503 CodeGraph not connected` response) once a real xcoder session cookie is
present.

### 2. [MEDIUM — Fixed] Path traversal in `codegraph_tool`'s `index_workspace` action

**What I found:** the `path` parameter (LLM-controlled, meant to scope indexing to a subpath of
the current project) was resolved with plain `path.resolve(cwd, args.path)` — no confinement
check. `path: "../../../../etc"` would legitimately resolve outside the project directory, and
`indexWorkspace()` would zip and upload whatever it found there to CodeGraph.

This isn't a *novel* risk in xcoder's threat model — `run_command_tool` already grants the agent
effectively full shell access by design (see finding #7), so "the agent can read arbitrary host
paths" isn't new. The actual bug is **inconsistency**: every other file-touching tool in this
codebase (`writeFileTool.ts`, `readTool.ts`, etc.) already routes through a shared, opt-in
confinement helper — `resolveConfinedPath()` in `workspaceConfinement.ts`, gated by
`XCODER_RESTRICT_TO_WORKSPACE=true`. `index_workspace` was the one tool that silently ignored
that setting. If an admin has explicitly turned confinement on, every tool should honor it
uniformly — a silent exception defeats the point of having the toggle at all.

**The fix:** `index_workspace`'s `path` param now goes through the same `resolveConfinedPath()`
every other file tool uses.

### 3. [MEDIUM — Fixed] New Docker containers ran as root

xcoder's own `Dockerfile` already creates and switches to a non-root `xcoder` user. The two new
containers (`integrations/codegraph/codegraph/Dockerfile`,
`integrations/codegraph/codegraph-mcp/Dockerfile`) had no `USER` directive at all — default root,
violating the same least-privilege standard xcoder's own image already follows (and CIS Docker
Benchmark 4.1).

**The fix:** both Dockerfiles now create and switch to a dedicated non-root user, matching
xcoder's existing pattern. For `codegraph-api`, `/data` (the volume mount point for
`CODEGRAPH_DB`/`PROJECTS_ROOT`) is chowned to that user *before* the `VOLUME` instruction, so the
fresh named volume Compose creates on first `up` inherits correct write permissions rather than
defaulting to root:root.

*Not independently verified against a live container build* — no Docker daemon in this
environment. The change follows the exact pattern already proven working in xcoder's own
Dockerfile, but treat this one as "reviewed by inspection," not "live-verified" — sanity-check
`docker compose --profile codegraph up` after pulling this.

### 4. [MEDIUM — Fixed] No rate limiting on `index-workspace`

Any authenticated non-admin user could call `POST /platform/integrations/codegraph/index-workspace`
in a tight loop — each call does real, non-trivial work (zip a project, upload it, trigger
CodeGraph's static analysis) against shared CodeGraph/xcoder resources. **Fix:** now reuses the
existing task-submission limiter (`checkTaskRateLimit`, 30/hour/user by default) — the same
mechanism `/chat` and other expensive per-user routes already use, rather than inventing a new
one.

### 5. [MEDIUM — Operator action needed] Default CodeGraph admin password in `docker-compose.yml`

`CODEGRAPH_ADMIN_PASSWORD:-codegraph_admin_pass}` ships as a fallback default. This is documented
inline ("change this before any shared deployment") and in `.env.example`, and finding #1 closes
the "anyone on the internet can brute-force it directly" path — but a **guessable, checked-in
default password is still a real weakness on its own** if `.env` isn't set before a non-local
deployment. I did not change this to a forced-random value, because docker-compose can't
generate-and-persist a secret across `up` runs on its own without an init container or external
secrets manager — that's a deliberate scope decision, not an oversight. **Recommendation:**
treat `CODEGRAPH_ADMIN_PASSWORD` (and `CODEGRAPH_SECRET_KEY`) the same as `DATABASE_PASSWORD` —
required in `.env` for anything beyond local eval, ideally enforced by a startup check that
refuses to boot with the placeholder value in a production-flagged environment.

### 6. [INFO] `securityOpsTool.ts` is complete but not wired into the system

From an earlier request in this session (integrating Blue Team/Red Team audit tooling), the tool
implementation and its target allowlist store are fully written (`src/tools/securityOpsTool.ts`,
`src/api/securityOpsAllowlistStore.ts`) but **never registered** in `toolSchemas.ts` or
`toolDispatcher.ts`, and no route exposes it. Confirmed via direct grep — zero references outside
those two files. This poses no live risk (it's dead code from the running system's perspective),
but flagging it so it isn't mistaken for a shipped feature, and so it gets either finished
(schema + dispatcher registration + a Platform UI panel) or removed in a follow-up pass.

### 7. [INFO — by design] `mcp_tool` is a broad trust boundary

`mcp_tool` spawns arbitrary local processes via LLM-supplied `command`/`args`, same class as the
pre-existing `run_command_tool` — both grant the orchestrating LLM what amounts to host shell
access, gated only by the `XCODER_DISABLE_SHELL_TOOLS` kill switch (which `mcp_tool` was
correctly added to alongside `run_command_tool`, `ssh_tool`, etc.). This is consistent with this
codebase's existing, explicit threat model (see `workspaceConfinement.ts`'s own comment: *"the
agent is fully trusted, equivalent to shell access, by design"*) — not a new gap, and not
something to silently "fix" without a broader conversation about whether that threat model should
change. Documenting it here because an enterprise reviewer will ask: **xcoder's current model
assumes the LLM backing every engine is trusted not to be adversarial.** If that assumption
doesn't hold for your deployment (e.g. exposure to prompt injection from crawled/untrusted
content — see finding #8), the mitigation is environment-level (containerization,
`XCODER_DISABLE_SHELL_TOOLS`, network egress controls, running xcoder as a restricted service
account), not something addressable purely inside the tool layer.

### 8. [INFO — by design] URL-fetching tools have no egress allowlist (SSRF-shaped)

`summarize_url_tool` (pre-existing), `crawl_site_mapper_tool` (pre-existing), and the new
`web_search_tool` all fetch URLs. `web_search_tool` only ever calls a fixed DuckDuckGo endpoint
(no user-controlled target — not itself an SSRF vector), but `summarize_url_tool` and the crawl
tools accept an LLM-supplied URL with no restriction on scheme/host, including internal-only
addresses or cloud metadata endpoints (`169.254.169.254`) if xcoder runs in a cloud VM. Same
category as finding #7 — a consequence of the existing trust model, not something introduced this
session. Worth a network-segmentation mitigation (deny outbound to link-local/private ranges from
the xcoder process) for cloud deployments, independent of any specific tool.

### 9. [LOW] No audit trail for admin actions

Starting/stopping the bundled CodeGraph server, connecting an external instance, adding a
Google-linked user account — none of these write an audit log entry (who did it, when). Given
xcoder now has multiple integration surfaces an admin can toggle, an enterprise deployment will
generally want these logged somewhere durable (even just structured stdout lines an aggregator
can pick up) for incident review. Not fixed in this pass — flagging as a reasonable next step
rather than doing a partial, inconsistent job of it under time pressure.

### 10. [LOW — accepted] `codegraph-mcp` fetches its API key over plain HTTP on every start

`fetch_api_key.py` logs in to `codegraph-api` over `http://codegraph-api:8000` (compose-internal
DNS name) — unencrypted, but confined to the Docker Compose bridge network, not exposed
externally. Acceptable for the default topology; if `codegraph-api` is ever exposed outside the
compose network directly, this should move to TLS.

---

## What I did *not* re-litigate

Pre-existing password hashing (scrypt, timing-safe compare, legacy-hash migration), token
generation/TTL, and per-IP/per-user rate limiting in `auth.ts` were reviewed for how new code
interacts with them, not redesigned — see `SECURITY_REVIEW.md` for the review that covered that
ground originally.

## Verification

- `npx tsc -p tsconfig.json --noEmit` (backend) and `npx tsc -b` (frontend): clean.
- `npx vitest run`: 582/582 passing.
- Findings #1 and #4 verified against a live running server (not just code inspection) —
  confirmed the 401 block, the cookie-authenticated pass-through, and the rate-limit behavior.
- Finding #3 (Dockerfile changes) is reviewed-by-inspection only — no Docker daemon available in
  this environment to build/run the images. Recommend a build-and-boot smoke test before relying
  on it in production.
