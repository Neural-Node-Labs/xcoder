import { SANDBOX_TOKEN, SANDBOX_URL } from "./config";

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }

/** All command execution happens in the sandbox container, never in the agent process. */
export class Sandbox {
  constructor(private url = SANDBOX_URL, private token = SANDBOX_TOKEN) {}
  private async post(path: string, body: any): Promise<any> {
    const r = await fetch(this.url + path, {
      method: "POST", headers: { "content-type": "application/json", "x-sandbox-token": this.token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(150_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`sandbox ${path}: ${j.error ?? r.status}`);
    return j;
  }
  exec(session: string, cmd: string, timeoutMs = 30_000): Promise<ExecResult> { return this.post("/exec", { session, cmd, timeoutMs }); }
  async put(session: string, path: string, content: string) { await this.post("/put", { session, path, content }); }
  async read(session: string, path: string): Promise<string> { return (await this.post("/read", { session, path })).content; }
  async reset(session: string) { await this.post("/reset", { session }); }
  async healthy(): Promise<boolean> {
    try { return (await fetch(this.url + "/healthz", { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
  }
}
