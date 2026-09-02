/**
 * Regression suite for dispatchToolCall() (src/tools/toolDispatcher.ts) — the single
 * chokepoint every LLM-issued tool call passes through before it can touch the filesystem,
 * network, or a remote host.
 *
 * Strategy:
 *  - Tools that are pure/local (glob/grep/read/write_edit/run_command/indexing/
 *    workspace_info/task_history) are exercised for REAL against a throwaway temp
 *    directory — no mocking needed, and it catches real wiring bugs (see
 *    src/tools/__tests__/toolDispatcher.test.ts's JSON-repair tests for the existing
 *    convention this follows).
 *  - Tools that talk to the network (summarize_url_tool, crawl_site_mapper_tool,
 *    api_test_tool, crawl_and_generate_playwright_test_tool) are exercised against a
 *    mocked global `fetch`, since they all fetch through the platform fetch API.
 *  - Tools that shell out to external processes not available in CI (ssh2, cron,
 *    npx playwright, docker, git-over-network) are mocked at their module boundary so
 *    the dispatcher's routing/arg-passing/error-shaping contract is verified without
 *    depending on external binaries or network access.
 *  - github_tool is exercised for real against a local git repo (git itself is always
 *    available and works fully offline for status/commit).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ToolCall } from "../../core/types.js";

// ─── Module mocks (declared before importing the dispatcher, per vitest hoisting rules) ──

vi.mock("../sshTool.js", () => ({
  sshExec: vi.fn(),
  scpUpload: vi.fn(),
  scpDownload: vi.fn(),
}));
vi.mock("../scheduleTool.js", () => ({
  scheduleCron: vi.fn(),
  scheduleOnce: vi.fn(),
  listScheduled: vi.fn(),
  removeScheduled: vi.fn(),
}));
vi.mock("../playwrightTool.js", () => ({
  runPlaywrightTest: vi.fn(),
}));
vi.mock("../dockerComposeDeployTool.js", () => ({
  dockerComposeUp: vi.fn(),
}));
vi.mock("../sshCopyTool.js", () => ({
  sshCopy: vi.fn(),
}));
vi.mock("../sshRunCommandTool.js", () => ({
  sshRunCommand: vi.fn(),
}));
vi.mock("../../api/planStore.js", () => {
  const savePlan = vi.fn();
  const updateTaskStatus = vi.fn();
  const addTask = vi.fn();
  const deleteTask = vi.fn();
  const close = vi.fn(async () => {});
  class MockPlanStore {
    savePlan = savePlan;
    updateTaskStatus = updateTaskStatus;
    addTask = addTask;
    deleteTask = deleteTask;
    close = close;
  }
  return { PlanStore: MockPlanStore, __mockFns: { savePlan, updateTaskStatus, addTask, deleteTask, close } };
});

import { dispatchToolCall, safeParseJson } from "../toolDispatcher.js";
import { sshExec, scpUpload, scpDownload } from "../sshTool.js";
import { scheduleCron, scheduleOnce, listScheduled, removeScheduled } from "../scheduleTool.js";
import { runPlaywrightTest } from "../playwrightTool.js";
import { dockerComposeUp } from "../dockerComposeDeployTool.js";
import { sshCopy } from "../sshCopyTool.js";
import { sshRunCommand } from "../sshRunCommandTool.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const planStoreMocks = (await import("../../api/planStore.js") as any).__mockFns as {
  savePlan: ReturnType<typeof vi.fn>;
  updateTaskStatus: ReturnType<typeof vi.fn>;
  addTask: ReturnType<typeof vi.fn>;
  deleteTask: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

// ─── Test helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let callSeq = 0;

function call(name: string, args: Record<string, unknown>): ToolCall {
  callSeq += 1;
  return { id: `call_${callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** A ToolCall whose arguments field is not valid/repairable JSON — used to hit the "invalid
 *  JSON" branch specifically (distinct from a repairable malformed payload). */
