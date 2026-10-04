import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_DIR } from "./config";
import { publish } from "./telemetry";

export class KillSwitch {
  private f = path.join(AGENT_DIR, "KILL");
  engaged() { return fs.existsSync(this.f); }
  engage() { fs.writeFileSync(this.f, String(Date.now())); publish("kill", { engaged: true }); }
  reset() { fs.rmSync(this.f, { force: true }); publish("kill", { engaged: false }); }
}

export interface ApprovalReq { id: string; runId: string; tool: string; args: any; reason: string; prediction: any; createdAt: number }

/** Human-in-the-loop gate. Pending requests auto-deny after 5 minutes. */
export class Approvals {
  private pend = new Map<string, { req: ApprovalReq; resolve: (ok: boolean) => void }>();
  request(r: Omit<ApprovalReq, "id" | "createdAt">): Promise<boolean> {
    const req: ApprovalReq = { ...r, id: randomUUID().slice(0, 8), createdAt: Date.now() };
    return new Promise((resolve) => {
      const done = (ok: boolean) => { this.pend.delete(req.id); publish("approval", { status: ok ? "approved" : "denied", id: req.id }); resolve(ok); };
      this.pend.set(req.id, { req, resolve: done });
      publish("approval", { status: "pending", ...req });
      setTimeout(() => this.pend.has(req.id) && done(false), 300_000).unref();
    });
  }
  list() { return [...this.pend.values()].map((p) => p.req); }
  decide(id: string, ok: boolean) { const p = this.pend.get(id); if (!p) return false; p.resolve(ok); return true; }
}
