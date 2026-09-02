import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { globTool } from "../tools/globTool.js";

const INFO_PATH = ".agent/workspace-info.json";
const MAX_TREE_ENTRIES = 400; // panatilihing mura ang gastos para maiturok sa bawat system prompt

export interface WorkspaceGitInfo {
  isRepo: boolean;
  branch?: string;
  remote?: string;
  lastCommit?: string;
  dirty?: boolean;
}

export interface WorkspacePackageInfo {
  name?: string;
  version?: string;
  scripts?: string[];
  dependencies?: string[];
  devDependencies?: string[];
}

export interface WorkspaceTechStack {
  packageManagers: string[];
  frameworks: string[];
  containerized: boolean;
  ciConfigured: boolean;
}

export interface WorkspaceInfo {
  generatedAt: string;
  root: string;
  fileCount: number;
  dirCount: number;
  languages: Record<string, number>;
  primaryLanguage?: string;
  tree: string;
  treeTruncated: boolean;
  techStack: WorkspaceTechStack;
  git: WorkspaceGitInfo;
  packageInfo?: WorkspacePackageInfo;
}

function getInfoPath(cwd: string): string {
  return path.join(cwd, INFO_PATH);
}

function renderTree(files: string[]): { tree: string; truncated: boolean } {
  const sorted = [...files].sort();
  const truncated = sorted.length > MAX_TREE_ENTRIES;
  const shown = sorted.slice(0, MAX_TREE_ENTRIES);

  // Ini-render ang directory path kasama ang pangalan ng file para mapanatili ang buong konteksto
  const lines = shown.map((f) => {
    const parts = f.split("/");
    const depth = parts.length - 1;
    const fileName = parts.pop();
    const dirPath = parts.join("/");

    const prefix = "  ".repeat(depth);
    const pathContext = dirPath ? ` (${dirPath}/)` : "";

    return `${prefix}${fileName}${pathContext}`;
  });

  if (truncated) {
    lines.push(
      `  … ${sorted.length - MAX_TREE_ENTRIES} more file(s) not shown (${sorted.length} total) — use glob_tool for a targeted listing.`
    );
  }
  return { tree: lines.join("\n"), truncated };
}

function detectFrameworks(cwd: string, files: string[]): string[] {
  const found = new Set<string>();
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const map: Record<string, string> = {
        react: "React",
        vue: "Vue",
        "@angular/core": "Angular",
        svelte: "Svelte",
        next: "Next.js",
        express: "Express",
        fastify: "Fastify",
        vite: "Vite",
        jest: "Jest",
        vitest: "Vitest",
        mocha: "Mocha",
        typescript: "TypeScript",
      };
      for (const [dep, label] of Object.entries(map)) {
        if (allDeps[dep]) found.add(label);
      }
    } catch {
      // sirang package.json — laktawan ang framework detection, huwag paganahing mabigo ang buong snapshot
    }
  }
  if (files.some((f) => f.endsWith("requirements.txt") || f.endsWith("pyproject.toml"))) {
    if (files.some((f) => /(^|\/)manage\.py$/.test(f))) found.add("Django");
    if (files.some((f) => /(^|\/)(app|main)\.py$/.test(f))) found.add("Flask/FastAPI (heuristic)");
  }
  return [...found];
}

function readGitInfo(cwd: string): WorkspaceGitInfo {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === undefined) return { isRepo: false };

  const remote = git(["remote", "get-url", "origin"]);
  const lastCommit = git(["log", "-1", "--format=%h %s"]);
  const status = git(["status", "--porcelain"]);

  return { isRepo: true, branch, remote, lastCommit, dirty: status !== undefined && status.length > 0 };
}

