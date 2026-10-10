import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-saas-"));
vi.stubEnv("XCODER_SAAS_MODE", "true");
vi.stubEnv("XCODER_SAAS_DATA_DIR", path.join(tmp, "saas"));
vi.stubEnv("XCODER_USERS_STORE", path.join(tmp, "users.json"));
vi.stubEnv("XCODER_PROJECTS_STORE", path.join(tmp, "projects.json"));
vi.stubEnv("XCODER_PROJECTS_ROOT", path.join(tmp, "ws"));

let server: Server, base = "";
const tok: Record<string, string> = {};
async function call(who: string | null, method: string, url: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${tok[who]}` } : {}) }, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) });
  let json: any = null; try { json = await r.json(); } catch { /* none */ }
  return { status: r.status, json, data: json?.data };
}
async function login(name: string, username: string, password: string) { const r = await call(null, "POST", "/login", { username, password }); expect(r.status).toBe(200); tok[name] = r.data.token; }

beforeAll(async () => {
  const { createRouter } = await import("../../api/routes.js");
  const app = express(); app.use(express.json()); app.use("/api/v1", createRouter());
  await new Promise<void>((res) => { server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`; res(); }); });

  const reg = await call(null, "POST", "/register", { username: "owner", password: "ownerpass1" });
  expect(reg.status).toBe(201); expect(reg.data.role).toBe("saas_owner"); tok.owner = reg.data.token;
  for (const [n, name] of [["a", "Acme Corp"], ["b", "Beta Inc"]] as const) {
    const t = await call("owner", "POST", "/saas/tenants", { name, plan: "pro", adminUsername: `admin_${n}`, adminPassword: "password-" + n });
    expect(t.status).toBe(201);
  }
  await login("adminA", "admin_a", "password-a"); await login("adminB", "admin_b", "password-b");
  const u = await call("adminA", "POST", "/tenant/users", { username: "user_a", password: "password-ua" }); expect(u.status).toBe(201);
  await login("userA", "user_a", "password-ua");
  const ops = await call("owner", "POST", "/saas/staff", { username: "ops1", password: "opspass-1", role: "saas_ops" }); expect(ops.status).toBe(201);
  await login("ops", "ops1", "opspass-1");
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("roles", () => {
  it("closes public registration once the owner exists", async () => { expect((await call(null, "POST", "/register", { username: "x", password: "xxxxxxxx" })).status).toBe(403); });
  it("tenant admin/user cannot reach any platform surface", async () => {
    for (const who of ["adminA", "userA"]) for (const [m, u] of [["GET", "/saas/tenants"], ["POST", "/saas/tenants"], ["GET", "/users"], ["GET", "/telemetry"], ["GET", "/audit-log"], ["PUT", "/settings/llm-key"], ["GET", "/saas/staff"], ["GET", "/platform/cache"]]) {
      const r = await call(who, m, u, {}); expect([401, 403], `${who} ${m} ${u} -> ${r.status}`).toContain(r.status);
    }
  });
  it("tenant user cannot administer the tenant", async () => {
    for (const [m, u] of [["GET", "/tenant/users"], ["POST", "/tenant/users"], ["PUT", "/tenant/features"], ["GET", "/tenant/audit-log"]]) expect((await call("userA", m, u, {})).status).toBe(403);
    expect((await call("userA", "GET", "/tenant")).status).toBe(200);
  });
  it("SaaS owner and ops cannot read tenant content", async () => {
    for (const who of ["owner", "ops"]) for (const u of ["/crm/contacts", "/projects", "/task-history", "/workspace/files"]) { const r = await call(who, "GET", u); expect(r.status, `${who} ${u}`).toBe(403); }
    expect((await call("owner", "POST", "/chat", { task: "hi" })).status).toBe(403);
  });
  it("ops can view and suspend but not create, change plans, delete or toggle platform features", async () => {
    expect((await call("ops", "GET", "/saas/tenants")).status).toBe(200);
    expect((await call("ops", "POST", "/saas/tenants", { name: "Z", adminUsername: "zzz", adminPassword: "zzzzzzzz" })).status).toBe(403);
    expect((await call("ops", "PUT", "/saas/features/crm", { enabled: false })).status).toBe(403);
    expect((await call("ops", "GET", "/saas/staff")).status).toBe(403);
  });
});

