# AGI DevOps Harness (TypeScript, Docker)

A goal-driven, self-evolving LLM agent harness. The LLM is the only "processor"; everything else is scaffolding:
plan, act, verify, remember, measure itself against a goal, and upgrade itself **safely**.

**Goal (editable in the UI):** *"Be efficient at DevOps work, keep learning, and execute operations with precision."*
Measured by KPIs: task success rate, safety violation rate, median steps, mean time to recover, verified skills.

## Run

```bash
cp .env.example .env            # optional; defaults run in offline mock mode
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:7000 | UI: chat, live activity (OpenTelemetry spans), goal/KPIs, evolution, approvals, KILL |
| http://localhost:16686 | Jaeger: full OpenTelemetry traces |

**Mock mode (default)** needs no API key. It solves the built-in eval scenarios with scripted answers so you can watch the
entire pipeline (loop, policy, evals, evolution, promotion, rollback) work. For real use set in `.env`:
`LLM_MODE=anthropic` and `ANTHROPIC_API_KEY=...`, then `docker compose up --build`.

Try, in the UI: **Goal tab > Measure KPIs** (runs 8 DevOps scenarios in the sandbox), then **Evolve now**, then watch the
**Evolution** tab. Or from a shell: `./scripts/smoke.sh`.

Rollback demo: `docker compose -f docker-compose.yml -f docker-compose.chaos.yml up --build`, then press *Evolve now*.
Every promotion is forced to fail probation and the supervisor reverts automatically.

## How isolation works

| Layer | Mechanism |
|---|---|
| Execution | **All commands run in the `sandbox` container**, never in the agent's. |
| Network | Sandbox is only on an `internal: true` network: no internet, no route to the host. |
| Container hardening | Sandbox: non-root uid 2000, read-only rootfs, `cap_drop: ALL`, no-new-privileges, 512 MB RAM, 1 CPU, 256 pids, tmpfs workspace wiped on restart. |
| Per-command limits | 30 s timeout (process group killed), 64 KB output cap, stripped environment (no secrets), per-session directories, path-escape checks. |
| Policy engine | Deterministic regex rules in `kernel/policy.json`: deny (fork bomb, `rm -rf /`, pipe-to-shell, path traversal), approve (recursive delete, force flags), independent of the LLM. |
| Prompt injection | Tool output and memory are wrapped as untrusted data; evals include an injection trap. |
| Human gate | Flagged actions pause for approval in the UI (auto-deny after 5 min). |
| Privilege separation | Supervisor (root) launches the agent as uid 1001. The agent cannot write code, kernel, policy, evals, or the release pointer. |
| Kill switch | UI button / `POST /kill` halts all runs and evolution. |

## How self-evolution works (and why it can't crash the system)

The running agent **never edits itself**. It edits a *genome* (prompts + tuning parameters) as a candidate:

1. **Diagnose**: run the kernel's golden + safety suites, find the weakest KPI.
2. **Propose**: the LLM suggests a minimal genome change (whitelisted keys only).
3. **Test**: a separate agent instance with the candidate genome runs all scenarios in the sandbox.
4. **Gates** (kernel code): genome valid and still contains safety wording, only whitelisted keys changed, zero policy violations, no regressions, score >= baseline + epsilon.
5. **Approval**: prompt changes need a human click by default (`EVOLVE_APPROVAL`).
6. **Promote**: agent writes a request; the **supervisor** re-validates, copies the release to root-owned storage, atomically swaps `current`, restarts the agent.
7. **Probation**: the new release must pass smoke evals within `PROBATION_SECONDS`, else automatic rollback to the last stable release (also on crash loops or missed health checks).

Skills (verified bash procedures) are learned continuously, but saved only if their own test passes in the sandbox.

## Layout

```
kernel/   supervisor.ts  evals.ts  gates.ts  policy.json  evals/scenarios.json   (read-only in the image)
src/      agi.ts (core loop)  api.ts  evolve.ts  llm.ts  memory.ts  tools.ts  telemetry.ts  goal.ts ...
sandbox/  Dockerfile  server.js      (the isolated exec service)
ui/       React + TS (Chat, Activity, GoalPanel, Evolution, Approvals)
```

## Honest limits

- **Capability ceiling is the base model's.** The harness adds persistence, verification, memory, and safe self-tuning; it does not add reasoning the LLM lacks.
- **Evolution scope is prompts, parameters, and skills.** Rewriting the harness's own code (a higher tier) is deliberately not enabled.
- **The sandbox simulates DevOps with files and shell** (YAML, Dockerfiles-style configs, logs, scripts). There is no real Kubernetes or cloud inside it, and production access is intentionally not wired up. The autonomy levels and approval flow are ready for it.
- **Eval scenarios are few (8)** and LLM runs are noisy; add scenarios in `scripts/build_scenarios.py` and use a larger epsilon. Small candidate gains can be noise.
- **Container isolation is not a VM.** For untrusted workloads add gVisor/Kata (`runtime: runsc`) and an egress firewall for the agent container (it needs internet only for the LLM API).
- Metrics beyond traces (OTel metrics) are not implemented; KPIs are exposed through the API/UI.
- The UI/API are bound to localhost with no authentication; do not expose them publicly.

## Local dev without Docker

```bash
npm ci && npm run build
WORK_ROOT=/tmp/work SANDBOX_TOKEN=t node sandbox/server.js &
DATA_DIR=/tmp/data SANDBOX_URL=http://localhost:9000 SANDBOX_TOKEN=t LLM_MODE=mock node dist/kernel/supervisor.js
```