function readPackageInfo(cwd: string): WorkspacePackageInfo | undefined {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return {
      name: pkg.name,
      version: pkg.version,
      scripts: pkg.scripts ? Object.keys(pkg.scripts) : undefined,
      dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : undefined,
      devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Builds a fresh workspace snapshot. Does not touch the cache file — see refreshWorkspaceInfo. */
export async function buildWorkspaceInfo(cwd: string = process.cwd()): Promise<WorkspaceInfo> {
  const files = await globTool("**/*", cwd);
  const dirs = new Set<string>();
  const languages: Record<string, number> = {};
  for (const f of files) {
    const ext = path.extname(f).slice(1) || "(no ext)";
    languages[ext] = (languages[ext] ?? 0) + 1;
    const dir = path.dirname(f);
    if (dir !== ".") dirs.add(dir);
  }
  const primaryLanguage = Object.entries(languages).sort((a, b) => b[1] - a[1])[0]?.[0];
  const { tree, truncated } = renderTree(files);

  const has = (p: string) => fs.existsSync(path.join(cwd, p));
  const packageManagers = [
    has("package.json") && "npm/node",
    (has("requirements.txt") || has("pyproject.toml")) && "pip",
    has("go.mod") && "go modules",
    has("Cargo.toml") && "cargo",
    (has("pom.xml") || has("build.gradle")) && "maven/gradle",
    has("Gemfile") && "bundler",
  ].filter((x): x is string => Boolean(x));

  const techStack: WorkspaceTechStack = {
    packageManagers,
    frameworks: detectFrameworks(cwd, files),
    containerized: has("Dockerfile") || has("docker-compose.yml") || has("docker-compose.yaml"),
    ciConfigured: files.some((f) => f.startsWith(".github/workflows/")) || has(".gitlab-ci.yml") || has("Jenkinsfile"),
  };

  return {
    generatedAt: new Date().toISOString(),
    root: cwd,
    fileCount: files.length,
    dirCount: dirs.size,
    languages,
    primaryLanguage,
    tree,
    treeTruncated: truncated,
    techStack,
    git: readGitInfo(cwd),
    packageInfo: readPackageInfo(cwd),
  };
}

/** Reads the last cached snapshot from disk, if one exists. Does not rebuild. */
export function readCachedWorkspaceInfo(cwd: string = process.cwd()): WorkspaceInfo | undefined {
  const p = getInfoPath(cwd);
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as WorkspaceInfo;
  } catch {
    return undefined;
  }
}

/** Rebuilds the snapshot and writes it to .agent/workspace-info.json. This is the "refresh". */
export async function refreshWorkspaceInfo(cwd: string = process.cwd()): Promise<WorkspaceInfo> {
  const info = await buildWorkspaceInfo(cwd);
  const p = getInfoPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(info, null, 2), "utf-8");
  return info;
}

/** Compact, LLM-facing text rendering — this is what goes into the system prompt, not the raw JSON. */
export function summarizeWorkspaceInfo(info: WorkspaceInfo): string {
  const topLanguages = Object.entries(info.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext, count]) => `${ext} (${count})`)
    .join(", ");

  const gitLine = info.git.isRepo
    ? `branch \`${info.git.branch}\`${info.git.dirty ? ", uncommitted changes present" : ", clean"}${info.git.lastCommit ? `, last commit: ${info.git.lastCommit}` : ""}${info.git.remote ? `, remote: ${info.git.remote}` : ""}`
    : "not a git repository";

  const pkgLine = info.packageInfo
    ? `${info.packageInfo.name ?? "(unnamed)"}@${info.packageInfo.version ?? "?"}` +
    (info.packageInfo.scripts?.length ? ` — scripts: ${info.packageInfo.scripts.join(", ")}` : "")
    : "no package.json";

  return (
    `### Workspace context (auto-refreshed at the start of this task)\n` +
    `Root: ${info.root}\n` +
    `${info.fileCount} files across ${info.dirCount} directories. Top languages by file count: ${topLanguages || "(none detected)"}.\n` +
    `Package manager(s): ${info.techStack.packageManagers.join(", ") || "none detected"}. ` +
    `Frameworks: ${info.techStack.frameworks.join(", ") || "none detected"}. ` +
    `Containerized: ${info.techStack.containerized ? "yes" : "no"}. CI configured: ${info.techStack.ciConfigured ? "yes" : "no"}.\n` +
    `Git: ${gitLine}.\n` +
    `Package: ${pkgLine}.\n` +
    `Top-level structure${info.treeTruncated ? " (truncated)" : ""}:\n${info.tree}\n\n` +
    `This snapshot was generated at ${info.generatedAt}. If it seems stale — after installing a ` +
    `dependency, creating/deleting files, or switching branches — call workspace_info_tool with ` +
    `refresh=true to regenerate it rather than relying on this initial snapshot.`
  );
}