describe("tenant data isolation (CRM)", () => {
  let contactA = "", companyA = "";
  it("tenant A writes, tenant B sees nothing", async () => {
    const co = await call("adminA", "POST", "/crm/companies", { name: "Globex" }); expect(co.status).toBe(201); companyA = co.data.id;
    const c = await call("userA", "POST", "/crm/contacts", { name: "Ann", email: "ann@a.test", companyId: companyA, id: "evil", createdBy: "x" });
    expect(c.status).toBe(201); contactA = c.data.id; expect(c.data.id).not.toBe("evil"); expect(c.data.createdBy).not.toBe("x");
    expect((await call("adminB", "GET", "/crm/contacts")).data).toEqual([]);
    expect((await call("adminB", "GET", `/crm/contacts/${contactA}`)).status).toBe(404);
    expect((await call("adminB", "PUT", `/crm/contacts/${contactA}`, { name: "pwn" })).status).toBe(404);
    expect((await call("adminB", "DELETE", `/crm/contacts/${contactA}`)).status).toBe(404);
    expect((await call("adminB", "GET", "/crm/contacts?search=ann")).data).toEqual([]);
    expect((await call("adminA", "GET", "/crm/contacts")).data).toHaveLength(1);
  });
  it("tenant B cannot reference tenant A's records", async () => {
    const r = await call("adminB", "POST", "/crm/contacts", { name: "Bob", companyId: companyA }); expect(r.status).toBe(400);
    const d = await call("adminB", "POST", "/crm/deals", { title: "x", contactId: contactA }); expect(d.status).toBe(400);
  });
  it("validates input and rejects unknown collections", async () => {
    expect((await call("adminA", "POST", "/crm/deals", { title: "d", stage: "bogus" })).status).toBe(400);
    expect((await call("adminA", "POST", "/crm/contacts", { name: "n", email: "nope" })).status).toBe(400);
    expect((await call("adminA", "GET", "/crm/..%2f..%2fusers")).status).toBe(404);
  });
  it("pipeline summary is per tenant", async () => {
    await call("adminA", "POST", "/crm/deals", { title: "Big", value: 1000, stage: "won" });
    expect((await call("adminA", "GET", "/crm/summary")).data.wonValue).toBe(1000);
    expect((await call("adminB", "GET", "/crm/summary")).data.wonValue).toBe(0);
  });
});

describe("tenant user management isolation", () => {
  it("a tenant admin cannot see or edit another tenant's users", async () => {
    const bUsers = (await call("adminB", "GET", "/tenant/users")).data.map((u: any) => u.username);
    expect(bUsers).toEqual(["admin_b"]);
    const ua = (await call("adminA", "GET", "/tenant/users")).data.find((u: any) => u.username === "user_a");
    expect((await call("adminB", "PUT", `/tenant/users/${ua.id}`, { role: "tenant_admin" })).status).toBe(404);
    expect((await call("adminB", "DELETE", `/tenant/users/${ua.id}`)).status).toBe(404);
  });
  it("cannot create a privileged staff role through tenant endpoints", async () => {
    const r = await call("adminA", "POST", "/tenant/users", { username: "sneaky", password: "password-s", role: "saas_owner" });
    expect(r.status).toBe(201); expect(r.data.role).toBe("tenant_user");
  });
  it("keeps at least one tenant admin and blocks self-delete", async () => {
    const me = (await call("adminB", "GET", "/tenant/users")).data[0];
    expect((await call("adminB", "DELETE", `/tenant/users/${me.id}`)).status).toBe(409);
    expect((await call("adminB", "PUT", `/tenant/users/${me.id}`, { role: "tenant_user" })).status).toBe(409);
  });
  it("tenant audit logs are separate", async () => {
    const a = (await call("adminA", "GET", "/tenant/audit-log")).data.entries, b = (await call("adminB", "GET", "/tenant/audit-log")).data.entries;
    expect(a.every((e: any) => e.tenantId.startsWith("acme"))).toBe(true);
    expect(b.some((e: any) => e.summary.includes("user_a"))).toBe(false);
  });
});

