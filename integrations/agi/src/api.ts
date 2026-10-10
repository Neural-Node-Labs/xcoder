import express from "express";
import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { bus, recent } from "./telemetry";
import { Agi } from "./agi";
import { Evolver } from "./evolve";
import { GoalStore } from "./goal";
import { Approvals, KillSwitch } from "./control";
import { Memory } from "./memory";
import { Sandbox } from "./sandbox";
import { runSuites } from "../kernel/evals";
import { PORT } from "./config";
import type { LlmClient } from "./llm";
import { Scheduler } from "./scheduler";

export interface ApiDeps {
  agi: Agi; evolver: Evolver; goal: GoalStore; approvals: Approvals; kill: KillSwitch;
  llm: LlmClient; scheduler: Scheduler; memory: Memory; sandbox: Sandbox; state: { release: string; probation: "n/a" | "pending" | "pass" | "fail"; busy: number };
}

export function startApi(d: ApiDeps) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // xcoder integration: the AGI API has no user accounts, so when AGI_API_TOKEN is set every route
  // except /healthz (the container healthcheck) requires `Authorization: Bearer <token>`. xcoder's
  // authenticated proxy (src/api/agiProxy.ts) is the only intended caller. Constant-time compare.
  const apiToken = process.env.AGI_API_TOKEN ?? "";
  // REQUIRE_API_TOKEN=1 (set in docker-compose.yml) makes a missing/default secret a startup
  // failure instead of silently running an open, command-executing agent on the compose network.
  if (process.env.REQUIRE_API_TOKEN === "1") {
    const bad = (v: string | undefined) => !v || v.length < 16 || /^change-me/i.test(v);
    if (bad(apiToken)) { console.error("[agent] REQUIRE_API_TOKEN=1 but AGI_API_TOKEN is unset, <16 chars, or a placeholder — refusing to start"); process.exit(1); }
    if (bad(process.env.SANDBOX_TOKEN)) { console.error("[agent] REQUIRE_API_TOKEN=1 but SANDBOX_TOKEN is unset, <16 chars, or a placeholder — refusing to start"); process.exit(1); }
  }
  app.get("/healthz", (_q, r) => r.json({ ok: true, release: d.state.release, probation: d.state.probation }));
  app.use((q, r, next) => {
    if (!apiToken) return next();
    const m = /^Bearer (.+)$/.exec(q.header("authorization") ?? "");
    const a = Buffer.from(m?.[1] ?? ""); const b = Buffer.from(apiToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return next();
    r.status(401).json({ error: "unauthorized" });
  });

  app.get("/status", async (_q, r) => r.json({
    release: d.state.release, genome: d.agi.d.genome.version, probation: d.state.probation, llmMode: d.llm.mode, llmFp: d.llm.fp, llmModels: d.llm.models,
    sandbox: await d.sandbox.healthy(), killed: d.kill.engaged(), busy: d.state.busy, skills: d.memory.skillCount(),
  }));

  // Runtime LLM connection (xcoder gateway pushes the tenant's / platform's choice). Behind the same bearer token as
  // everything else; the key is kept in memory only and never returned.
  app.get("/llm", (_q, r) => r.json({ mode: d.llm.mode, fp: d.llm.fp, models: d.llm.models }));
  app.put("/llm", (q, r) => {
    if (d.state.busy) return r.status(409).json({ error: "agent busy; retry shortly" });
    const err = d.llm.configure({ fp: String(q.body?.fp ?? ""), mode: q.body?.mode, baseUrl: q.body?.baseUrl, endpoint: q.body?.endpoint, apiKey: typeof q.body?.apiKey === "string" ? q.body.apiKey : undefined, models: q.body?.models });
    err ? r.status(400).json({ error: err }) : r.json({ ok: true, mode: d.llm.mode, fp: d.llm.fp });
  });

  app.post("/chat", async (q, r) => {
    if (d.kill.engaged()) return r.status(423).json({ error: "kill switch engaged" });
    const message = String(q.body?.message ?? "").slice(0, 4000);
    if (!message.trim()) return r.status(400).json({ error: "empty message" });
    const session = "chat-" + String(q.body?.session ?? "default").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    d.state.busy++;
    try {
      const res = await d.agi.handle(message, { runId: randomUUID().slice(0, 8), session, mode: "chat", history: q.body?.history });
      r.json(res);
    } finally { d.state.busy--; }
  });

  app.get("/events", (q, r) => {
    r.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    r.flushHeaders();
    const send = (e: unknown) => r.write(`data: ${JSON.stringify(e)}\n\n`);
    bus.on("event", send);
    const ka = setInterval(() => r.write(": ka\n\n"), 15000);
    q.on("close", () => { bus.off("event", send); clearInterval(ka); });
  });
  app.get("/recent", (_q, r) => r.json(recent.slice(-500)));

  app.get("/goal", (_q, r) => r.json(d.goal.get()));
  app.put("/goal", (q, r) => r.json(d.goal.set(q.body ?? {})));
  app.post("/goal/measure", async (_q, r) => {
    if (d.evolver.running) return r.status(409).json({ error: "evolution cycle running" });
    r.json((await d.evolver.baseline(true)).results);
  });
  app.post("/goal/practice", async (_q, r) => {   // practice = real runs with reflection + skill learning enabled
    const rep = await runSuites(["golden"], d.agi, d.sandbox, { learn: true, label: "practice" });
    d.evolver.applyKpis(rep); r.json(rep.results);
  });
  app.post("/knowledge", (q, r) => { d.memory.addFact(String(q.body?.text ?? "").slice(0, 4000)); r.json({ ok: true }); });
  app.get("/skills", (_q, r) => r.json(d.memory.skills().map((s) => ({ name: s.name, description: s.description, uses: s.uses }))));

  app.get("/approvals", (_q, r) => r.json(d.approvals.list()));
  app.post("/approvals/:id/:decision", (q, r) => r.json({ ok: d.approvals.decide(q.params.id, q.params.decision === "approve") }));

  app.get("/evolutions", (_q, r) => r.json({ running: d.evolver.running, items: d.evolver.list() }));
  app.post("/evolutions/propose", (_q, r) => {
    if (d.kill.engaged()) return r.status(423).json({ error: "kill switch engaged" });
    if (d.evolver.running) return r.status(409).json({ error: "already running" });
    void d.evolver.cycle(); r.status(202).json({ started: true });
  });
  app.post("/evolutions/:id/approve", (q, r) => { const e = d.evolver.approve(q.params.id); e ? r.json(e) : r.status(404).json({ error: "not awaiting approval" }); });
  app.post("/evolutions/:id/reject", (q, r) => { const e = d.evolver.reject(q.params.id); e ? r.json(e) : r.status(404).json({ error: "not awaiting approval" }); });

  app.get("/schedule", (_q, r) => r.json(d.scheduler.status()));
  app.put("/schedule", (q, r) => { const o = d.scheduler.update(q.body); typeof o === "string" ? r.status(400).json({ error: o }) : r.json(d.scheduler.status()); });

  app.post("/kill", (_q, r) => { d.kill.engage(); r.json({ killed: true }); });
  app.post("/kill/reset", (_q, r) => { d.kill.reset(); r.json({ killed: false }); });

  return app.listen(PORT, "0.0.0.0", () => console.log(`[agent] api on :${PORT}`));
}
