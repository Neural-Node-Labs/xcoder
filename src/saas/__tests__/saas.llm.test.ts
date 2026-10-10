import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-llm-"));
vi.stubEnv("XCODER_SAAS_MODE", "true");
vi.stubEnv("XCODER_SAAS_DATA_DIR", path.join(tmp, "saas"));
vi.stubEnv("XCODER_USERS_STORE", path.join(tmp, "users.json"));
vi.stubEnv("XCODER_PROJECTS_STORE", path.join(tmp, "projects.json"));
vi.stubEnv("XCODER_PROJECTS_ROOT", path.join(tmp, "ws"));
vi.stubEnv("XCODER_AGI_URL", "off");

// A fake OpenAI-compatible provider that records who called it, and a fake AGI instance that records pushed config.
const providerCalls: Array<{ auth: string | undefined; model: string }> = [];
const agiPushes: Array<{ port: number; body: any; auth?: string }> = [];
let provider: Server, agiA: Server, agiPortA = 0, server: Server, base = "", provPort = 0;
const tok: Record<string, string> = {};
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as any).port)));
async function call(who: string | null, method: string, url: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${tok[who]}` } : {}) }, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) });
  let json: any = null; try { json = await r.json(); } catch { /* none */ }
  return { status: r.status, json, data: json?.data };
}
async function login(name: string, username: string, password: string) { const r = await call(null, "POST", "/login", { username, password }); tok[name] = r.data.token; }

beforeAll(async () => {
  provider = http.createServer((q, r) => {
    let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => {
      const j = JSON.parse(b || "{}"); providerCalls.push({ auth: q.headers.authorization, model: j.model });
      r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { total_tokens: 7 } }));
    });
  });
  provPort = await listen(provider);
  agiA = http.createServer((q, r) => {
    let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => {
      r.setHeader("content-type", "application/json");
      if (q.url === "/llm" && q.method === "PUT") { agiPushes.push({ port: agiPortA, body: JSON.parse(b), auth: q.headers.authorization }); return r.end('{"ok":true}'); }
      if (q.url === "/status") return r.end(JSON.stringify({ release: "r1", llmMode: "mock", llmFp: agiPushes.at(-1)?.body.fp ?? "" }));
      r.end("{}");
    });
  });
  agiPortA = await listen(agiA);

  const { createRouter } = await import("../../api/routes.js");
  const app = express(); app.use(express.json()); app.use("/api/v1", createRouter());
  await new Promise<void>((res) => { server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`; res(); }); });
  tok.owner = (await call(null, "POST", "/register", { username: "owner", password: "ownerpass1" })).data.token;
  for (const n of ["a", "b"]) await call("owner", "POST", "/saas/tenants", { name: `Tenant ${n}`, plan: "pro", adminUsername: `admin_${n}`, adminPassword: `password-${n}` });
  await login("adminA", "admin_a", "password-a"); await login("adminB", "admin_b", "password-b");
  await call("adminA", "POST", "/tenant/users", { username: "user_a", password: "password-ua" }); await login("userA", "user_a", "password-ua");
});
afterAll(async () => { for (const s of [server, provider, agiA]) await new Promise<void>((r) => s.close(() => r())); fs.rmSync(tmp, { recursive: true, force: true }); });

const custom = () => ({ mode: "custom", provider: "acme", base_url: `http://127.0.0.1:${provPort}/v1`, model: "acme-large", apiKey: "tenant-a-secret-key" });