describe("feature switches", () => {
  it("tenant admin can switch a non-sensitive module off and on for their own tenant only", async () => {
    expect((await call("adminA", "PUT", "/tenant/features", { features: { crm: false } })).status).toBe(200);
    expect((await call("adminA", "GET", "/crm/contacts")).status).toBe(403);
    expect((await call("userA", "GET", "/crm/contacts")).status).toBe(403);
    expect((await call("adminB", "GET", "/crm/contacts")).status).toBe(200);
    expect((await call("adminA", "PUT", "/tenant/features", { features: { crm: true } })).status).toBe(200);
    expect((await call("adminA", "GET", "/crm/contacts")).status).toBe(200);
  });
  it("tenant admin cannot enable sensitive features, platform features or unknown ones", async () => {
    for (const f of ["shell_tools", "network_tools", "security_ops", "agi", "codegraph", "mcp_tools", "nope"]) expect((await call("adminA", "PUT", "/tenant/features", { features: { [f]: true } })).status, f).toBe(403);
  });
  it("tool and platform-only features are refused to tenants", async () => {
    for (const u of ["/agi/status", "/security-ops/allowlist", "/platform/integrations/codegraph/status"]) expect((await call("adminA", "GET", u)).status, u).toBe(403);
  });
  it("platform switch disables a module for everyone; env lock is honoured", async () => {
    expect((await call("owner", "PUT", "/saas/features/crm", { enabled: false })).status).toBe(200);
    expect((await call("adminB", "GET", "/crm/contacts")).status).toBe(403);
    expect((await call("owner", "PUT", "/saas/features/crm", { enabled: true })).status).toBe(200);
    expect((await call("adminB", "GET", "/crm/contacts")).status).toBe(200);
    vi.stubEnv("XCODER_FEATURE_CRM", "off");
    expect((await call("adminB", "GET", "/crm/contacts")).status).toBe(403);
    expect((await call("owner", "PUT", "/saas/features/crm", { enabled: true })).status).toBe(409);
    vi.stubEnv("XCODER_FEATURE_CRM", "");
  });
  it("owner can grant a sensitive feature to one tenant, and only that tenant", async () => {
    const tid = (await call("owner", "GET", "/saas/tenants")).data.find((t: any) => t.name === "Beta Inc").id;
    expect((await call("owner", "PUT", `/saas/tenants/${tid}`, { features: { network_tools: true } })).status).toBe(200);
    const t = (await call("owner", "GET", `/saas/tenants/${tid}`)).data;
    expect(t.effectiveFeatures).toContain("network_tools");
    const ta = (await call("owner", "GET", "/saas/tenants")).data.find((x: any) => x.name === "Acme Corp");
    expect(ta.effectiveFeatures).not.toContain("network_tools");
  });
});

describe("tool dispatch honours the tenant context", () => {
  it("denies shell tools without the feature, and fails closed without any context", async () => {
    const { dispatchToolCall } = await import("../../tools/toolDispatcher.js");
    const { runWithTenant } = await import("../context.js");
    const call1 = { id: "1", type: "function", function: { name: "run_command_tool", arguments: JSON.stringify({ command: "echo hi" }) } } as any;
    const off = await runWithTenant({ tenantId: "acme", userId: "1", role: "tenant_user", features: new Set(["crm"]) }, () => dispatchToolCall(call1, tmp));
    expect(off.isError).toBe(true); expect(String(off.observation.error)).toMatch(/disabled for this tenant/);
    const none = await dispatchToolCall(call1, tmp);
    expect(none.isError).toBe(true); expect(String(none.observation.error)).toMatch(/tenant-scoped/);
  });
});

