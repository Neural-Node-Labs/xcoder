// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:53:08.606Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath, resolveAgentPath } from "../config/loadConfig.js";
import { resolveLessonsPath, resolveTodoPath } from "../config/paths.js";
import { describeShell } from "../tools/runCommandTool.js";

const PROTOCOL_PATH = path.join("xcoder.md");

/**
 * TAMA: Ang "agent/" (walang tuldok) ay iba sa ".agent/" (may tuldok) sa codebase na ito —
 * ang una ay ang install/config na direktoryo (config/llm.yaml, xcoder.md), na-resolba ng
 * resolveConfigPath() na maaaring mabuhay sa app dir/home dir/XCODER_HOME; ang huli ay ang
 * per-workspace na runtime state ng .agent/ (tasks/, logs/, index/, plans/), palaging kaugnay
 * ng project root. Ang loadProtocol() ay gumagamit ng "agent/" (config); ang loadLessons/
 * recordLesson/writeTodo/appendTodoReview ay gumagamit ng ".agent/" (runtime state) sa
 * pamamagitan ng src/config/paths.ts.
 *
 * DATI, ang recordLesson() ay tinatanggap ng caller (cli/index.ts) ang `cwd` = project root
 * mismo at direktang ginawa ang `<projectRoot>/lessons.md` — isang TOP-LEVEL na file, hindi
 * kailanman ".agent/lessons.md" -- habang ang buildProtocolPrompt() naman ay laging nagbabasa
 * mula sa resolveAgentPath() at itinatapon ang tahasang `cwd` argument nito mismo. Ang resulta:
 * hindi kailanman nababasa pabalik ang mga lessons na naitala sa pamamagitan ng `xcoder --lesson`
 * dahil isinulat ang mga ito sa ibang file kaysa sa binabasa. Naayos na ito -- iisang function
 * (resolveLessonsPath) na ngayon ang tanging bumubuo ng path na ito, at ginagamit na ni
 * buildProtocolPrompt ang aktwal na `cwd` na ipinasa dito.
 */
function loadProtocol(cwd: string = resolveConfigPath()): string | undefined {
  const p = path.join(cwd, PROTOCOL_PATH);
  if (fs.existsSync(p)) {
    console.log(`Na-load ang protocol ...`)
  } else {
    console.log(`Hindi nahanap ang protocol! ...${p}`)
  }
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8").trim() : undefined;
}

/** Binabasa ang .agent/lessons.md kung mayroon — mga pattern na nakuha mula sa mga naunang pagwawasto ng user. */
export function loadLessons(projectRoot: string = path.dirname(resolveAgentPath())): string | undefined {
  const p = resolveLessonsPath(projectRoot);
  if (fs.existsSync(p)) {
    console.log(`Na-load ang mga aral ...`)
  } else {
    console.log(`Walang nahanap na aral! ...${p}`)
  }
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8").trim() : undefined;
}

/** Nagdadagdag ng timestamped na lesson entry sa .agent/lessons.md, ayon sa "Self-Improvement Loop" sa protocol. */
export function recordLesson(lesson: string, projectRoot: string = path.dirname(resolveAgentPath())): void {
  const p = resolveLessonsPath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const entry = `\n## ${new Date().toISOString()}\n${lesson}\n`;
  fs.appendFileSync(p, entry, "utf-8");
}

/** Isinusulat ang plano sa .agent/tasks/todo.md. */
export function writeTodo(projectRoot: string, content: string): void {
  const p = resolveTodoPath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

/** Idinadagdag ang isang review section sa .agent/tasks/todo.md. */
export function appendTodoReview(projectRoot: string, review: string): void {
  const p = resolveTodoPath(projectRoot);
  fs.appendFileSync(p, `\n## Review\n${review}\n`, "utf-8");
}

/**
 * Binubuo ang system prompt kasama ang protocol/lessons/skills na naka-wrap sa mga XML tag
 * na inirerekomenda ng docs ng DeepSeek para sa pag-segment ng malaking instruction payload
 * sa loob ng isang mensahe.
 */
/**
 * Efficient-filesystem operating protocol na idinadagdag sa system prompt ng bawat engine.
 * Ipinapatupad ang disiplina ng search-first/outline-first/batched-read/cheapest-edit-ladder.
 */
const EFFICIENT_FILESYSTEM_PROTOCOL = `
EFFICIENT FILESYSTEM PROTOCOL
- Locate with glob_tool/find_files_tool/search_code_tool/search_ast_tool/get_dependency_graph_tool before full reads.
- First read of a file >150 lines: read_outline_tool, then read_file_range_tool of the needed slice.
- Cross-file analysis: one read_multiple_files_tool call, not N read_tool calls.
- Edit selection: exact string → search_replace_block_tool; regex → sed_replace_tool / sed_replace_multi_tool;
  line-addressed → line_patch_tool (always with expectedSha1); whole function → update_function_tool;
  semantic rename → rename_symbol_tool; multi-hunk → apply_unified_diff_tool;
  full rewrite → write_file_tool with force:true above 200 lines.
- After every edit: validate_file_tool (edit tools report errors themselves) and git_diff_tool to confirm intent.
- Replace consumed search/list output in context with a one-line summary (dead-context pruning).
`;

export function buildProtocolPrompt(cwd: string = process.cwd()): string {
  const protocol = loadProtocol(resolveConfigPath());
  const lessons = loadLessons(cwd); // ang project root na aktwal na ipinasa ng caller, hindi ang global-discovered .agent

  let out = `<runtime_environment>\nCommands from run_command_tool execute on this host via ${describeShell()}\n</runtime_environment>\n\n`;
  if (protocol) {
    out += `<system_directive>\nYou are xcoder, operating under the following engineering protocol.\n</system_directive>\n\n<engineering_protocol>\n${protocol}\n</engineering_protocol>\n\n`;
  }
  if (lessons) {
    out += `<lessons_learned>\nPatterns captured from prior corrections in this workspace — apply them proactively.\n${lessons}\n</lessons_learned>\n\n`;
  }
  out += `<efficient_filesystem_protocol>\n${EFFICIENT_FILESYSTEM_PROTOCOL}\n</efficient_filesystem_protocol>\n\n`;
  return out;
}