describe("tenant LLM connections", () => {
  it("rejects a private base_url by default (SSRF) and unsafe input", async () => {
    expect((await call("adminA", "PUT", "/llm/connections/task", custom())).status).toBe(400);
    expect((await call("adminA", "PUT", "/llm/connections/task", { ...custom(), base_url: "https://169.254.169.254/x" })).status).toBe(400);
    expect((await call("adminA", "PUT", "/llm/connections/task", { mode: "custom", provider: "Bad Name!", model: "m", apiKey: "12345678" })).status).toBe(400);
    expect((await call("adminA", "PUT", "/llm/connections/nope", custom())).status).toBe(404);
  });
  it("only the tenant admin may change connections", async () => {
    expect((await call("userA", "PUT", "/llm/connections/task", custom())).status).toBe(403);
    expect((await call("owner", "PUT", "/llm/connections/task", custom())).status).toBe(403);
    expect((await call("userA", "GET", "/llm/connections")).status).toBe(200);
  });
  it("owner policy gates private URLs, providers, and tenant configuration", async () => {
    expect((await call("adminA", "PUT", "/saas/llm/policy", { allowPrivateUrls: true })).status).toBe(403);
    expect((await call("owner", "PUT", "/saas/llm/policy", { allowPrivateUrls: true, allowedProviders: ["acme"] })).status).toBe(200);
    expect((await call("adminA", "PUT", "/llm/connections/task", { ...custom(), provider: "other" })).status).toBe(400);
    expect((await call("owner", "PUT", "/saas/llm/policy", { tenantMayConfigure: false })).status).toBe(200);
    expect((await call("adminA", "PUT", "/llm/connections/task", custom())).status).toBe(400);
    expect((await call("owner", "PUT", "/saas/llm/policy", { tenantMayConfigure: true })).status).toBe(200);
  });
  it("saves a connection, never returns the key, and encrypts it at rest", async () => {
    const r = await call("adminA", "PUT", "/llm/connections/task", custom()); expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain("tenant-a-secret-key");
    const g = await call("adminA", "GET", "/llm/connections");
    expect(JSON.stringify(g.json)).not.toContain("tenant-a-secret-key");
    expect(g.data.connections[0]).toMatchObject({ slot: "task", hasKey: true, model: "acme-large" });
    expect(g.data.effective.task).toMatchObject({ source: "tenant", ownKey: true });
    const onDisk = fs.readdirSync(path.join(tmp, "saas", "tenants")).map((d) => path.join(tmp, "saas", "tenants", d, "llm.json")).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8")).join("");
    expect(onDisk).not.toContain("tenant-a-secret-key"); expect(onDisk).toContain("ct");
  });
  it("the test button calls the tenant's own provider with the tenant's own key", async () => {
    providerCalls.length = 0;
    const r = await call("adminA", "POST", "/llm/connections/task/test"); expect(r.data).toMatchObject({ ok: true, model: "acme-large" });
    expect(providerCalls).toEqual([{ auth: "Bearer tenant-a-secret-key", model: "acme-large" }]);
  });
  it("tenant B sees nothing of tenant A's connection, and cannot touch it", async () => {
    const g = await call("adminB", "GET", "/llm/connections");
    expect(g.data.connections).toEqual([]); expect(JSON.stringify(g.json)).not.toMatch(/127\.0\.0\.1|acme-large/);
    expect((await call("adminB", "DELETE", "/llm/connections/task")).status).toBe(404);
    expect((await call("adminA", "GET", "/llm/connections")).data.connections).toHaveLength(1);
  });
  it("tenant settings are hidden from the platform's own LLM settings (no platform URL/provider leak)", async () => {
    for (const u of ["/settings/llm-config", "/settings/llm-key", "/settings/llm-providers"]) expect((await call("adminA", "GET", u)).status, u).toBe(403);
  });
  it("without platform fallback, an unconfigured tenant is refused cleanly; a configured one is not", async () => {
    expect((await call("owner", "PUT", "/saas/llm/policy", { platformFallback: false })).status).toBe(200);
    expect((await call("adminB", "POST", "/projects", { name: "p" })).status).toBeLessThan(300);
    const r = await call("adminB", "POST", "/chat", { task: "hi", engine: "assistant" });
    expect(r.status).toBe(422); expect(r.json.code).toBe("llm_not_configured");
    expect((await call("adminB", "POST", "/llm/connections/task/test")).data.ok).toBe(false);
    expect((await call("owner", "PUT", "/saas/llm/policy", { platformFallback: true })).status).toBe(200);
  });
  it("a tenant with its own key bypasses the platform allowance gate; one without does not", async () => {
    const ids = (await call("owner", "GET", "/saas/tenants")).data;
    const a = ids.find((t: any) => t.name === "Tenant a").id, b = ids.find((t: any) => t.name === "Tenant b").id;
    await call("owner", "PUT", `/saas/tenants/${a}`, { quotas: { monthlyRequests: 0 } }); await call("owner", "PUT", `/saas/tenants/${b}`, { quotas: { monthlyRequests: 0 } });
    expect((await call("adminB", "POST", "/chat", { task: "hi" })).status).toBe(429);
    expect((await call("adminA", "POST", "/chat", { task: "hi" })).status).not.toBe(429);
    await call("owner", "PUT", `/saas/tenants/${a}`, { quotas: { monthlyRequests: 1000 } }); await call("owner", "PUT", `/saas/tenants/${b}`, { quotas: { monthlyRequests: 1000 } });
  });
  it("owner can see (without secrets) and reset a tenant's connection", async () => {
    const a = (await call("owner", "GET", "/saas/tenants")).data.find((t: any) => t.name === "Tenant a").id;
    const v = await call("owner", "GET", `/saas/tenants/${a}/llm`); expect(v.data.connections).toHaveLength(1); expect(JSON.stringify(v.json)).not.toContain("tenant-a-secret-key");
    expect((await call("adminA", "DELETE", `/saas/tenants/${a}/llm/task`)).status).toBe(403);
  });
});

