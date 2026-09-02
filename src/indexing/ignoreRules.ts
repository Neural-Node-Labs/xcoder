import fs from "node:fs";
import path from "node:path";

// TANDAAN: sadyang HINDI isinasama ang .dockerignore dito. Inilalarawan ng mga panuntunan
// nito kung ano ang dapat ibukod mula sa Docker *build context* (docs/, *.md, scripts/,
// migrations/, test suites, atbp.), hindi kung ano ang "hindi bahagi ng proyekto". Ang
// paglapat nito sa workspace indexing ay maling magbubukod ng source .md files (kabilang
// ang bawat SKILL.md) at ng iba pang file na kailangan ng agent. Ang .gitignore ang
// awtoridad na pinagmumulan para sa "hindi bahagi ng proyekto"; ang .agent/.agentignore
// ay ang agent-specific na override.
// TANDAAN: dating ang ALWAYS_IGNORE ay ".agent/index/**" lamang ang ibinubukod sa .agent/ --
// hindi na-cover ang .agent/tasks/, .agent/logs/, .agent/plans/, at .agent/reports/, kaya
// aktwal na ini-index ng indexer ang sarili nitong task history, log, at report file pabalik
// sa loob ng dump na binubuo nito -- self-referential na basura na lumalaki sa bawat run.
// Ngayon, buong ".agent/**" na ang ibinubukod (kasama na ang index/ mismo), dahil ang lahat
// ng laman ng .agent/ ay agent-internal na runtime state, hindi kailanman source content na
// dapat isama sa workspace dump. Inalis rin ang stale na ".log/**" -- wala nang top-level na
// .log/ direktoryo mula nang pinagsama ito sa ilalim ng .agent/logs/ (tingnan ang
// src/config/paths.ts).
const IGNORE_FILES = [".agent/.agentignore", ".gitignore"];
const ALWAYS_IGNORE = ["**/node_modules/**", ".git/**", "dist/**", ".agent/**"];

/**
 * Kinokombert ang isang solong ignore-line pattern sa isang fast-glob-compatible na pattern.
 *
 * - Ang trailing slash ay nangangahulugang directory lamang -> ilagay ang double-star-slash
 *   bilang prefix at idagdag ang double-star para tumugma ito sa anumang lalim.
 * - Bare na pangalan ng direktoryo (walang path separator, walang tuldok, walang glob chars)
 *   -> ilagay ang double-star-slash bilang prefix at idagdag ang slash-double-star para
 *   tumugma ito sa direktoryo at sa lahat ng nasa loob nito sa anumang lalim.
 * - Ang mga pattern na nagsisimula na sa double-star-slash ay iniiwan nang ganoon.
 * - Ang lahat ng iba pa ay itinuturing na literal na file/glob pattern.
 */
function normalizePattern(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return trimmed;

  // Isa nang recursive glob -- gamitin nang ganoon
  if (trimmed.startsWith("**/")) return trimmed;

  // Directory-only na pattern: "node_modules/" -> "**/node_modules/**"
  if (trimmed.endsWith("/")) return `**/${trimmed}**`;

  // Bare na pangalan ng direktoryo (walang path separator, walang tuldok, walang glob chars):
  // hal. "dist" -> "**/dist/**", pero "Thumbs.db" ay nananatiling ganoon (may tuldok)
  if (
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    !trimmed.includes(".") &&
    !trimmed.includes("*") &&
    !trimmed.includes("?")
  ) {
    return `**/${trimmed}/**`;
  }

  return trimmed;
}

export function loadIgnoreRules(cwd: string = process.cwd()): string[] {
  const rules = new Set<string>(ALWAYS_IGNORE);

  for (const rel of IGNORE_FILES) {
    const p = path.join(cwd, rel);
    if (!fs.existsSync(p)) continue;
    const lines = fs
      .readFileSync(p, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const line of lines) {
      rules.add(normalizePattern(line));
    }
  }
  return [...rules];
}


