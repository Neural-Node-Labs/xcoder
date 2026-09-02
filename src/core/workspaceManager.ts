import fs from "node:fs";
import path from "node:path";

export const WORKSPACE_DIR_NAME = "workspace-agent";

/** Hindi kailanman kinokopya papunta sa isolated workspace — alinman sa agent-internal na
 *  metadata na dapat nasa project root, o mga build/VCS artifact na sasayang lang ng oras
 *  at disk kung i-duplicate. (DATI, magkakahiwalay na entry ang ".log" at "tasks" -- pareho
 *  na ngayong nasa ilalim ng ".agent/" kaya sapat na ang isang entry na iyon para masakop sila.) */
export const EXCLUDED = new Set([WORKSPACE_DIR_NAME, ".agent", ".git", "node_modules", "dist", "build"]);

/**
 * Sinasalamin ang `projectRoot` papunta sa `projectRoot/workspace-agent/`, ibinubukod ang mga
 * path sa itaas, at ibinabalik ang workspace-agent path. Ang mga tool call (read/write/
 * run_command/atbp.) ay gumagana sa loob ng kopyang ito, hindi sa live na proyekto — kaya ang
 * isang masamang edit o isang errant na `rm` mula sa isang agent run ay hindi kailanman
 * diretsong nakakaapekto sa tunay na mga file ng user. Ang protocol/lessons/task-history/todo
 * ay nagbabasa at nagsusulat pa rin sa `projectRoot` mismo (tingnan ang paghahati ng
 * `projectRoot` kumpara sa `cwd` ng orchestrator.ts), dahil ang mga iyon ay para
 * magpatuloy sa buong workspace reset, hindi para maging bahagi ng disposable na kopya.
 *
 * Nag-re-sync sa bawat tawag (buong re-copy ng mga nagbagong file) sa halip na susubaybayan
 * ang isang diff — simple at tama, bagaman hindi ang pinakamabilis na opsyon para sa napakalaking
 * repo. Ang mga umiiral nang file sa workspace-agent na wala nang existing sa source ay iniiwan
 * na lamang sa halip na tanggalin, para ang anumang ginawa ng agent na hindi pa na-reconcile
 * pabalik ay hindi tahimik na nawawala sa susunod na sync.
 */
export function prepareWorkspace(projectRoot: string): string {
  const workspacePath = path.join(projectRoot, WORKSPACE_DIR_NAME);
  fs.mkdirSync(workspacePath, { recursive: true });
  copyRecursive(projectRoot, workspacePath, projectRoot);
  return workspacePath;
}

function copyRecursive(srcRoot: string, destRoot: string, currentSrcDir: string): void {
  const entries = fs.readdirSync(currentSrcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED.has(entry.name)) continue;

    const srcPath = path.join(currentSrcDir, entry.name);
    const relPath = path.relative(srcRoot, srcPath);
    const destPath = path.join(destRoot, relPath);

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcRoot, destRoot, srcPath);
    } else if (entry.isFile()) {
      // Laktawan ang pagkopya kung byte-identical na ang destination at hindi mas luma —
      // murang paraan para maiwasan ang walang-saysay na muling pagsulat (at pag-bump ng
      // mtime) ng mga file na hindi nagbago.
      if (!needsCopy(srcPath, destPath)) continue;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function needsCopy(srcPath: string, destPath: string): boolean {
  if (!fs.existsSync(destPath)) return true;
  const srcStat = fs.statSync(srcPath);
  const destStat = fs.statSync(destPath);
  return srcStat.mtimeMs > destStat.mtimeMs || srcStat.size !== destStat.size;
}