describe("lifecycle", () => {
  it("quota stops chat before any work happens", async () => {
    const tid = (await call("owner", "GET", "/saas/tenants")).data.find((t: any) => t.name === "Acme Corp").id;
    await call("owner", "PUT", `/saas/tenants/${tid}`, { quotas: { monthlyRequests: 0 } });
    const r = await call("userA", "POST", "/chat", { task: "hello" }); expect(r.status).toBe(429); expect(r.json.quota).toBe(true);
    await call("owner", "PUT", `/saas/tenants/${tid}`, { quotas: { monthlyRequests: 1000 } });
  });
  it("seat limit is enforced", async () => {
    const tid = (await call("owner", "GET", "/saas/tenants")).data.find((t: any) => t.name === "Acme Corp").id;
    await call("owner", "PUT", `/saas/tenants/${tid}`, { quotas: { maxUsers: 1 } });
    expect((await call("adminA", "POST", "/tenant/users", { username: "extra1", password: "password-x" })).status).toBe(402);
  });
  it("suspending a tenant kills live sessions immediately; reactivating restores access", async () => {
    const tid = (await call("owner", "GET", "/saas/tenants")).data.find((t: any) => t.name === "Beta Inc").id;
    expect((await call("ops", "POST", `/saas/tenants/${tid}/suspend`, { reason: "non-payment" })).status).toBe(200);
    expect((await call("adminB", "GET", "/crm/contacts")).status).toBe(403);
    const lg = await call(null, "POST", "/login", { username: "admin_b", password: "password-b" });
    expect(lg.status === 200 ? (await (async () => { tok.b2 = lg.data.token; return call("b2", "GET", "/tenant"); })()).status : 403).toBe(403);
    expect((await call("ops", "POST", `/saas/tenants/${tid}/reactivate`)).status).toBe(200);
    await login("adminB", "admin_b", "password-b");
    expect((await call("adminB", "GET", "/crm/contacts")).status).toBe(200);
  });
  it("deleting a tenant disables its accounts; only the owner may", async () => {
    const created = await call("owner", "POST", "/saas/tenants", { name: "Gone LLC", adminUsername: "admin_gone", adminPassword: "password-g" });
    await login("gone", "admin_gone", "password-g");
    expect((await call("ops", "DELETE", `/saas/tenants/${created.data.id}`)).status).toBe(403);
    expect((await call("owner", "DELETE", `/saas/tenants/${created.data.id}`)).status).toBe(200);
    expect((await call("gone", "GET", "/tenant")).status).toBe(403);
    expect((await call(null, "POST", "/login", { username: "admin_gone", password: "password-g" })).status).toBe(401);
  });
  it("the last SaaS owner cannot be removed", async () => {
    const owner = (await call("owner", "GET", "/saas/staff")).data.find((s: any) => s.username === "owner");
    expect((await call("owner", "DELETE", `/saas/staff/${owner.id}`)).status).toBe(409);
    expect((await call("owner", "PUT", `/saas/staff/${owner.id}`, { role: "saas_ops" })).status).toBe(409);
  });
});

describe("hardening helpers", () => {
  it("workspace confinement is on in SaaS mode and is symlink-safe", async () => {
    const { resolveConfinedPath } = await import("../../tools/workspaceConfinement.js");
    const root = fs.mkdtempSync(path.join(tmp, "root-")), outside = fs.mkdtempSync(path.join(tmp, "out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    fs.symlinkSync(outside, path.join(root, "link"));
    expect(() => resolveConfinedPath("../x", root)).toThrow();
    expect(() => resolveConfinedPath("link/secret.txt", root)).toThrow();
    expect(() => resolveConfinedPath("link/new.txt", root)).toThrow();
    expect(resolveConfinedPath("ok/new.txt", root)).toContain(root);
  });
  it("scrubEnv keeps only allowlisted variables", async () => {
    const { scrubEnv } = await import("../../tools/runCommandTool.js");
    expect(scrubEnv({ PATH: "/bin", DATABASE_URL: "x", DEEPSEEK_API_KEY: "y", HOME: "/h" })).toEqual({ PATH: "/bin", HOME: "/h" });
  });
  it("DB-backed routes are tenant-scoped (see tenantStores.test.ts); task logs by id stay off", async () => {
    for (const u of ["/plans", "/wbs", "/phase-reports"]) expect((await call("adminA", "GET", u)).status).not.toBe(501);
    expect((await call("adminA", "GET", "/task-history/sdlc-abc/logs")).status).toBe(501);
  });
});