describe("chat uses the tenant's connection end to end", () => {
  it("a /chat run as tenant A reaches A's provider with A's key and model, and B's run never does", async () => {
    expect((await call("adminA", "POST", "/projects", { name: "pa" })).status).toBeLessThan(300);
    expect((await call("adminA", "PUT", "/llm/connections/chat", custom())).status).toBe(200); // chat and task are separate slots
    providerCalls.length = 0;
    const r = await call("adminA", "POST", "/chat", { task: "say hi", engine: "assistant", model: "acme-custom-pick" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(providerCalls.length).toBeGreaterThan(0);
    expect(providerCalls.every((c) => c.auth === "Bearer tenant-a-secret-key" && c.model === "acme-custom-pick")).toBe(true);
    const list = (await call("owner", "GET", "/saas/tenants")).data; const u = list.find((t: any) => t.name === "Tenant a")?.usage; expect(u, JSON.stringify(list.map((t: any) => t.name))).toBeDefined();
    expect(u.tokens).toBeGreaterThan(0); // usage recorded even though the platform allowance does not apply
  });
});

describe("AGI connection", () => {
  it("a tenant without a dedicated AGI instance cannot use or configure AGI", async () => {
    expect((await call("adminB", "GET", "/agi/status")).status).toBe(403);
    expect((await call("adminB", "PUT", "/llm/connections/agi", custom())).status).toBe(409);
    expect((await call("adminB", "GET", "/llm/connections")).data.effective.agi.available).toBe(false);
  });
  it("only the owner can attach a dedicated instance; the token is never exposed", async () => {
    const a = (await call("owner", "GET", "/saas/tenants")).data.find((t: any) => t.name === "Tenant a").id;
    expect((await call("adminA", "PUT", `/saas/tenants/${a}/agi`, { url: `http://127.0.0.1:${agiPortA}`, token: "x".repeat(20) })).status).toBe(403);
    const r = await call("owner", "PUT", `/saas/tenants/${a}/agi`, { url: `http://127.0.0.1:${agiPortA}`, token: "dedicated-agi-token-1234" });
    expect(r.status).toBe(200); expect(JSON.stringify(r.json)).not.toContain("dedicated-agi-token");
    expect(JSON.stringify((await call("owner", "GET", "/saas/tenants")).json)).not.toContain('"ct"');
    expect((await call("adminA", "PUT", "/tenant/features", { features: { agi: false } })).status).toBe(403);
  });
  it("the tenant's AGI connection is pushed to ITS instance with ITS key and the instance token", async () => {
    expect((await call("adminA", "PUT", "/llm/connections/agi", { ...custom(), tier_models: { hard: "acme-xl" } })).status).toBe(200);
    agiPushes.length = 0;
    const s = await call("adminA", "GET", "/agi/status"); expect(s.status).toBe(200);
    expect(agiPushes).toHaveLength(1);
    expect(agiPushes[0].auth).toBe("Bearer dedicated-agi-token-1234");
    expect(agiPushes[0].body).toMatchObject({ mode: "openai", baseUrl: `http://127.0.0.1:${provPort}/v1`, apiKey: "tenant-a-secret-key", models: { easy: "acme-large", medium: "acme-large", hard: "acme-xl" } });
    // already in sync: no second push
    await call("adminA", "GET", "/agi/status"); expect(agiPushes).toHaveLength(1);
  });
  it("tenant B and the platform instance never receive tenant A's key", async () => {
    agiPushes.length = 0;
    await call("adminB", "GET", "/agi/status"); await call("owner", "GET", "/agi/status");
    expect(JSON.stringify(agiPushes)).not.toContain("tenant-a-secret-key");
  });
  it("tenant admins run their own instance's admin controls; B cannot reach A's", async () => {
    expect((await call("adminA", "GET", "/agi/schedule")).status).not.toBe(403);
    expect((await call("userA", "PUT", "/agi/schedule", { enabled: true })).status).toBe(403);
    expect((await call("adminB", "GET", "/agi/schedule")).status).toBe(403);
  });
});

describe("tenant summaries", () => {
  it("carry quota, usage and user counts (and no secrets) for the admin console", async () => {
    const t = (await call("owner", "GET", "/saas/tenants")).data[0];
    expect(t.quota.maxUsers).toBeGreaterThan(0); expect(typeof t.usage.tokens).toBe("number"); expect(typeof t.users).toBe("number");
  });
});