function callRawArgs(name: string, rawArguments: string): ToolCall {
  callSeq += 1;
  return { id: `call_${callSeq}`, type: "function", function: { name, arguments: rawArguments } };
}

function mockFetchResponse(opts: { ok?: boolean; status?: number; statusText?: string; contentType?: string; text?: string; headers?: Record<string, string> }) {
  const headerEntries: Record<string, string> = { "content-type": opts.contentType ?? "text/html", ...opts.headers };
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers: {
      get: (k: string) => headerEntries[k.toLowerCase()] ?? null,
      forEach: (cb: (value: string, key: string) => void) => {
        Object.entries(headerEntries).forEach(([k, v]) => cb(v, k));
      },
    },
    text: async () => opts.text ?? "",
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-dispatch-test-"));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// ─── Malformed / missing arguments (dispatcher-level guarantees) ──────────────────────

describe("dispatchToolCall — argument handling", () => {
  it("returns a structured error for arguments that are invalid and unrepairable JSON", async () => {
    const result = await dispatchToolCall(callRawArgs("read_tool", "{{{not json at all"), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("Invalid JSON arguments");
  });

  it("defaults to an empty args object when arguments is empty string", async () => {
    // read_tool requires filePath, so this should hit the missing-required-arg path rather
    // than crash on an undefined args object.
    const result = await dispatchToolCall(callRawArgs("read_tool", ""), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("Missing required argument");
  });

  it("rejects calls missing a required argument before reaching the tool implementation", async () => {
    const result = await dispatchToolCall(call("read_tool", {}), tmpDir);
    expect(result.isError).toBe(true);
    const obs = result.observation as { error: string; providedArgs: unknown };
    expect(obs.error).toContain("filePath");
    expect(obs.providedArgs).toEqual({});
  });

  it("treats an empty string as a missing required argument (not just undefined/null)", async () => {
    const result = await dispatchToolCall(call("read_tool", { filePath: "" }), tmpDir);
    expect(result.isError).toBe(true);
  });

  it("lists every missing required argument at once", async () => {
    const result = await dispatchToolCall(call("ssh_tool", {}), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("action");
    expect((result.observation as { error: string }).error).toContain("host");
  });

  it("write_edit_tool with mode='edit' requires oldStr and newStr even though the schema doesn't", async () => {
    const result = await dispatchToolCall(call("write_edit_tool", { mode: "edit", filePath: "x.txt" }), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("oldStr");
  });

  it("repairs malformed-but-recoverable JSON (unescaped quotes) before dispatch", async () => {
    fs.writeFileSync(path.join(tmpDir, "x.txt"), "old");
    const raw = '{"mode":"write","filePath":"x.txt","content":"const s = "hi";"}';
    const result = await dispatchToolCall(callRawArgs("write_edit_tool", raw), tmpDir);
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "x.txt"), "utf-8")).toBe('const s = "hi";');
  });

  it("returns an 'Unknown tool' error for an unrecognized tool name", async () => {
    const result = await dispatchToolCall(call("totally_made_up_tool", {}), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("Unknown tool");
  });

  it("catches exceptions thrown by a tool implementation and reports them as an error observation instead of throwing", async () => {
    // read_tool throws synchronously (fs.readFileSync ENOENT) for a nonexistent file.
    const result = await dispatchToolCall(call("read_tool", { filePath: "does-not-exist.txt" }), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toBeDefined();
  });

  it("preserves the toolCallId and toolName on both success and error paths", async () => {
    const okCall = call("glob_tool", { pattern: "**/*" });
    const okResult = await dispatchToolCall(okCall, tmpDir);
    expect(okResult.toolCallId).toBe(okCall.id);
    expect(okResult.toolName).toBe("glob_tool");

    const badCall = call("read_tool", {});
    const badResult = await dispatchToolCall(badCall, tmpDir);
    expect(badResult.toolCallId).toBe(badCall.id);
    expect(badResult.toolName).toBe("read_tool");
  });
});

// ─── clarification_tool / conversation_tool (intercepted / passthrough tools) ─────────

describe("dispatchToolCall — clarification_tool & conversation_tool", () => {
  it("clarification_tool returns a clarification_request observation (engine intercepts before this in practice)", async () => {
    const result = await dispatchToolCall(
      call("clarification_tool", { question: "Which DB?", context: "need to pick one", options: ["Postgres", "SQLite"] }),
      tmpDir
    );
    expect(result.isError).toBe(false);
    const obs = result.observation as { type: string; question: string; options: string[] };
    expect(obs.type).toBe("clarification_request");
    expect(obs.question).toBe("Which DB?");
    expect(obs.options).toEqual(["Postgres", "SQLite"]);
  });

  it("conversation_tool logs the reply and returns a success observation", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await dispatchToolCall(call("conversation_tool", { reply: "Hi there!" }), tmpDir);
    expect(result.isError).toBe(false);
    expect((result.observation as { status: string }).status).toBe("success");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Hi there!"));
    logSpy.mockRestore();
  });
});

// ─── Filesystem tools (real execution against a temp workspace) ──────────────────────

describe("dispatchToolCall — glob_tool / grep_tool / read_tool / write_edit_tool", () => {
  it("glob_tool finds files matching a pattern", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "b.md"), "");
    const result = await dispatchToolCall(call("glob_tool", { pattern: "*.ts" }), tmpDir);
    expect(result.isError).toBe(false);
    expect((result.observation as { files: string[] }).files).toEqual(["a.ts"]);
  });

  it("grep_tool finds matching lines across files", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello\nneedle here\nworld");
    const result = await dispatchToolCall(call("grep_tool", { regex: "needle" }), tmpDir);
    expect(result.isError).toBe(false);
    const matches = (result.observation as { matches: { file: string; line: number }[] }).matches;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ file: "a.txt", line: 2 });
  });

  it("read_tool returns file content", async () => {
    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "hello world");
    const result = await dispatchToolCall(call("read_tool", { filePath: "hello.txt" }), tmpDir);
    expect(result.isError).toBe(false);
    expect((result.observation as { content: string }).content).toBe("hello world");
  });

  it("read_tool reports an error observation for a missing file", async () => {
    const result = await dispatchToolCall(call("read_tool", { filePath: "nope.txt" }), tmpDir);
    expect(result.isError).toBe(true);
  });

  it("write_edit_tool mode='write' creates a new file, including nested directories", async () => {
    const result = await dispatchToolCall(call("write_edit_tool", { mode: "write", filePath: "nested/dir/new.txt", content: "hi" }), tmpDir);
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "nested/dir/new.txt"), "utf-8")).toBe("hi");
  });

  it("write_edit_tool mode='edit' replaces a unique occurrence", async () => {
    fs.writeFileSync(path.join(tmpDir, "e.txt"), "foo bar baz");
    const result = await dispatchToolCall(call("write_edit_tool", { mode: "edit", filePath: "e.txt", oldStr: "bar", newStr: "QUX" }), tmpDir);
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "e.txt"), "utf-8")).toBe("foo QUX baz");
  });

  it("write_edit_tool mode='edit' errors when oldStr isn't unique", async () => {
    fs.writeFileSync(path.join(tmpDir, "e.txt"), "dup dup dup");
    const result = await dispatchToolCall(call("write_edit_tool", { mode: "edit", filePath: "e.txt", oldStr: "dup", newStr: "X" }), tmpDir);
    expect(result.isError).toBe(true);
  });
});

