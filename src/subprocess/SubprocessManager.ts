import { fork, ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accessSync } from "node:fs";

// ─── Mga Uri (Types) ────────────────────────────────────────────────────────────────

export interface SubprocessOptions {
  /** Pinakamataas na wall-clock time (ms) bago patayin ang proseso. Default: 30_000 (30s). */
  timeoutMs?: number;
  /** Agwat (ms) sa pagitan ng inaasahang heartbeat ping mula sa worker. Default: 2_000 (2s). */
  heartbeatIntervalMs?: number;
  /** Ilang nakaligtaang heartbeat interval bago ituring na hung ang proseso. Default: 2. */
  heartbeatMissedLimit?: number;
  /** Mga argumentong ipinapasa sa worker sa pamamagitan ng IPC message. */
  workerData?: unknown;
}

export interface SubprocessResult {
  /** Ang huling output ng worker (stdout o resulta ng IPC). */
  result: unknown;
  /** Exit code ng proseso. */
  exitCode: number | null;
  /** True kung pinatay ang proseso dahil sa timeout. */
  timedOut: boolean;
  /** True kung lumabas ang proseso na may non-zero code o pinatay ng isang signal. */
  crashed: boolean;
  /** Ang signal na pumatay sa proseso, kung mayroon. */
  signal?: string;
  /** Mensahe ng error kung nag-crash o nag-timeout ang proseso. */
  error?: string;
  /** stderr output na nakuha mula sa proseso. */
  stderr: string;
}

// ─── Mga Default ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_MISSED_LIMIT = 2;

// ─── SubprocessManager ────────────────────────────────────────────────────────────

/**
 * Namamahala ng isang child process (fina-fork sa pamamagitan ng `child_process.fork()`) na may:
 * - Naka-configure na timeout (SIGTERM → SIGKILL na pag-eskalada)
 * - Pagbabantay sa exit-code (non-zero = crash)
 * - Mekanismo ng heartbeat (pana-panahong IPC ping mula sa worker)
 * - Cleanup sa timeout/crash
 *
 * Nagbabalik ng isang `SubprocessResult` object na naglalaman ng resulta.
 *
 * @example
 * ```ts
 * const manager = new SubprocessManager();
 * const result = await manager.spawn(workerPath, {
 *   timeoutMs: 15_000,
 *   workerData: { task: "do something" },
 * });
 * if (result.crashed) {
 *   console.error("Worker crashed:", result.error);
 * }
 * ```
 */
export class SubprocessManager {
  /**
   * Mag-spawn ng worker script sa isang child process at hintayin itong matapos.
   *
   * @param workerModulePath - Absolute path patungo sa worker module (`.js` o `.ts`).
   *   Dapat mag-export ang module ng default function o makinig sa mga IPC message.
   * @param options - Konpigurasyon para sa timeout, heartbeat, at worker data.
   * @returns Isang `SubprocessResult` na naglalarawan sa resulta.
   */
  async spawn(
    workerModulePath: string,
    options: SubprocessOptions = {}
  ): Promise<SubprocessResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const heartbeatMissedLimit = options.heartbeatMissedLimit ?? DEFAULT_HEARTBEAT_MISSED_LIMIT;

