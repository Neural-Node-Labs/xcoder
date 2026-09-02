import { Client } from "ssh2";
import { RemoteTarget } from "./types.js";
import { verifyHostKeyTofu } from "./hostKeyStore.js";

/** Parses "host" or "host:port" into a target (default port 22). */
export function parseTarget(raw: string): RemoteTarget {
  const trimmed = raw.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return { host: trimmed, port: 22 };
  const host = trimmed.slice(0, lastColon);
  const portStr = trimmed.slice(lastColon + 1);
  const port = parseInt(portStr, 10);
  return { host, port: Number.isFinite(port) ? port : 22 };
}

/** Parses a comma-separated list of targets, e.g. "host1,host2:2222". */
export function parseTargets(raw: string): RemoteTarget[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseTarget);
}

export function connect(target: RemoteTarget, user: string, password: string, timeoutMs = 15000): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`Connection to ${target.host}:${target.port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    conn
      .on("ready", () => {
        clearTimeout(timer);
        resolve(conn);
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect({
        host: target.host,
        port: target.port,
        username: user,
        password,
        readyTimeout: timeoutMs,
        // Trust-on-first-use: kung walang tahasang hostVerifier, tinatanggap ng ssh2 ang
        // anumang host key para sa anumang host nang walang anumang babala. Itala ang
        // fingerprint sa unang koneksyon, at humingi ng tugma sa bawat koneksyon pagkatapos
        // nito. Tingnan ang src/remote/hostKeyStore.ts para sa detalye.
        hostHash: "sha256",
        hostVerifier: (fingerprintHex: string) => {
          const result = verifyHostKeyTofu(target.host, target.port, fingerprintHex);
          if (!result.accepted) {
            // Ipakita ang dahilan sa parehong landas na kukunin ng error sa koneksyon.
            queueMicrotask(() => conn.emit("error", new Error(result.reason)));
          }
          return result.accepted;
        },
      });
  });
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Runs a single command via SSH exec. */
export function execCommand(conn: Client, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream
        .on("close", (code: number) => resolve({ stdout, stderr, exitCode: code }))
        .on("data", (data: Buffer) => {
          stdout += data.toString();
        });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
    });
  });
}

/** Runs a multi-line script by piping it into `bash -s` over stdin. */
export function execScript(conn: Client, script: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    conn.exec("bash -s", (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream
        .on("close", (code: number) => resolve({ stdout, stderr, exitCode: code }))
        .on("data", (data: Buffer) => {
          stdout += data.toString();
        });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      stream.end(script);
    });
  });
}