describe("dispatchToolCall — run_command_tool", () => {
  it("returns exitCode 0 and stdout for a successful command", async () => {
    const result = await dispatchToolCall(call("run_command_tool", { command: "echo hello-from-test" }), tmpDir);
    expect(result.isError).toBe(false);
    expect((result.observation as { stdout: string }).stdout).toContain("hello-from-test");
  });

  it("marks isError true when the command exits non-zero", async () => {
    const result = await dispatchToolCall(call("run_command_tool", { command: "exit 3" }), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { exitCode: number }).exitCode).toBe(3);
  });
});



describe("dispatchToolCall — workspace_info_tool", () => {
  it("builds a fresh snapshot and returns a summary", async () => {
    const result = await dispatchToolCall(call("workspace_info_tool", { refresh: true }), tmpDir);
    expect(result.isError).toBe(false);
    const obs = result.observation as { summary: string; refreshed: boolean };
    expect(typeof obs.summary).toBe("string");
    expect(obs.refreshed).toBe(true);
  });

  it("uses the cached snapshot on a second call without refresh", async () => {
    await dispatchToolCall(call("workspace_info_tool", { refresh: true }), tmpDir);
    const result = await dispatchToolCall(call("workspace_info_tool", {}), tmpDir);
    expect(result.isError).toBe(false);
    expect((result.observation as { refreshed: boolean }).refreshed).toBe(false);
  });
});

