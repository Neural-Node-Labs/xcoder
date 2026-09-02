// ronin:version 5 | ronin:task task-b88b43 | ronin:updated 2026-08-13T06:17:34.564Z | ronin:subtask test-st-eaae62
/**
 * processCrashHandler.ts — Top-level na process crash handler para sa main agent.
 *
 * Nagbibigay ng iisang `installProcessCrashHandler()` na tawag na nagpaparehistro ng mga
 * handler para sa `uncaughtException` at `unhandledRejection` sa antas ng proseso. Kapag
 * may natukoy na crash, ang handler ay:
 *
 * 1. Nagla-log ng error kasama ang buong stack trace patungo sa stderr
 * 2. Bumubuo ng crash report file sa `.agent/reports/crash-<timestamp>.md`
 * 3. Sumusubok ng graceful shutdown (i-flush ang mga nakabinbing sulat, isara ang mga bukas na handle)
 * 4. Umaalis nang may code 1 — WALANG restart/retry logic para maiwasan ang infinite restart loop
 *
 * ## Restart-Loop Guard
 * - Ang isang module-level na `installed` flag ay pumipigil sa double-registration ng mga handler
 * - Ang isang 1-segundong debounce ay pumipigil sa mabilis na muling pagpasok mula sa cascading errors
 * - Ang handler ay tumatawag ng `process.exit(1)` nang walang kondisyon pagkatapos ng cleanup
 *
 * ## Paggamit
 * ```ts
 * import { installProcessCrashHandler } from "./core/processCrashHandler.js";
 * installProcessCrashHandler();
 * ```
 *
 * Tawagin ito sa mismong itaas ng main entry point, bago ang anumang iba pang initialization,
 * para matiyak na mahuhuli nito ang mga crash mula sa lahat ng code path.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveReportsDir } from "../config/paths.js";

// ─── Module-level na estado ───────────────────────────────────────────────────────

/** Pumipigil sa double-registration ng mga crash handler. */
let installed = false;

/** Timestamp ng huling crash event — ginagamit para sa debounce. */
let lastCrashTime = 0;

/** Mga reference sa mga nakarehistrong handler para maalis ito ng reset. */
let uncaughtHandler: ((err: Error) => void) | undefined;
let unhandledHandler: ((reason: unknown) => void) | undefined;

/** Debounce interval sa milliseconds — pumipigil sa mabilis na muling pagpasok mula sa cascading errors. */
const DEBOUNCE_MS = 1_000;

// ─── Mga Uri (Types) ────────────────────────────────────────────────────────────────

export interface CrashReport {
  /** ISO 8601 timestamp ng crash. */
  timestamp: string;
  /** Ang mensahe ng error. */
  message: string;
  /** Ang buong stack trace, kung available. */
  stack?: string;
  /** Ang uri ng crash: "uncaughtException" o "unhandledRejection". */
  crashType: "uncaughtException" | "unhandledRejection";
  /** Bersyon ng Node.js. */
  nodeVersion: string;
  /** Mga argumento ng proseso. */
  argv: string[];
  /** Kasalukuyang working directory. */
  cwd: string;
  /** Platform. */
  platform: string;
}

// ─── Pagbuo ng crash report ──────────────────────────────────────────────────────

/**
 * Bumubuo ng crash report file sa `.agent/reports/crash-<timestamp>.md` sa loob ng ibinigay
 * na workspace root directory.
 *
 * @param workspaceRoot - Ang project root directory (default ay process.cwd()).
 * @param report - Ang data ng crash report.
 * @returns Ang path patungo sa nabuong crash report file.
 */
