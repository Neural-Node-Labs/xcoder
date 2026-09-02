import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * `devnull purge` — nag-aalis ng agent-internal na metadata at mga likhang artifact mula sa
 * isang workspace.
 *
 * Ang target set ay kinukuha mula sa `EXCLUDED` set sa `src/core/workspaceManager.ts`, na
 * siyang tanging pinagmumulan ng katotohanan para sa "agent-internal / generated" na mga path.
 * `.agent/` ang TANGING direktoryo na ligtas na burahin nang buo -- ito na ang naglalaman ng
 * lahat ng system-generated na subdirectory (tasks/, logs/, index/, plans/, reports/; tingnan
 * ang src/config/paths.ts). Ang lahat ng iba pa sa `EXCLUDED` (`.git`, `node_modules`, `dist`,
 * `build`, `workspace-agent`) ay sadyang HINDI pinu-purge — ang mga iyon ay alinman sa mga
 * user-owned na VCS/build artifact o ang isolated-workspace copy.
 *
 * (DATI, tatlong hiwalay na top-level na direktoryo ang pinupurge: `.agent/`, `.log/`, at
 * `tasks/`. Pinagsama-sama na ang mga ito sa ilalim ng `.agent/` lamang, kaya iisa na lang
 * ang purge target.)
 *
 * Modelo ng kaligtasan (tingnan ang Phase 2 design note):
 *   - Allow-list: isang hard-coded na target lamang ang inaalis, hindi kailanman
 *     ang arbitrary na mga path.
 *   - Containment: kailangang ma-resolba ang target laban sa scope root at manatiling nasa
 *     loob nito.
 *   - Type check: tinatanggihan ang mga symlink bilang default (maaaring magulat ang user kung
 *     aalisin ang isang symlink); ang `--force` ay nag-aalis ng link mismo, hindi kailanman ng
 *     tinutukoy nito.
 *   - Tinatanggap ang mga nawawalang target (exit 0) — ang pag-purge sa isang malinis na
 *     workspace ay isang no-op.
 */

/** Ang tanging direktoryong inaalis ng `devnull purge`. Sinasalamin ang purge-relevant na subset ng `EXCLUDED`. */
export const PURGE_TARGETS = [".agent"] as const;

export type PurgeScope = "workspace" | "global";

export interface PurgeOptions {
  /** Root na direktoryo kung saan re-resolba ang mga target. */
  scope: PurgeScope;
  /** Kapag true, i-print kung ano ang aalisin nang hindi tinatanggal ang anuman. */
  dryRun: boolean;
  /** Kapag true, alisin ang mga symlink mismo (hindi kailanman ang mga tinutukoy nito). */
  force: boolean;
  /** Opsyonal na subset ng PURGE_TARGETS na aalisin. Default ang lahat ng tatlo. */
  targets?: string[];
  /** Interactive confirmation callback. Default ay isang no-op na nagbabalik ng true. */
  confirm?: (message: string) => Promise<boolean>;
  /** I-override ang workspace root (default ang process.cwd()). Ginagamit ng mga test. */
  cwd?: string;
}

export interface PurgeResult {
  /** Mga target na inalis (o aalisin, sa dry-run). */
  removed: string[];
  /** Mga target na nilaktawan dahil hindi ito umiiral. */
  skipped: string[];
  /** Mga target na nabigong maalis (permission errors, atbp.). */
  failed: { target: string; error: string }[];
}

/** Rine-resolba ang scope root: `process.cwd()` para sa workspace, `os.homedir()` para sa global. */
export function resolveScopeRoot(scope: PurgeScope, cwd?: string): string {
  return scope === "global" ? os.homedir() : cwd ?? process.cwd();
}

/** Vine-validate ang user-supplied na `--targets` list laban sa allow-list. Nagbabalik ng
 *  normalized na subset, o `null` kung ang anumang entry ay hindi kilalang purge target. */
export function normalizeTargets(targets: string[] | undefined): string[] | null {
  if (!targets || targets.length === 0) return [...PURGE_TARGETS];
  const normalized = targets.map((t) => t.trim()).filter(Boolean);
  for (const t of normalized) {
    if (!(PURGE_TARGETS as readonly string[]).includes(t)) return null;
  }
  return [...new Set(normalized)];
}

/**
 * Isinasagawa ang purge. Hindi kailanman nagta-throw para sa mga nawawalang target o mga
 * per-target na kabiguan sa pag-alis — iniuulat ang mga iyon sa resulta para makapagpasya ang
 * caller ng exit code. Nagta-throw lamang para sa hindi wastong input (hindi kilalang target,
 * path escape), na tinuturing ng caller bilang hard error.
 */
export async function runPurge(opts: PurgeOptions): Promise<PurgeResult> {
  const targets = normalizeTargets(opts.targets);
  if (targets === null) {
    throw new Error(
      `Invalid --targets value. Allowed targets: ${PURGE_TARGETS.join(", ")}.`
    );
  }

  const root = resolveScopeRoot(opts.scope, opts.cwd);
  const result: PurgeResult = { removed: [], skipped: [], failed: [] };

  // Confirmation guard: kapag hindi dry-run at ibinigay ang confirm callback, magtanong nang
  // isang beses bago mag-delete ng anuman. Ang sagot na `false` ay agad na huhumpay sa buong
  // purge (walang mababawas).
  if (!opts.dryRun && opts.confirm) {
    const approved = await opts.confirm(
      `Remove ${targets.join(", ")} from ${root}?`
    );
    if (!approved) {
      return result;
    }
  }

  for (const target of targets) {
    const resolved = path.resolve(root, target);
    const normalizedRoot = path.resolve(root);

    // Containment: kailangang manatili ang resolved path sa loob ng scope root.
    if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
      throw new Error(`Refusing to purge "${target}" — resolves outside the scope root.`);
    }

    // lstatSync (hindi existsSync) para matukoy rin ang mga dangling symlink at masuri ang
    // uri ng entry sa isang tawag. Ang isang nawawalang path ay nagta-throw ng ENOENT →
    // tinatanggap bilang "skipped".
    let stat;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      result.skipped.push(target);
      continue;
    }

    // Type check: tanggihan ang mga symlink maliban sa --force (na nag-aalis ng link, hindi ng tinutukoy nito).
    if (stat.isSymbolicLink() && !opts.force) {
      result.failed.push({
        target,
        error: `is a symbolic link (use --force to remove the link itself)`,
      });
      continue;
    }

    if (opts.dryRun) {
      result.removed.push(target);
      continue;
    }

    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      result.removed.push(target);
    } catch (err) {
      result.failed.push({
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