    // ── I-fork ang child process ─────────────────────────────────────────────────
    const child: ChildProcess = fork(workerModulePath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, XCODER_SUBAGENT: "1" },
    });

    // ── Estado (State) ─────────────────────────────────────────────────────────────
    let settled = false;
    let timedOut = false;
    let crashed = false;
    let exitCode: number | null = null;
    let signal: string | undefined;
    let result: unknown = undefined;
    let error: string | undefined;
    let stderr = "";

    // Pagsubaybay sa heartbeat
    let lastHeartbeat = Date.now();
    let heartbeatCheckTimer: ReturnType<typeof setInterval> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    // ── Promise na naresolba kapag na-settle na ang proseso ──────────────────────
    const settlePromise = new Promise<SubprocessResult>((resolve) => {
      // ── Pagkuha ng stderr ───────────────────────────────────────────────────
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf-8");
        });
      }

      // ── Paghawak ng IPC message ─────────────────────────────────────────────
      child.on("message", (msg: unknown) => {
        const message = msg as Record<string, unknown>;

        if (message?.type === "heartbeat") {
          lastHeartbeat = Date.now();
          return; // huwag mag-settle sa heartbeat
        }

        if (message?.type === "result") {
          result = message.data;
          return; // hintayin ang exit bago mag-settle
        }

        if (message?.type === "error") {
          error = String(message.data ?? "Unknown worker error");
          return; // hintayin ang exit bago mag-settle
        }
      });

      // ── Paglabas ng proseso ─────────────────────────────────────────────────
      child.on("exit", (code, sig) => {
        exitCode = code;
        signal = sig ?? undefined;

        if (!settled) {
          settled = true;
          cleanup();

          if (code !== 0 || sig) {
            crashed = true;
            error = error || `Process exited with code ${code}${sig ? ` (signal: ${sig})` : ""}`;
          }

          resolve({
            result,
            exitCode,
            timedOut,
            crashed,
            signal,
            error,
            stderr,
          });
        }
      });

      // ── Error ng proseso (hal., hindi makapag-fork) ─────────────────────────
      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          crashed = true;
          error = `Failed to spawn worker: ${err.message}`;
          resolve({
            result,
            exitCode,
            timedOut,
            crashed,
            signal,
            error,
            stderr,
          });
        }
      });
    });

    // ── Cleanup function ──────────────────────────────────────────────────────
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (heartbeatCheckTimer) clearInterval(heartbeatCheckTimer);
      killTimer = undefined;
      heartbeatCheckTimer = undefined;
    };

    // ── Timeout: SIGTERM → SIGKILL na pag-eskalada ───────────────────────────────
    killTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      error = `Worker timed out after ${timeoutMs}ms`;

      // Ipadala muna ang SIGTERM
      try {
        child.kill("SIGTERM");
      } catch {
        // maaaring patay na ang proseso
      }

      // Kung buhay pa pagkatapos ng 3s, i-eskalada sa SIGKILL
      setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // maaaring patay na ang proseso
        }
      }, 3_000);
    }, timeoutMs);

    // ── Pagsubaybay sa heartbeat ──────────────────────────────────────────────
    heartbeatCheckTimer = setInterval(() => {
      if (settled) return;
      const elapsed = Date.now() - lastHeartbeat;
      if (elapsed > heartbeatIntervalMs * heartbeatMissedLimit) {
        // Sobrang dami ng nakaligtaang heartbeat — ituring na hung
        if (!settled) {
          timedOut = true;
          error = `Worker hung: no heartbeat for ${elapsed}ms (missed limit: ${heartbeatMissedLimit} intervals of ${heartbeatIntervalMs}ms)`;

          try {
            child.kill("SIGTERM");
          } catch {
            // maaaring patay na ang proseso
          }

          // I-eskalada sa SIGKILL pagkatapos ng 3s
          setTimeout(() => {
            if (settled) return;
            try {
              child.kill("SIGKILL");
            } catch {
              // maaaring patay na ang proseso
            }
          }, 3_000);
        }
      }
    }, heartbeatIntervalMs);

    // ── Ipadala ang worker data sa pamamagitan ng IPC ────────────────────────────
    if (options.workerData !== undefined) {
      child.send({ type: "start", data: options.workerData });
    }

    // ── Hintayin ang settlement ───────────────────────────────────────────────────
    return settlePromise;
  }

  /**
   * Patayin ang isang pinamamahalaang child process. Ligtas tawagin kahit natapos na ang proseso.
   */
  kill(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
    try {
      child.kill(signal);
    } catch {
      // maaaring patay na ang proseso
    }
  }
}

// ─── Convenience factory ──────────────────────────────────────────────────────────

let defaultManager: SubprocessManager | undefined;

/**
 * Kunin o gawin ang default na SubprocessManager singleton.
 */
export function getDefaultManager(): SubprocessManager {
  if (!defaultManager) {
    defaultManager = new SubprocessManager();
  }
  return defaultManager;
}

/**
 * Alamin ang path patungo sa isang worker module nang kaugnay sa source file na ito.
 * Hinahawakan ang parehong `.ts` (dev/ts-node) at `.js` (compiled) na extension.
 *
 * Sa dev mode (ts-node), direktang ginagamit ang `.ts` file.
 * Sa production, ginagamit ang na-compile na `.js` file.
 */
export function resolveWorkerPath(relativePath: string): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const resolved = path.resolve(__dirname, relativePath);

  // Suriin kung umiiral ang .ts file (dev mode)
  const tsPath = resolved.replace(/\.js$/, ".ts");
  if (resolved.endsWith(".js")) {
    // Subukan muna ang .ts (dev mode na may ts-node), bumalik sa .js (production)
    try {
      require("fs").accessSync(tsPath);
      return tsPath;
    } catch {
      return resolved;
    }
  }

  return resolved;
}

// I-import ang fs para sa resolveWorkerPath