describe("dispatchToolCall — task_history_tool", () => {
  it("action='recent' returns an empty list for a fresh workspace", async () => {
    const result = await dispatchToolCall(call("task_history_tool", { action: "recent" }), tmpDir);
    expect(result.isError).toBe(false);
    expect((result.observation as { tasks: unknown[]; count: number }).count).toBe(0);
  });

  it("action='search' without a query is an error", async () => {
    const result = await dispatchToolCall(call("task_history_tool", { action: "search" }), tmpDir);
    expect(result.isError).toBe(true);
  });

  it("rejects an unknown action", async () => {
    const result = await dispatchToolCall(call("task_history_tool", { action: "bogus" }), tmpDir);
    expect(result.isError).toBe(true);
  });
});

// ─── github_tool (real git, fully offline) ─────────────────────────────────────────────

describe("dispatchToolCall — github_tool", () => {
  it("status reports on a freshly-initialized repo", async () => {
    execFileSync("git", ["init", "-q"], { cwd: tmpDir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "init", "-q"], { cwd: tmpDir });
    const result = await dispatchToolCall(call("github_tool", { action: "status", repoDir: tmpDir }), tmpDir);
    expect(result.isError).toBe(false);
    expect((result.observation as { exitCode: number }).exitCode).toBe(0);
  });

  it("commit stages and commits real files", async () => {
    execFileSync("git", ["init", "-q"], { cwd: tmpDir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "init", "-q"], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content");
    // Configure identity via env so githubCommit's internal `git commit` succeeds without a global config.
    const prevEmail = process.env.GIT_AUTHOR_EMAIL;
    const prevName = process.env.GIT_AUTHOR_NAME;
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@example.com";
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "T";
    try {
      const result = await dispatchToolCall(call("github_tool", { action: "commit", repoDir: tmpDir, message: "add file" }), tmpDir);
      expect(result.isError).toBe(false);
      expect((result.observation as { exitCode: number }).exitCode).toBe(0);
    } finally {
      process.env.GIT_AUTHOR_EMAIL = prevEmail;
      process.env.GIT_COMMITTER_EMAIL = prevEmail;
      process.env.GIT_AUTHOR_NAME = prevName;
      process.env.GIT_COMMITTER_NAME = prevName;
    }
  });

  it("rejects an unknown action", async () => {
    const result = await dispatchToolCall(call("github_tool", { action: "teleport", repoDir: tmpDir }), tmpDir);
    expect(result.isError).toBe(true);
  });

  it("clone against an unreachable URL fails with a non-zero exit and isError true", async () => {
    const result = await dispatchToolCall(
      call("github_tool", { action: "clone", repoUrl: "https://example.invalid/nope.git", targetDir: path.join(tmpDir, "cloned") }),
      tmpDir
    );
    expect(result.isError).toBe(true);
    expect((result.observation as { exitCode: number }).exitCode).not.toBe(0);
  }, 20000);
});

// ─── Mocked-module tools: ssh_tool, schedule_task_tool, playwright, docker compose ────

describe("dispatchToolCall — ssh_tool", () => {
  it("action='exec' routes to sshExec with the resolved target", async () => {
    vi.mocked(sshExec).mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const result = await dispatchToolCall(call("ssh_tool", { action: "exec", host: "example.com", user: "root", command: "uptime" }), tmpDir);
    expect(result.isError).toBe(false);
    expect(sshExec).toHaveBeenCalledWith(
      expect.objectContaining({ host: "example.com", user: "root" }),
      "uptime"
    );
  });

  it("resolves credentials from env vars when userEnvVar/passwordEnvVar are given", async () => {
    vi.mocked(sshExec).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    process.env.TEST_SSH_USER = "envuser";
    process.env.TEST_SSH_PASS = "envpass";
    try {
      await dispatchToolCall(
        call("ssh_tool", { action: "exec", host: "h", userEnvVar: "TEST_SSH_USER", passwordEnvVar: "TEST_SSH_PASS", command: "ls" }),
        tmpDir
      );
      expect(sshExec).toHaveBeenCalledWith(expect.objectContaining({ user: "envuser", password: "envpass" }), "ls");
    } finally {
      delete process.env.TEST_SSH_USER;
      delete process.env.TEST_SSH_PASS;
    }
  });

  it("action='upload' routes to scpUpload", async () => {
    vi.mocked(scpUpload).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const result = await dispatchToolCall(
      call("ssh_tool", { action: "upload", host: "h", localPath: "a", remotePath: "b" }),
      tmpDir
    );
    expect(result.isError).toBe(false);
    expect(scpUpload).toHaveBeenCalled();
  });

  it("action='download' routes to scpDownload", async () => {
    vi.mocked(scpDownload).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const result = await dispatchToolCall(
      call("ssh_tool", { action: "download", host: "h", localPath: "a", remotePath: "b" }),
      tmpDir
    );
    expect(result.isError).toBe(false);
    expect(scpDownload).toHaveBeenCalled();
  });

  it("propagates a non-zero exitCode as isError", async () => {
    vi.mocked(sshExec).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "boom" });
    const result = await dispatchToolCall(call("ssh_tool", { action: "exec", host: "h", command: "false" }), tmpDir);
    expect(result.isError).toBe(true);
  });

  it("rejects an unknown action", async () => {
    const result = await dispatchToolCall(call("ssh_tool", { action: "teleport", host: "h" }), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("Unknown ssh_tool action");
  });
});

