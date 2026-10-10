# AGI DevOps agent × xcoder

The AGI harness (`UPSTREAM_README.md`) is vendored here as an **optional, separately running service**. xcoder's UI exposes it as the **🧠 AGI** tab beside **▶ Task** and **💬 Chat**.

```
 Browser ──(xcoder bearer token)──▶ xcoder API  /api/v1/agi/*  ──(shared secret)──▶ agi  ──▶ agi-sandbox
   AGI tab                          role-gated, validated,                          agent +    exec only,
                                    rate-limited, audited                           supervisor no internet
```

## Why a gateway and not "merge the code"
The AGI's safety comes from process/container boundaries: a root supervisor launches the agent as uid 1001, the agent can't write the kernel/policy/release pointer, and every command runs in a sandbox on an `internal: true` network. Importing it into xcoder's API process would erase those boundaries. So it stays its own service, and xcoder adds what it lacked: **authentication** (upstream had none and bound to localhost).

## Enabled by default
The AGI services are part of the main `docker-compose.yml`, so a plain `docker compose up -d --build` starts them
(`secrets-init`, `agi`, `agi-sandbox`, `agi-jaeger`); `docker-compose.prod.yml` layers on top as before.

* **Secrets need no setup.** `secrets-init` generates both shared secrets (192-bit random) on first start and keeps them in
  the `shared_secrets` volume; the services read them from files (`*_FILE`). Put `AGI_API_TOKEN` / `SANDBOX_TOKEN` (16+
  chars) in `.env` to pin your own. The agent still refuses to start with a missing or placeholder secret.
* **Offline mock model by default.** Set `AGI_LLM_MODE=anthropic` and `ANTHROPIC_API_KEY` for real work.
* **Autonomous mode stays off** until an admin starts it in AGI → Schedule, so nothing spends tokens by itself.
* **xcoder does not depend on the agent.** If it is down the tab shows "unreachable" and everything else works.
* **Opt out:** `XCODER_AGI_URL=off` in `.env`, and start with
  `--scale agi=0 --scale agi-sandbox=0 --scale agi-jaeger=0 --scale secrets-init=0`.

Nothing publishes a host port except Jaeger on `127.0.0.1:16686`. With the gateway disabled the tab shows setup instructions and the gateway answers 503.

## Who can do what
The AGI is **one shared agent**; its activity feed carries other users' prompts and tool arguments, so it is not multi-tenant safe.

| | Any signed-in user | Admin |
|---|---|---|
| Status, goal (read), skills | ✅ | ✅ |
| Chat (own session `u<userId>`, task rate-limited, validated) | ✅ | ✅ |
| Live activity (OpenTelemetry span stream), approvals, evolutions | ❌ 403 | ✅ |
| Measure KPIs / practice / evolve / goal+autonomy / knowledge | ❌ | ✅ |
| Kill switch / resume | ❌ | ✅ |

Every admin mutation is written to xcoder's audit log as `agi.*`. Approvals of destructive actions are admin-only, so a normal user's chat that triggers one waits (auto-denied after 5 min) until an admin approves it in the tab.

## Gateway hardening (src/api/agiProxy.ts)
- All routes registered after `authMiddleware` (covered by `routeAuthCoverage.test.ts`).
- Bodies validated field-by-field and never spread upstream; ids pattern-checked; sizes capped (message 4000, history 12 × 4000, goal statement 500).
- Upstream gets only the shared secret — never the user's token or cookies; `redirect: "error"`; base URL reduced to an origin; 8 s default / 10 min long-run timeouts.
- Upstream 5xx bodies (stack traces, paths) are replaced with a generic message; upstream 4xx meaning (423 kill switch, 409 busy) is preserved.
- SSE: max 3 streams per admin / 20 total, aborted on client disconnect, `X-Accel-Buffering: no`; nginx has an unbuffered 1 h location for it. The browser reads it with `fetch` streaming (EventSource can't send `Authorization`), so no token ever appears in a URL.
- Each proxied call is an OpenTelemetry span (`agi.proxy`) when xcoder's OTel is enabled.

## Per-tenant LLM and dedicated instances (SaaS)
`PUT /llm` (admin token) sets provider, base URL, key and per-tier models at runtime; `GET /llm` and `/status` (`llmMode`, `llmFp`, `llmModels`) never expose the key. The gateway pushes the config for the right instance whenever the instance's fingerprint differs from the wanted one. In SaaS mode the owner attaches a dedicated instance per tenant (`PUT /saas/tenants/:id/agi`); tenants cannot use the shared instance.

## Changes to the vendored code
Only: `AGI_API_TOKEN` bearer check on every route except `/healthz`; `REQUIRE_API_TOKEN=1` startup guard (weak/placeholder `AGI_API_TOKEN` or `SANDBOX_TOKEN` ⇒ exit 1); the standalone React UI and static serving were removed (the tab replaces them). Upstream's own limits still apply — see `UPSTREAM_README.md` ("Honest limits"): capability is the base model's, only 8 eval scenarios, container isolation is not a VM (use gVisor/Kata + an egress firewall for untrusted workloads), and the sandbox simulates DevOps with files and shell — no real Kubernetes/cloud.

## Verified
`src/api/__tests__/agiProxy.test.ts` (51 tests, fake upstream over real HTTP), UI tests for the span reducer / SSE parser, and a live run of the real sandbox + supervisor + xcoder API: roles, chat, KPI measurement (173 spans streamed), kill switch (423), a promoted evolution (`v0002`), and audit entries. In mock mode `shell-fix` fails on a host without `shellcheck`; the sandbox image installs it.

## Autonomous mode (Schedule)

Admins can turn the agent into a self-running loop from **AGI → Schedule**. When on, every *N* minutes (5–10080) the
agent measures its KPIs and, if one is off target, runs one evolution cycle (same gates, probation, rollback and
approvals as a manual one). It spends from a **token allowance** (10k–100M per window) that refills at midnight in a
chosen UTC offset or 24 h after first use. When the allowance is spent the loop pauses and resumes by itself at the
refill. Settings and usage are persisted in `$DATA_DIR/agent/schedule.json` and `ledger.json`, so restarts neither
lose the schedule nor reset the count. Raising the allowance while paused resumes immediately.

Guarantees and limits: a cycle won't start with < 5,000 tokens left; a running cycle is stopped at the next model call
after the cap (overshoot ≤ one call); human chat is never blocked but its tokens count; it never runs while the kill
switch is engaged or the release is on probation; it is off by default; `GOAL_LOOP_MINUTES` is ignored.
