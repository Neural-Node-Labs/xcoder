// ronin:version 6 | ronin:task task-4508cb | ronin:updated 2026-08-13T15:39:23.990Z | ronin:subtask code-st-885544
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { LoadedSkill, SkillDiagnostic, SkillHeader } from "./types.js";
import { resolveConfigPath } from "../config/loadConfig.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const LEADING_HTML_COMMENT_RE = /^<!--[\s\S]*?-->/;
const LEADING_WHITESPACE_RE = /^[ \t\r\n]+/;
const LEGACY_METADATA_RE = /^\s*#\s*name\s*:/m;

interface ParsedSkillSource {
  header?: SkillHeader;
  body?: string;
  diagnostic?: SkillDiagnostic;
}

/**
 * Registration manager for the Special Evolution skill system.
 * Reads every .agent/skill/<name>/SKILL.md, parses its YAML header so the LLM/orchestrator
 * knows what each skill is for without loading the full body, and lazily loads the full
 * body only when a skill is actually selected for a task.
 *
 * Parsing is lenient-but-loud: a UTF-8 BOM, leading blank lines, and leading HTML comments
 * before the `---` frontmatter block are tolerated, and any file that still cannot be parsed
 * is reported via `listDiagnostics()` (and optionally an `onDiagnostic` sink) instead of
 * being silently dropped.
 */
export class SkillRegistry {
  private headers = new Map<string, SkillHeader>();
  private paths = new Map<string, string>();
  private skillDir: string;
  private diagnostics: SkillDiagnostic[] = [];
  private onDiagnostic?: (d: SkillDiagnostic) => void;

  constructor(skillDir?: string, options?: { onDiagnostic?: (d: SkillDiagnostic) => void }) {
    this.onDiagnostic = options?.onDiagnostic;

    if (skillDir) {
      this.skillDir = skillDir;
      return;
    }
    const cwdSkills = path.join(resolveConfigPath(), "skills");
    if (fs.existsSync(cwdSkills)) {
      this.skillDir = cwdSkills;
      return;
    }

    this.skillDir = cwdSkills;
  }

  /** Scan and parse headers only — cheap, safe to call often (e.g. on xcoder --index). */
  loadHeaders(): SkillHeader[] {
    this.headers.clear();
    this.paths.clear();
    this.diagnostics = [];

    if (!fs.existsSync(this.skillDir)) return [];

    const dirs = fs.readdirSync(this.skillDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const dir of dirs) {
      const skillPath = path.join(this.skillDir, dir.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) {
        this.emit({
          skillDir: this.skillDir,
          path: path.join(this.skillDir, dir.name),
          code: "NO_SKILL_MD",
          message: `Directory "${dir.name}" has no SKILL.md; skill was not loaded`,
        });
        continue;
      }

      const raw = fs.readFileSync(skillPath, "utf-8");
      const parsed = this.parseSkillSource(raw, skillPath);
      if (parsed.diagnostic) this.emit(parsed.diagnostic);
      if (!parsed.header) continue;

      this.headers.set(parsed.header.name, parsed.header);
      this.paths.set(parsed.header.name, skillPath);
    }
    return [...this.headers.values()];
  }

  /** Load the full skill (header + body) by name, for injection into the LLM context. */
  loadSkill(name: string): LoadedSkill | undefined {
    const skillPath = this.paths.get(name);
    if (!skillPath) return undefined;

    const raw = fs.readFileSync(skillPath, "utf-8");
    const parsed = this.parseSkillSource(raw, skillPath);
    if (parsed.diagnostic) this.emit(parsed.diagnostic);
    if (!parsed.header) return undefined;

    return { header: parsed.header, body: parsed.body ?? "", path: skillPath };
  }