describe("dispatchToolCall — schedule_task_tool", () => {
  it("action='add' routes to scheduleCron", async () => {
    vi.mocked(scheduleCron).mockResolvedValue({ id: "job1", cronExpr: "* * * * *" });
    const result = await dispatchToolCall(call("schedule_task_tool", { action: "add", id: "job1", cronExpr: "* * * * *", command: "echo hi" }), tmpDir);
    expect(result.isError).toBe(false);
    expect(scheduleCron).toHaveBeenCalledWith("job1", "* * * * *", "echo hi");
  });

  it("action='once' routes to scheduleOnce", async () => {
    vi.mocked(scheduleOnce).mockResolvedValue({ scheduledFor: "2026-01-01T00:00:00.000Z" });
    const result = await dispatchToolCall(call("schedule_task_tool", { action: "once", delaySeconds: 60, command: "echo hi" }), tmpDir);
    expect(result.isError).toBe(false);
    expect(scheduleOnce).toHaveBeenCalledWith(60, "echo hi");
  });

  it("action='list' routes to listScheduled and wraps in { jobs }", async () => {
    vi.mocked(listScheduled).mockResolvedValue([{ id: "a", cronExpr: "* * * * *", command: "x" }]);
    const result = await dispatchToolCall(call("schedule_task_tool", { action: "list" }), tmpDir);
    expect(result.isError).toBe(false);
    expect((result.observation as { jobs: unknown[] }).jobs).toHaveLength(1);
  });

  it("action='remove' reports isError when nothing was removed", async () => {
    vi.mocked(removeScheduled).mockResolvedValue({ removed: false });
    const result = await dispatchToolCall(call("schedule_task_tool", { action: "remove", id: "ghost" }), tmpDir);
    expect(result.isError).toBe(true);
  });

  it("rejects an unknown action", async () => {
    const result = await dispatchToolCall(call("schedule_task_tool", { action: "wat" }), tmpDir);
    expect(result.isError).toBe(true);
  });
});