export function generateCrashReport(
  workspaceRoot: string,
  report: CrashReport
): string {
  const reportsDir = resolveReportsDir(workspaceRoot);
  fs.mkdirSync(reportsDir, { recursive: true });

  const timestamp = new Date(report.timestamp).getTime();
  const reportPath = path.join(reportsDir, `crash-${timestamp}.md`);

  const markdown = [
    `# Crash Report`,
    ``,
    `**Timestamp:** ${report.timestamp}`,
    `**Type:** ${report.crashType}`,
    `**Node.js:** ${report.nodeVersion}`,
    `**Platform:** ${report.platform}`,
    `**CWD:** ${report.cwd}`,
    `**Arguments:** \`${report.argv.join(" ")}\``,
    ``,
    `## Error`,
    ``,
    `\`\`\``,
    report.message,
    `\`\`\``,
    ``,
  ];

  if (report.stack) {
    markdown.push(
      `## Stack Trace`,
      ``,
      `\`\`\``,
      report.stack,
      `\`\`\``,
      ``,
    );
  }

  markdown.push(
    `## Ano ang Nangyari`,
    ``,
    `Nakaranas ang main process ng hindi nahawakang error at maayos itong pinatigil.`,
    `Walang awtomatikong pagsisimula muli — ito ay isang single-exit crash handler ayon sa disenyo.`,
    `Suriin ang error sa itaas at ang mga application log sa ilalim ng \`.agent/logs/\` para sa karagdagang konteksto.`,
    ``,
  );

  fs.writeFileSync(reportPath, markdown.join("\n"), "utf-8");
  return reportPath;
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────────

/**
 * Sumubok ng graceful shutdown bago umalis.
 *
 * Sadyang ito ay synchronous — nasa loob tayo ng isang crash handler at hindi maaaring
 * mag-await ng mga async operation. Ginagawa natin ang magagawa nang synchronous:
 * - I-flush ang anumang nakabinbing pagsulat sa file (naka-flush na ng Node ang mga sync na sulat)
 * - Ilog ang crash sa stderr
 * - Buuin ang crash report
 *
 * @param workspaceRoot - Ang project root directory.
 * @param report - Ang data ng crash report.
 */
function gracefulShutdown(workspaceRoot: string, report: CrashReport): void {
  // Ilog sa stderr
  console.error("");
  console.error("=".repeat(60));
  console.error(`[CRASH] ${report.crashType} — ${report.message}`);
  if (report.stack) {
    console.error(report.stack);
  }
  console.error("=".repeat(60));
  console.error("");

  // Bumuo ng crash report
  try {
    const reportPath = generateCrashReport(workspaceRoot, report);
    console.error(`[CRASH] Nasulat ang crash report sa ${reportPath}`);
  } catch (reportErr) {
    console.error(`[CRASH] Nabigong isulat ang crash report: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`);
  }

  console.error("[CRASH] Nagtatapos ang proseso na may exit code 1.");
}

// ─── Pag-install ng handler ─────────────────────────────────────────────────────────

/**
 * Mag-install ng top-level na process crash handler para sa `uncaughtException` at
 * `unhandledRejection`.
 *
 * Ang function na ito:
 * - Nagpaparehistro ng mga handler na nagla-log ng error, bumubuo ng crash report, at aalis nang may code 1
 * - Gumagamit ng module-level na `installed` flag para pigilan ang double-registration
 * - Gumagamit ng 1-segundong debounce para pigilan ang mabilis na muling pagpasok mula sa cascading errors
 * - Tumatawag ng `process.exit(1)` nang walang kondisyon — WALANG restart/retry logic
 *
 * Tawagin ito sa mismong itaas ng main entry point, bago ang anumang iba pang initialization.
 *
 * @param workspaceRoot - Ang project root directory para sa crash report output.
 *   Default ay `process.cwd()`.
 */
export function installProcessCrashHandler(workspaceRoot?: string): void {
  // Pigilan ang double-registration
  if (installed) {
    return;
  }
  installed = true;

  const root = workspaceRoot ?? process.cwd();

  // ── uncaughtException handler ──────────────────────────────────────────────
  uncaughtHandler = (err: Error) => {
    const now = Date.now();

    // Debounce: kung wala pang DEBOUNCE_MS mula sa huling crash, laktawan
    if (now - lastCrashTime < DEBOUNCE_MS) {
      // Aalis pa rin — hindi na lang natin muling papatakbuhin ang buong handler
      process.exit(1);
      return;
    }
    lastCrashTime = now;

    const report: CrashReport = {
      timestamp: new Date().toISOString(),
      message: err.message ?? String(err),
      stack: err.stack,
      crashType: "uncaughtException",
      nodeVersion: process.version,
      argv: process.argv,
      cwd: process.cwd(),
      platform: process.platform,
    };

    gracefulShutdown(root, report);

    // Umalis nang may non-zero code — WALANG restart/retry logic.
    // Sadya ito: ang pagsisimula muli mula sa isang crash handler ay maaaring magtakip ng
    // mga bug, magdulot ng infinite restart loop, at mawala ang orihinal na konteksto ng error.
    // Dapat suriin ng user ang crash report at ayusin ang pangunahing isyu.
    process.exit(1);
  };

  // ── unhandledRejection handler ─────────────────────────────────────────────
  unhandledHandler = (reason: unknown) => {
    const now = Date.now();

    // Debounce: kung wala pang DEBOUNCE_MS mula sa huling crash, laktawan
    if (now - lastCrashTime < DEBOUNCE_MS) {
      process.exit(1);
      return;
    }
    lastCrashTime = now;

    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
        ? reason
        : `Unhandled rejection: ${String(reason)}`;

    const stack = reason instanceof Error ? reason.stack : undefined;

    const report: CrashReport = {
      timestamp: new Date().toISOString(),
      message,
      stack,
      crashType: "unhandledRejection",
      nodeVersion: process.version,
      argv: process.argv,
      cwd: process.cwd(),
      platform: process.platform,
    };

    gracefulShutdown(root, report);

    // Umalis nang may non-zero code — WALANG restart/retry logic (parehong dahilan gaya sa itaas)
    process.exit(1);
  };

  process.on("uncaughtException", uncaughtHandler);
  process.on("unhandledRejection", unhandledHandler);
}

/**
 * Suriin kung na-install na ang crash handler.
 * Kapaki-pakinabang para sa mga test na beripikahin ang installation nang walang side effects.
 */
export function isCrashHandlerInstalled(): boolean {
  return installed;
}

/**
 * I-reset ang installed flag (para sa layuning testing lamang).
 * Pinapayagan nito ang mga test na beripikahin ang installation behavior nang hindi tumutulo ang estado.
 */
export function resetCrashHandlerState(): void {
  installed = false;
  lastCrashTime = 0;
  if (uncaughtHandler) {
    process.removeListener("uncaughtException", uncaughtHandler);
    uncaughtHandler = undefined;
  }
  if (unhandledHandler) {
    process.removeListener("unhandledRejection", unhandledHandler);
    unhandledHandler = undefined;
  }
}