  /**
   * Route a task description to candidate skills by trigger-keyword match.
   * Returns skills ranked by match count, highest first. Multiple skills may
   * be selected — xcoder composes them (see composes_with in each header).
   */
  route(taskDescription: string): SkillHeader[] {
    if (this.headers.size === 0) this.loadHeaders();
    const text = taskDescription.toLowerCase();

    const scored = [...this.headers.values()].map((h) => {
      const score = h.triggers.reduce((acc, t) => acc + (this.matchesTrigger(text, t) ? 1 : 0), 0);
      return { header: h, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.header);
  }

  list(): SkillHeader[] {
    if (this.headers.size === 0) this.loadHeaders();
    return [...this.headers.values()];
  }

  /** Diagnostics recorded during the most recent scan (loadHeaders / list / route). */
  listDiagnostics(): readonly SkillDiagnostic[] {
    return this.diagnostics;
  }

  /**
   * True when a single-word trigger appears as a whole word in the task text
   * (e.g. "hi" matches "hi there" but not "matching"). Multi-word triggers use
   * a plain substring match so phrases like "clean up files" still route correctly.
   */
  private matchesTrigger(text: string, rawTrigger: string): boolean {
    const trigger = rawTrigger.toLowerCase();
    if (trigger.includes(" ")) {
      return text.includes(trigger);
    }
    const escaped = trigger
      .split("")
      .map((ch) => ("\\^$.*+?()[]{}|".includes(ch) ? "\\" + ch : ch))
      .join("");
    return new RegExp("(^|[^A-Za-z0-9_])" + escaped + "(?=$|[^A-Za-z0-9_])").test(text);
  }

  /**
   * Parse a single SKILL.md source into header + body. Lenient about UTF-8 BOM, leading
   * blank lines / whitespace, and leading HTML comments before the frontmatter block.
   * Never silently drops a file: unparseable input yields a diagnostic.
   */
  private parseSkillSource(raw: string, skillPath: string): ParsedSkillSource {
    const match = this.parseFrontmatter(raw);
    if (!match) {
      const legacy = LEGACY_METADATA_RE.test(raw);
      return {
        diagnostic: {
          skillDir: this.skillDir,
          path: skillPath,
          code: legacy ? "LEGACY_METADATA" : "NO_FRONTMATTER",
          message: legacy
            ? "SKILL.md uses legacy '# name:' comment metadata instead of YAML frontmatter; skill was not loaded"
            : "No YAML frontmatter found in SKILL.md; skill was not loaded",
        },
      };
    }

    let header: unknown;
    try {
      header = yaml.load(match[1]);
    } catch (err) {
      return {
        diagnostic: {
          skillDir: this.skillDir,
          path: skillPath,
          code: "YAML_ERROR",
          message: "Invalid YAML in SKILL.md frontmatter; skill was not loaded",
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const problems = this.validateHeader(header);
    if (problems.length > 0) {
      return {
        diagnostic: {
          skillDir: this.skillDir,
          path: skillPath,
          code: "INVALID_HEADER",
          message: "SKILL.md frontmatter is missing or has invalid required fields; skill was not loaded",
          detail: problems.join(", "),
        },
      };
    }

    const skillHeader = header as SkillHeader;
    const dirName = path.basename(path.dirname(skillPath));
    if (skillHeader.name !== dirName) {
      this.emit({
        skillDir: this.skillDir,
        path: skillPath,
        code: "DIR_NAME_MISMATCH",
        message: `Skill header name "${skillHeader.name}" does not match directory name "${dirName}"`,
        detail: "The skill is loaded under its header name.",
      });
    }

    return { header: skillHeader, body: match[2].trim() };
  }

  /**
   * Match the frontmatter block, tolerating a leading UTF-8 BOM, leading blank lines /
   * whitespace, and leading HTML comments (max 8 iterations). Returns the same shape as
   * String.match(FRONTMATTER_RE), or null when no frontmatter can be found.
   */
  private parseFrontmatter(raw: string): RegExpMatchArray | null {
    let candidate = raw.replace(/^\uFEFF/, "");
    for (let i = 0; i < 8; i++) {
      const match = candidate.match(FRONTMATTER_RE);
      if (match) return match;

      candidate = candidate.replace(LEADING_WHITESPACE_RE, "");
      const comment = candidate.match(LEADING_HTML_COMMENT_RE);
      if (comment) {
        candidate = candidate.slice(comment[0].length);
        continue;
      }
      break;
    }
    return candidate.match(FRONTMATTER_RE);
  }

  /** Validate the parsed frontmatter against the required SkillHeader shape. */
  private validateHeader(header: unknown): string[] {
    const problems: string[] = [];
    if (!header || typeof header !== "object") return ["header-not-object"];

    const h = header as Record<string, unknown>;
    if (typeof h.name !== "string" || h.name.length === 0) problems.push("name-missing");
    if (!Array.isArray(h.triggers)) problems.push("triggers-not-array");
    if (!Array.isArray(h.composes_with)) problems.push("composes_with-not-array");
    if (!Array.isArray(h.requires_tools)) problems.push("requires_tools-not-array");
    return problems;
  }

  /** Record a diagnostic in the last-scan list and forward it to the sink (default stderr). */
  private emit(diagnostic: SkillDiagnostic): void {
    this.diagnostics.push(diagnostic);
    if (this.onDiagnostic) {
      this.onDiagnostic(diagnostic);
    } else {
      console.error(`[skill] ${diagnostic.message} (${diagnostic.path})`);
    }
  }
}