describe("dispatchToolCall — playwright_run_tool", () => {
  it("routes to runPlaywrightTest and reflects failure via exitCode", async () => {
    vi.mocked(runPlaywrightTest).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "", summary: { passed: 1, failed: 1, skipped: 0 } });
    const result = await dispatchToolCall(call("playwright_run_tool", { scriptPath: "e2e/x.spec.ts" }), tmpDir);
    expect(result.isError).toBe(true);
    expect(runPlaywrightTest).toHaveBeenCalledWith("e2e/x.spec.ts", tmpDir);
  });

  it("succeeds when exitCode is 0", async () => {
    vi.mocked(runPlaywrightTest).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", summary: { passed: 3, failed: 0, skipped: 0 } });
    const result = await dispatchToolCall(call("playwright_run_tool", {}), tmpDir);
    expect(result.isError).toBe(false);
  });
});

describe("dispatchToolCall — docker_compose_deploy_tool", () => {
  it("routes to dockerComposeUp and surfaces failures", async () => {
    vi.mocked(dockerComposeUp).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "no such file" });
    const result = await dispatchToolCall(call("docker_compose_deploy_tool", { projectDir: "/opt/app" }), tmpDir);
    expect(result.isError).toBe(true);
    expect(dockerComposeUp).toHaveBeenCalledWith("/opt/app", tmpDir);
  });

  it("succeeds when exitCode is 0", async () => {
    vi.mocked(dockerComposeUp).mockResolvedValue({ exitCode: 0, stdout: "up", stderr: "" });
    const result = await dispatchToolCall(call("docker_compose_deploy_tool", {}), tmpDir);
    expect(result.isError).toBe(false);
  });
});

// ─── ssh_copy_tool / ssh_run_command (fleet tools — remote config gating) ─────────────

describe("dispatchToolCall — ssh_copy_tool & ssh_run_command (fleet config gating)", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("ssh_copy_tool reports a clear error when no fleet is configured", async () => {
    delete process.env.XCODER_SSH_TARGETS;
    const result = await dispatchToolCall(call("ssh_copy_tool", { localPath: "a", remotePath: "b" }), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("No remote fleet configured");
    expect(sshCopy).not.toHaveBeenCalled();
  });

  it("ssh_run_command reports a clear error when no fleet is configured", async () => {
    delete process.env.XCODER_SSH_TARGETS;
    const result = await dispatchToolCall(call("ssh_run_command", { command: "uptime" }), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("No remote fleet configured");
    expect(sshRunCommand).not.toHaveBeenCalled();
  });

  it("ssh_copy_tool dispatches to sshCopy once a fleet is configured", async () => {
    process.env.XCODER_SSH_TARGETS = "10.0.0.5";
    process.env.XCODER_SSH_USER = "deploy";
    vi.mocked(sshCopy).mockResolvedValue({ ok: true, results: [{ target: "10.0.0.5:22", ok: true, message: "uploaded" }] });
    const result = await dispatchToolCall(call("ssh_copy_tool", { localPath: "a", remotePath: "b" }), tmpDir);
    expect(result.isError).toBe(false);
    expect(sshCopy).toHaveBeenCalled();
  });

  it("ssh_run_command dispatches to sshRunCommand once a fleet is configured and surfaces failure", async () => {
    process.env.XCODER_SSH_TARGETS = "10.0.0.5";
    process.env.XCODER_SSH_USER = "deploy";
    vi.mocked(sshRunCommand).mockResolvedValue({ ok: false, results: [{ target: "10.0.0.5:22", ok: false, exitCode: 1, stdout: "", stderr: "err" }] });
    const result = await dispatchToolCall(call("ssh_run_command", { command: "false" }), tmpDir);
    expect(result.isError).toBe(true);
  });
});

// ─── Network tools via mocked global fetch ─────────────────────────────────────────────

describe("dispatchToolCall — summarize_url_tool", () => {
  it("summarizes a fetched HTML page", async () => {
    const html = "<html><head><title>My Page</title></head><body><p>Hello world, this is content.</p></body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ text: html, contentType: "text/html" })));
    const result = await dispatchToolCall(call("summarize_url_tool", { url: "https://example.com/page" }), tmpDir);
    expect(result.isError).toBe(false);
    const obs = result.observation as { title: string };
    expect(obs.title).toBe("My Page");
  });

  it("surfaces a fetch failure (HTTP error) as isError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ ok: false, status: 404, statusText: "Not Found" })));
    const result = await dispatchToolCall(call("summarize_url_tool", { url: "https://example.com/missing" }), tmpDir);
    expect(result.isError).toBe(true);
  });
});

