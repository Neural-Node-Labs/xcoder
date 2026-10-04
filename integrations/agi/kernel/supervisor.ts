/**
 * KERNEL: the only process that can promote or roll back an agent release.
 * Runs as root inside the container, launches the agent as an unprivileged user, and owns /data/control.
 * The agent can only *request* promotion by writing /data/agent/promote.json.
 */
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR, CONTROL_DIR, PORT } from "../src/config";
import { DEFAULT_GENOME, validateGenome } from "../src/genome";

const REL = path.join(CONTROL_DIR, "releases");
const RES = path.join(CONTROL_DIR, "results");
const CUR = path.join(CONTROL_DIR, "current");
const STABLE = path.join(CONTROL_DIR, "stable");
const PROBATION_MS = Number(process.env.PROBATION_SECONDS || 90) * 1000;
const UID = process.env.AGENT_UID ? Number(process.env.AGENT_UID) : undefined;
const GID = process.env.AGENT_GID ? Number(process.env.AGENT_GID) : undefined;
const log = (...a: any[]) => console.log("[supervisor]", ...a);

function swap(link: string, target: string) {
  const tmp = link + ".tmp";
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link); // atomic
}
const readLink = (l: string) => path.basename(fs.readlinkSync(l));

function bootstrap() {
  for (const d of [REL, RES, AGENT_DIR]) fs.mkdirSync(d, { recursive: true });
  if (UID !== undefined && process.getuid?.() === 0) fs.chownSync(AGENT_DIR, UID, GID ?? UID);
  if (!fs.existsSync(CUR)) {
    const v1 = path.join(REL, DEFAULT_GENOME.version);
    fs.mkdirSync(v1, { recursive: true });
    fs.writeFileSync(path.join(v1, "genome.json"), JSON.stringify(DEFAULT_GENOME, null, 2), { mode: 0o444 });
    swap(CUR, v1); swap(STABLE, v1);
  }
  fs.chmodSync(CONTROL_DIR, 0o755);
}

let child: ChildProcess | null = null;
let exitCount: number[] = [];
let stopping = false;
let lastExit: (() => void) | null = null;

function start(probation: boolean) {
  const release = readLink(CUR);
  log(`starting agent release=${release} probation=${probation}`);
  child = spawn("node", [path.join(__dirname, "..", "src", "server.js")], {
    stdio: "inherit", uid: UID, gid: GID,
    env: { ...process.env, RELEASE: release, PROBATION: probation ? "1" : "0" },
  });
  child.on("exit", (code, sig) => {
    log(`agent exited code=${code} signal=${sig}`);
    child = null;
    if (lastExit) { lastExit(); return; }
    if (stopping) return;
    exitCount = [...exitCount.filter((t) => Date.now() - t < 60_000), Date.now()];
    if (exitCount.length >= 3 && readLink(CUR) !== readLink(STABLE)) { rollback("crash loop"); return; }
    setTimeout(() => !child && !stopping && start(false), 2000);
  });
}

function stopChild(): Promise<void> {
  return new Promise((res) => {
    if (!child) return res();
    const c = child;
    lastExit = () => { lastExit = null; res(); };
    c.kill("SIGTERM");
    setTimeout(() => c.kill("SIGKILL"), 5000).unref();
  });
}

async function health(): Promise<any | null> {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; }
}

function result(id: string, status: string, reason = "") {
  fs.writeFileSync(path.join(RES, `${id}.json`), JSON.stringify({ id, status, reason, at: Date.now() }), { mode: 0o644 });
}

async function rollback(reason: string) {
  const bad = readLink(CUR), good = readLink(STABLE);
  log(`ROLLBACK ${bad} -> ${good}: ${reason}`);
  await stopChild();
  swap(CUR, path.join(REL, good));
  if (bad !== good) result(bad, "rolled_back", reason);
  exitCount = [];
  start(false);
}

let busy = false;
async function handlePromotion(id: string) {
  busy = true;
  try {
    const src = path.join(AGENT_DIR, "releases", id, "genome.json");
    if (!/^v\d{4}$/.test(id) || !fs.existsSync(src)) return result(id, "rejected", "bad request");
    const g = JSON.parse(fs.readFileSync(src, "utf8"));
    const err = validateGenome(g);
    if (err || g.version !== id) return result(id, "rejected", err ?? "version mismatch");
    const dst = path.join(REL, id);
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, "genome.json"), JSON.stringify(g, null, 2), { mode: 0o444 }); // re-serialised copy, root-owned
    log(`promoting ${id}`);
    await stopChild();
    swap(CUR, dst);
    start(true);
    const t0 = Date.now();
    while (Date.now() - t0 < PROBATION_MS) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!child) return; // exit handler / crash loop will roll back
      const h = await health();
      if (h?.release === id && h.probation === "pass") {
        swap(STABLE, dst); result(id, "promoted"); log(`${id} is now stable`); return;
      }
      if (h?.probation === "fail") return rollback("probation smoke evals failed");
    }
    await rollback("probation timeout");
  } catch (e) { log("promotion error", e); await rollback(String(e)); }
  finally { busy = false; }
}

async function main() {
  bootstrap();
  start(false);
  const req = path.join(AGENT_DIR, "promote.json");
  setInterval(() => {
    if (busy || !fs.existsSync(req)) return;
    try { const { id } = JSON.parse(fs.readFileSync(req, "utf8")); fs.rmSync(req, { force: true }); void handlePromotion(String(id)); }
    catch { fs.rmSync(req, { force: true }); }
  }, 2000);
  let misses = 0;
  setInterval(async () => {
    if (busy || !child) return;
    misses = (await health()) ? 0 : misses + 1;
    if (misses >= 6) { log("agent unresponsive, restarting"); misses = 0; await stopChild(); start(false); }
  }, 5000);
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, async () => { stopping = true; await stopChild(); process.exit(0); });
}
void main();
