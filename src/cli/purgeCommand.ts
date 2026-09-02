// ronin:version 3 | ronin:task task-bc7d1e | ronin:updated 2026-08-13T07:33:32.176Z | ronin:subtask code-st-2ad77b
import type { Command } from "commander";
import { runPurge, PURGE_TARGETS } from "./purge.js";
import type { PurgeOptions, PurgeResult, PurgeScope } from "./purge.js";
import { CliIO } from "./CliIO.js";

export interface PurgeCommandArgs {
  scope?: "workspace" | "global";
  targets?: string;
  dryRun?: boolean;
  force?: boolean;
  auto?: boolean;
  cwd?: string;
}

export interface PurgeCommandOutcome {
  exitCode: 0 | 1;
  result: PurgeResult;
  dryRun: boolean;
}

/**
 * Iisang shared handler para sa parehong `xcoder purge [options]` at ang legacy
 * `xcoder --purge [...]` flag para hindi magkalayo ang dalawang pagbaybay.
 *
 * Ini-print nito mismo ang mga resulta; kailangan lamang ng caller ang na-compute na
 * exit code. Ang mga dry-run ay hindi kailanman nagta-tanong o nag-de-delete. Ang mga
 * interactive run ay nagtatanong nang isang beses bago mag-delete; ang `--auto` at
 * mga non-TTY run ay awtomatikong nag-a-approve (kasalukuyang behavior).
 */
export async function runPurgeCommand(args: PurgeCommandArgs): Promise<PurgeCommandOutcome> {
  const scope: PurgeScope = args.scope === "global" ? "global" : "workspace";
  const dryRun = args.dryRun === true;
  const force = args.force === true;
  const auto = args.auto === true;
  const targets = args.targets
    ? args.targets.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;

  const options: PurgeOptions = {
    scope,
    dryRun,
    force,
    targets,
    cwd: args.cwd,
  };

  if (!dryRun) {
    const io = new CliIO({ interactive: !auto && !!process.stdin.isTTY });
    options.confirm = (message) => io.confirm(message);
  }

  let result: PurgeResult;
  try {
    result = await runPurge(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ [Purge] ${message}`);
    return {
      exitCode: 1,
      result: { removed: [], skipped: [], failed: [{ target: "targets", error: message }] },
      dryRun,
    };
  }

  const label = dryRun ? "[Purge] (dry-run)" : "[Purge]";
  for (const t of result.removed) {
    console.log(`${dryRun ? "🔍" : "🗑️"} ${label} ${t}`);
  }
  for (const t of result.skipped) {
    console.log(`⏭️  ${label} ${t} (hindi nahanap — nilaktawan)`);
  }
  for (const f of result.failed) {
    console.error(`❌ ${label} ${f.target}: ${f.error}`);
  }

  return { exitCode: result.failed.length > 0 ? 1 : 0, result, dryRun };
}

/**
 * Nagpaparehistro ng `xcoder purge` subcommand sa ibinigay na Commander program.
 * Ang subcommand ay mananaig kaysa sa parent na `[task]` positional para sa eksaktong
 * token na `purge`, habang ang mga multi-word na naka-quote na task (`xcoder "purge my notes"`)
 * ay dumadaan pa rin sa parent ReAct path.
 */
export function registerPurgeSubcommand<T extends Command>(program: T, defaults?: { cwd?: string }): T {
  const subcommand = program.command("purge");
  subcommand
    .description("alisin ang agent-internal na metadata at mga likhang artifact (.agent/, kasama ang tasks/, logs/, index/, plans/, reports/ nito)")
    .option("--scope <workspace|global>", "saklaw para sa purge: 'workspace' (default) o 'global' (os.homedir())")
    .option("--targets <list>", `comma-separated na subset ng mga target na pu-purgahin (default: ${PURGE_TARGETS.join(",")})`)
    .option("--dry-run", "i-print kung ano ang aalisin nang hindi tinatanggal ang anuman")
    .option("--force", "alisin ang mga symlink mismo (hindi kailanman ang mga tinutukoy nito)")
    .option("--auto", "ganap na autonomous mode — awtomatikong ina-approve ang confirmation prompt")
    .option("--cwd <path>", "i-override ang workspace root (test/embedding seam; default: process.cwd())")
    .action(async (opts: PurgeCommandArgs) => {
      const outcome = await runPurgeCommand({
        ...opts,
        cwd: opts.cwd ?? defaults?.cwd ?? process.cwd(),
      });
      if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
    });
  return program;
}