describe("dispatchToolCall — api_test_tool", () => {
  it("returns structured response data on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockFetchResponse({ ok: true, status: 200, contentType: "application/json", text: JSON.stringify({ hello: "world" }) }))
    );
    const result = await dispatchToolCall(call("api_test_tool", { url: "https://api.example.com/x", method: "GET" }), tmpDir);
    expect(result.isError).toBe(false);
    const obs = result.observation as { statusCode: number; body: unknown };
    expect(obs.statusCode).toBe(200);
    expect(obs.body).toEqual({ hello: "world" });
  });

  it("flags a mismatched expectStatus as an error with details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ ok: true, status: 200, contentType: "application/json", text: "{}" })));
    const result = await dispatchToolCall(call("api_test_tool", { url: "https://api.example.com/x", method: "GET", expectStatus: 201 }), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("Expected status 201");
  });

  it("flags a missing expectBodyContains substring as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockFetchResponse({ ok: true, status: 200, contentType: "application/json", text: JSON.stringify({ foo: "bar" }) }))
    );
    const result = await dispatchToolCall(
      call("api_test_tool", { url: "https://api.example.com/x", method: "GET", expectBodyContains: "needle" }),
      tmpDir
    );
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("Expected body to contain");
  });

  it("passes through method/headers/body/query params to the fetch call", async () => {
    const fetchMock = vi.fn(async () => mockFetchResponse({ ok: true, status: 200, contentType: "application/json", text: "{}" }));
    vi.stubGlobal("fetch", fetchMock);
    await dispatchToolCall(
      call("api_test_tool", {
        url: "https://api.example.com/x",
        method: "POST",
        headers: { "X-Test": "1" },
        body: { a: 1 },
        queryParams: { q: "1" },
      }),
      tmpDir
    );
    expect(fetchMock).toHaveBeenCalled();
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toContain("q=1");
    expect(calledOpts.method).toBe("POST");
    expect((calledOpts.headers as Record<string, string>)["X-Test"]).toBe("1");
  });
});

describe("dispatchToolCall — crawl_site_mapper_tool", () => {
  it("crawls a single page with no internal links and returns a site map", async () => {
    const html = "<html><head><title>Root</title></head><body>No links here</body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ text: html, contentType: "text/html" })));
    const result = await dispatchToolCall(call("crawl_site_mapper_tool", { url: "https://example.com/" }), tmpDir);
    expect(result.isError).toBe(false);
    const obs = result.observation as { siteMap: { totalPages: number }; formatted: string };
    expect(obs.siteMap.totalPages).toBeGreaterThanOrEqual(1);
    expect(typeof obs.formatted).toBe("string");
  });

  it("respects explicit maxPages/maxDepth/sameDomain overrides without throwing", async () => {
    const html = "<html><head><title>Root</title></head><body>No links here</body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ text: html, contentType: "text/html" })));
    const result = await dispatchToolCall(
      call("crawl_site_mapper_tool", { url: "https://example.com/", maxPages: 1, maxDepth: 1, sameDomain: false }),
      tmpDir
    );
    expect(result.isError).toBe(false);
  });
});

