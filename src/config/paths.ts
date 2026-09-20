import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Tanging pinagmumulan ng katotohanan para sa lahat ng system-generated na path sa loob ng
 * isang workspace (.agent/, kasama ang mga tasks, logs, index, at plans na subdirectory nito).
 *
 * BAKIT ITO UMIIRAL: dati, magkakahiwalay na file (protocol.ts, taskHistory.ts, logger.ts,
 * reactAuditor.ts, api/routes.ts, purge.ts, workspaceManager.ts) ay bawat isa ay nag-hard-code
 * ng sarili nitong bersyon ng mga path na ito, at nagkaiba-iba sila: bumubuo ang protocol.ts ng
 * isang top-level na `tasks/todo.md` habang bumubuo ang orchestrator.ts ng `.agent/tasks/` para
 * sa WBS/phase reports, at gumagawa ang logger.ts ng top-level na `.log/` habang ang
 * reactAuditor.ts naman ay umaasang mayroong `.log/` (hindi `.agent/logs/`). Ang resulta:
 * DALAWANG hiwalay na "tasks" na direktoryo at isang "system" na lugar na kalat sa tatlong
 * top-level na folder (`.agent/`, `.log/`, `tasks/`) sa halip na iisa.
 *
 * Ngayon, ang LAHAT ng system-generated na file ay nabubuhay sa ilalim ng `.agent/` -- walang
 * ibang code na dapat bumuo ng path patungo sa mga ito nang manu-mano; laging tumawag sa mga
 * function dito.
 */

export const AGENT_DIR_NAME = ".agent";
export const TASKS_SUBDIR = "tasks";
export const LOGS_SUBDIR = "logs";
export const INDEX_SUBDIR = "index";
export const PLANS_SUBDIR = "plans";
export const REPORTS_SUBDIR = "reports";

/** Ang root ng .agent para sa isang workspace. Lahat ng iba pang function dito ay nagsisimula rito. */
export function resolveAgentDir(projectRoot: string): string {
  return path.join(projectRoot, AGENT_DIR_NAME);
}

/** .agent/tasks -- todo.md, task_history.md/.jsonl, WBS at phase-planning reports. */
export function resolveTasksDir(projectRoot: string): string {
  return path.join(resolveAgentDir(projectRoot), TASKS_SUBDIR);
}

/** .agent/logs -- thinking.log, sys.log, at iba pang naka-rotate na telemetry log file. */
export function resolveLogsDir(projectRoot: string): string {
  return path.join(resolveAgentDir(projectRoot), LOGS_SUBDIR);
}

/** .agent/index -- ang naka-chunk na workspace content dump na ginagawa ng indexer.ts. */
export function resolveIndexDir(projectRoot: string): string {
  return path.join(resolveAgentDir(projectRoot), INDEX_SUBDIR);
}

/** .agent/plans -- naka-persist na plano mula sa save_plan_tool. */
export function resolvePlansDir(projectRoot: string): string {
  return path.join(resolveAgentDir(projectRoot), PLANS_SUBDIR);
}

/** .agent/reports -- mga crash report (crash-<timestamp>.md) mula sa processCrashHandler.ts. */
export function resolveReportsDir(projectRoot: string): string {
  return path.join(resolveAgentDir(projectRoot), REPORTS_SUBDIR);
}

// ─── Mga partikular na file sa loob ng .agent/tasks ────────────────────────────────
export function resolveTodoPath(projectRoot: string): string {
  return path.join(resolveTasksDir(projectRoot), "todo.md");
}
export function resolveTaskHistoryJsonlPath(projectRoot: string): string {
  return path.join(resolveTasksDir(projectRoot), "task-history.jsonl");
}
export function resolveTaskHistoryMarkdownPath(projectRoot: string): string {
  return path.join(resolveTasksDir(projectRoot), "task_history.md");
}

// ─── Mga partikular na file sa loob ng .agent/logs ──────────────────────────────────
export function resolveThinkingLogPath(projectRoot: string): string {
  return path.join(resolveLogsDir(projectRoot), "thinking.log");
}
export function resolveSysLogPath(projectRoot: string): string {
  return path.join(resolveLogsDir(projectRoot), "sys.log");
}
/** .agent/logs/audit.jsonl -- append-only platform admin-action audit trail (see auditLog.ts). */
export function resolveAuditLogJsonlPath(projectRoot: string): string {
  return path.join(resolveLogsDir(projectRoot), "audit.jsonl");
}

// ─── Iba pang file sa .agent root ───────────────────────────────────────────────────
export function resolveLessonsPath(projectRoot: string): string {
  return path.join(resolveAgentDir(projectRoot), "lessons.md");
}

/**
 * Tinitiyak na umiiral ang bawat isa sa apat na subdirectory ng .agent (tasks, logs, index,
 * plans) para sa isang project root. Ligtas at murang tawagin nang paulit-ulit (fs.mkdirSync
 * na may recursive:true ay no-op kung umiiral na ang direktoryo).
 */
export function ensureAgentSubdirs(projectRoot: string): void {
  for (const dir of [resolveTasksDir(projectRoot), resolveLogsDir(projectRoot), resolveIndexDir(projectRoot), resolvePlansDir(projectRoot), resolveReportsDir(projectRoot)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Shared na candidate-search resolver: sinusuri ang isang listahan ng mga posibleng path ayon
 * sa priyoridad at ibinabalik ang una na talagang umiiral sa disk. Ito ang iisang lugar kung
 * saan nangyayari ang "alin sa maraming posibleng lokasyon ang gagamitin" na logic -- dati ay
 * dalawang halos magkaparehong kopya nito (resolveConfigPath at resolveAgentPath sa
 * loadConfig.ts) na naiba pa nga sa priyoridad ng kanilang mga candidate at may bug sa fallback
 * (gumagamit ang resolveAgentPath ng maling default constant kapag walang nahanap na candidate).
 *
 * Priyoridad (unang tumugma ang mananaig): XCODER_HOME env var > current working directory >
 * home directory ng user > app/source directory.
 */
export function resolveFirstExistingPath(relativeSegment: string, opts?: { logResolution?: boolean }): string {
  const candidatePaths = buildCandidatePaths(relativeSegment);

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      if (opts?.logResolution) console.log(`configPath : ${candidate}`);
      return candidate;
    }
  }

  // Walang candidate na umiiral -- bumalik sa pinakamataas na priyoridad na candidate para
  // magtrigger ng mga default sa downstream na consumer (hal. loadLlmConfig).
  return candidatePaths[0];
}

function buildCandidatePaths(relativeSegment: string): string[] {
  const candidates: string[] = [];

  if (process.env.XCODER_HOME) {
    candidates.push(path.join(process.env.XCODER_HOME, relativeSegment));
  }
  candidates.push(path.join(process.cwd(), relativeSegment));
  candidates.push(path.join(os.homedir(), relativeSegment));
  candidates.push(path.join(appDir(), relativeSegment));

  return candidates;
}

function appDir(): string {
  const anyImportMeta = typeof import.meta !== "undefined" ? (import.meta as unknown as { dirname?: string }) : undefined;
  return anyImportMeta?.dirname ?? __dirname;
}
