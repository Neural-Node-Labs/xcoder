// Sandbox exec server. Runs INSIDE the isolated sandbox container (no internet, read-only rootfs,
// no capabilities, tmpfs workspace). The agent never executes commands in its own container.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = process.env.WORK_ROOT || "/work";
const TOKEN = process.env.SANDBOX_TOKEN || "";
const MAX_OUT = 64 * 1024;

function dir(session) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(session || "")) throw new Error("bad session id");
  const d = path.join(ROOT, session);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function safe(d, p) {
  const full = path.resolve(d, String(p));
  if (full !== d && !full.startsWith(d + path.sep)) throw new Error("path escapes workspace");
  return full;
}
function exec(session, cmd, timeoutMs) {
  return new Promise((resolve) => {
    const cwd = dir(session);
    const child = spawn("bash", ["-c", String(cmd)], {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8", TERM: "dumb" },
    });
    let out = "", err = "", timedOut = false;
    child.stdout.on("data", (d) => { out = (out + d).slice(0, MAX_OUT); });
    child.stderr.on("data", (d) => { err = (err + d).slice(0, MAX_OUT); });
    const t = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, Math.min(Number(timeoutMs) || 30000, 120000));
    child.on("close", (code) => { clearTimeout(t); resolve({ code: code === null ? -1 : code, stdout: out, stderr: err, timedOut }); });
  });
}

const routes = {
  "/exec": async (b) => exec(b.session, b.cmd, b.timeoutMs),
  "/put": async (b) => {
    const f = safe(dir(b.session), b.path);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(b.content ?? ""));
    return { ok: true };
  },
  "/read": async (b) => ({ content: fs.readFileSync(safe(dir(b.session), b.path), "utf8").slice(0, 200000) }),
  "/reset": async (b) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(b.session || "")) throw new Error("bad session id");
    fs.rmSync(path.join(ROOT, b.session), { recursive: true, force: true });
    return { ok: true };
  },
};

http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.url === "/healthz") return send(200, { ok: true });
  if (req.headers["x-sandbox-token"] !== TOKEN) return send(401, { error: "unauthorized" });
  const h = routes[req.url];
  if (req.method !== "POST" || !h) return send(404, { error: "not found" });
  let body = "";
  req.on("data", (d) => { body += d; if (body.length > 2e6) req.destroy(); });
  req.on("end", async () => {
    try { send(200, await h(JSON.parse(body || "{}"))); }
    catch (e) { send(400, { error: String(e.message || e) }); }
  });
}).listen(9000, "0.0.0.0", () => console.log("sandbox listening on :9000"));