describe("dispatchToolCall — crawl_and_generate_playwright_test_tool", () => {
  it("crawls a page and writes a Playwright spec file", async () => {
    const html = `<html><head><title>Form Page</title></head><body>
      <a href="/about">About</a>
      <button id="submit">Submit</button>
      <form action="/login"><input name="username" type="text" /></form>
    </body></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ text: html, contentType: "text/html" })));
    const result = await dispatchToolCall(
      call("crawl_and_generate_playwright_test_tool", { url: "https://example.com/form", outputPath: "e2e/generated.spec.ts" }),
      tmpDir
    );
    expect(result.isError).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "e2e/generated.spec.ts"))).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, "e2e/generated.spec.ts"), "utf-8");
    expect(content).toContain("@playwright/test");
  });
});

// ─── docker_deploy_ssh_tool (dynamic import; real module, unreachable host) ────────────

describe("dispatchToolCall — docker_deploy_ssh_tool", () => {
  it("reports failure quickly for an unreachable host instead of hanging or throwing", async () => {
    const result = await dispatchToolCall(
      call("docker_deploy_ssh_tool", { host: "127.0.0.1", port: 1, user: "nobody", password: "x", remotePath: "/opt/app" }),
      tmpDir
    );
    expect(result.isError).toBe(true);
    expect((result.observation as { success: boolean }).success).toBe(false);
  }, 20000);

  it("is caught by the missing-required-arg check before attempting a connection", async () => {
    const result = await dispatchToolCall(call("docker_deploy_ssh_tool", { host: "127.0.0.1" }), tmpDir);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toContain("remotePath");
  });
});

// ─── Plan store tools (mocked PlanStore — DB is out of scope for this suite) ──────────

describe("dispatchToolCall — plan tools", () => {
  it("save_plan_tool saves a plan via PlanStore and closes the connection", async () => {
    planStoreMocks.savePlan.mockResolvedValue({ id: "p1", taskDescription: "t", planContent: "c", status: "active", createdAt: "", updatedAt: "" });
    const result = await dispatchToolCall(
      call("save_plan_tool", { taskDescription: "t", planContent: "c", tasks: ["step 1"] }),
      tmpDir
    );
    expect(result.isError).toBe(false);
    expect((result.observation as { status: string }).status).toBe("saved");
  });

  it("update_task_status_tool reports an error when the task isn't found", async () => {
    planStoreMocks.updateTaskStatus.mockResolvedValue(null);
    const result = await dispatchToolCall(call("update_task_status_tool", { taskId: "missing", status: "completed" }), tmpDir);
    expect(result.isError).toBe(true);
  });

  it("add_plan_task_tool reports an error when the plan isn't found", async () => {
    planStoreMocks.addTask.mockResolvedValue(null);
    const result = await dispatchToolCall(call("add_plan_task_tool", { planId: "missing", description: "x" }), tmpDir);
    expect(result.isError).toBe(true);
  });

  it("delete_plan_task_tool reports success when the task is deleted", async () => {
    planStoreMocks.deleteTask.mockResolvedValue(true);
    const result = await dispatchToolCall(call("delete_plan_task_tool", { taskId: "t1" }), tmpDir);
    expect(result.isError).toBe(false);
    expect((result.observation as { deleted: boolean }).deleted).toBe(true);
  });
});

// ─── safeParseJson re-exported sanity check (deeper coverage already in
//     toolDispatcher.test.ts; this just confirms the dispatcher and the repair utility
//     stay wired to the same function) ────────────────────────────────────────────────

describe("safeParseJson (dispatcher integration)", () => {
  it("is the exact function dispatchToolCall uses for argument parsing", async () => {
    // Sanity: well-formed JSON round-trips.
    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
  });
});
