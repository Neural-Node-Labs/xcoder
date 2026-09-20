import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendAuditLog, readAuditLog } from "../auditLog.js";
import { resolveAuditLogJsonlPath } from "../../config/paths.js";

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-auditlog-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("appendAuditLog / readAuditLog", () => {
  it("returns an empty array when no audit log file exists yet", () => {
    expect(readAuditLog(cwd)).toEqual([]);
  });

  it("persists an entry to .agent/logs/audit.jsonl and reads it back", () => {
    const entry = appendAuditLog(cwd, {
      actorId: "1",
      actorUsername: "alice",
      action: "user.create",
      summary: "created local user 'bob' (user)",
      details: { userId: "2", username: "bob", role: "user" },
    });

    expect(entry.id).toMatch(/^audit_/);
    expect(entry.timestamp).toBeDefined();
    expect(fs.existsSync(resolveAuditLogJsonlPath(cwd))).toBe(true);

    const [readBack] = readAuditLog(cwd);
    expect(readBack).toEqual(entry);
  });

  it("returns entries newest-first regardless of insertion order", () => {
    appendAuditLog(cwd, { actorId: "1", actorUsername: "alice", action: "codegraph.start", summary: "started" });
    appendAuditLog(cwd, { actorId: "1", actorUsername: "alice", action: "codegraph.stop", summary: "stopped" });

    const entries = readAuditLog(cwd);
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("codegraph.stop"); // most recent first
    expect(entries[1].action).toBe("codegraph.start");
  });

  it("respects the limit passed to readAuditLog", () => {
    for (let i = 0; i < 5; i++) {
      appendAuditLog(cwd, { actorId: "1", actorUsername: "alice", action: "user.update", summary: `update ${i}` });
    }
    const entries = readAuditLog(cwd, 2);
    expect(entries).toHaveLength(2);
    // newest first: the last two appended, most recent first
    expect(entries[0].summary).toBe("update 4");
    expect(entries[1].summary).toBe("update 3");
  });

  it("caps on-disk growth at MAX_ENTRIES and drops the oldest entries first", () => {
    // MAX_ENTRIES is 5000 in the module — too slow to actually hit in a unit test by looping
    // one real appendAuditLog() call per entry (each call re-reads + rewrites the whole file).
    // Instead, seed the jsonl file directly with MAX_ENTRIES pre-existing entries, then append
    // one more through the real function and confirm the oldest entry was dropped.
    const MAX_ENTRIES = 5000;
    const p = resolveAuditLogJsonlPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const seeded = Array.from({ length: MAX_ENTRIES }, (_, i) => ({
      id: `audit_seed_${i}`,
      timestamp: new Date(2020, 0, 1, 0, 0, i).toISOString(),
      actorId: "1",
      actorUsername: "alice",
      action: "user.update",
      summary: `seed ${i}`,
    }));
    fs.writeFileSync(p, seeded.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    appendAuditLog(cwd, { actorId: "1", actorUsername: "alice", action: "user.update", summary: "overflow" });

    const entries = readAuditLog(cwd, MAX_ENTRIES + 10);
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0].summary).toBe("overflow"); // newest
    expect(entries.some((e) => e.summary === "seed 0")).toBe(false); // oldest dropped
    expect(entries.some((e) => e.summary === "seed 1")).toBe(true); // next-oldest survives
  });

  it("skips a corrupt line instead of failing the whole read", () => {
    const p = resolveAuditLogJsonlPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const good = { id: "audit_1", timestamp: new Date().toISOString(), actorId: "1", actorUsername: "alice", action: "user.update", summary: "ok" };
    fs.writeFileSync(p, `not valid json\n${JSON.stringify(good)}\n`, "utf-8");

    const entries = readAuditLog(cwd);
    expect(entries).toEqual([good]);
  });

  it("never persists a details field if the caller omits it (no accidental undefined leaking into JSON)", () => {
    appendAuditLog(cwd, { actorId: "1", actorUsername: "alice", action: "codegraph.start", summary: "started" });
    const raw = fs.readFileSync(resolveAuditLogJsonlPath(cwd), "utf-8").trim();
    const parsed = JSON.parse(raw);
    expect("details" in parsed).toBe(false);
  });
});
