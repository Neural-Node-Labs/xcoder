// ronin:version 3 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:52:50.240Z | ronin:subtask code-st-5a7e6a
import { ToolCall } from "../core/types.js";
import { TOOL_SCHEMAS } from "./toolSchemas.js";
import { globTool } from "./globTool.js";
import { grepTool } from "./grepTool.js";
import { readTool } from "./readTool.js";
import { writeFile, editFile } from "./writeEditTool.js";
import { runCommand } from "./runCommandTool.js";
import { sshExec, scpUpload, scpDownload, SshTarget } from "./sshTool.js";
import { scheduleCron, scheduleOnce, listScheduled, removeScheduled } from "./scheduleTool.js";
import { runPlaywrightTest } from "./playwrightTool.js";
import { crawlAndGeneratePlaywrightTest } from "./crawlPlaywrightTool.js";
import { summarizeUrl } from "./summarizeUrlTool.js";
import { testApiEndpoint } from "./apiTestTool.js";
import { sshCopy } from "./sshCopyTool.js";
import { sshRunCommand } from "./sshRunCommandTool.js";
import { crawlSiteMap, formatSiteMap } from "./siteCrawlerTool.js";
import { loadRemoteConfig } from "../remote/config.js";
import { githubClone, githubFetch, githubPull, githubStatus, githubCommit, githubPush } from "./githubTool.js";
import { dockerComposeUp } from "./dockerComposeDeployTool.js";
import { rebuildIndex, readIndexedFile } from "./indexingTool.js";
import { getWorkspaceInfo } from "./workspaceInfoTool.js";
import { readTaskHistory, searchTaskHistory } from "../core/taskHistory.js";
import { handler as listDirectoryHandler } from "./listDirectoryTool.js";
import { handler as findFilesHandler } from "./findFilesTool.js";
import { handler as getDependencyGraphHandler } from "./getDependencyGraphTool.js";
import { handler as searchCodeHandler } from "./searchCodeTool.js";
import { handler as searchAstHandler } from "./searchAstTool.js";
import { handler as readOutlineHandler } from "./readOutlineTool.js";
import { handler as readFileRangeHandler } from "./readFileRangeTool.js";
import { handler as readMultipleFilesHandler } from "./readMultipleFilesTool.js";
import { handler as readFullFileHandler } from "./readFullFileTool.js";
import { handler as gitDiffHandler } from "./gitDiffTool.js";
import { handler as gitLogHandler } from "./gitLogTool.js";
import { handler as searchReplaceBlockHandler } from "./searchReplaceBlockTool.js";
import { handler as sedReplaceHandler } from "./sedReplaceTool.js";
import { handler as sedReplaceMultiHandler } from "./sedReplaceMultiTool.js";
import { handler as linePatchHandler } from "./linePatchTool.js";
import { handler as updateFunctionHandler } from "./updateFunctionTool.js";
import { handler as renameSymbolHandler } from "./renameSymbolTool.js";
import { handler as applyUnifiedDiffHandler } from "./applyUnifiedDiffTool.js";
import { handler as writeFileToolHandler } from "./writeFileTool.js";
import { handler as validateFileHandler } from "./validateFileTool.js";

/**
 * Attempts to parse JSON with automatic repair for common LLM generation errors.
 *
 * Strategy (tried in order):
 * 1. Fast path: native JSON.parse() — succeeds for well-formed JSON
 * 2. Repair path: on failure, attempts to fix common issues:
 *    a. Unescaped double quotes inside string values (the most common LLM error)
 *    b. Truncated/malformed strings near the end of the JSON
 *    c. Missing closing braces/brackets
 *
 * This is the primary defense against LLM-generated malformed JSON at the
 * tool dispatch boundary. The LLM's output cannot be directly controlled, so
 * we must be resilient to common JSON generation errors here.
 *
 * Exported for testing — the unit tests in tests/unit/toolDispatcher.test.ts
 * import this function directly to verify repair behavior.
 */
export function safeParseJson(raw: string): Record<string, unknown> {
  // Fast path: well-formed JSON
  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to repair path
  }

  // Repair path: attempt to fix common LLM JSON errors
  const repaired = attemptJsonRepair(raw);
  if (repaired !== null) {
    return repaired;
  }

  // Last resort: if all repair attempts fail, re-throw the original error
  // so the caller gets the original parse error message (most informative)
  return JSON.parse(raw);
}

/**
 * Attempts to repair common JSON malformations produced by LLMs.
 *
 * Known patterns repaired:
 * 1. Unescaped double quotes inside string values — the most common issue.
 *    LLMs often fail to escape `"` inside source code or text content.
 * 2. Truncated strings near the end of the JSON — missing closing quote.
 * 3. Missing closing braces/brackets at the end.
 *
 * Returns the parsed object on success, or null if repair failed.
 *
 * Exported for testing.
 */
export function attemptJsonRepair(raw: string): Record<string, unknown> | null {
  if (!raw || raw.length < 2) return null;

  let repaired = raw;

  // --- Repair 1: Fix unescaped double quotes inside string values ---
  //
  // Strategy: Walk through the string character by character, tracking
  // whether we're inside a string value. When we encounter a double quote
  // that would terminate a string prematurely (i.e., it's not preceded by
  // a backslash and is inside a value context), escape it.
  //
  // This is a heuristic — it can't be perfect without a full JSON parser,
  // but it handles the common case where the LLM puts unescaped quotes
  // inside string values like source code or file content.
  repaired = repairUnescapedQuotes(repaired);

  // --- Repair 2: Fix truncated strings (missing closing quote at end) ---
  //
  // If the JSON ends with an unterminated string (no closing quote before
  // EOF), append the missing quote.
  repaired = repairTruncatedString(repaired);

  // --- Repair 3: Fix missing closing braces/brackets ---
  //
  // If the JSON is missing closing braces/brackets at the end (common when
  // the LLM's output is truncated), count open/close and append what's needed.
  repaired = repairMissingClosers(repaired);

  // Try parsing the repaired JSON
  try {
    const result = JSON.parse(repaired);
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Repairs unescaped double quotes inside JSON string values.
 *
 * Walks through the JSON character by character, tracking string boundaries.
 * When a double quote is found inside a string value that isn't escaped,
 * it's escaped with a backslash.
 *
 * This handles the most common LLM JSON error: source code or text content
 * containing unescaped double quotes.
 *
 * Exported for testing.
 */
export function repairUnescapedQuotes(raw: string): string {
  const chars: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (escapeNext) {
      // Previous char was a backslash — this char is escaped
      chars.push(c);
      escapeNext = false;
      continue;
    }

    if (c === "\\") {
      chars.push(c);
      escapeNext = true;
      continue;
    }

    if (c === '"') {
      if (inString) {
        // We're inside a string and hit a double quote.
        // Check if this looks like a string terminator or an unescaped quote.
        // Heuristic: if the next non-whitespace char is one of: , ] } : or EOF,
        // it's likely a legitimate string terminator. Otherwise, escape it.
        const rest = raw.slice(i + 1).trimStart();
        if (rest.length === 0 || rest[0] === "," || rest[0] === "]" || rest[0] === "}" || rest[0] === ":") {
          // Legitimate string terminator
          chars.push(c);
          inString = false;
        } else {
          // Unescaped quote inside a string value — escape it
          chars.push("\\");
          chars.push(c);
        }
      } else {
        // Entering a new string
        chars.push(c);
        inString = true;
      }
      continue;
    }

    chars.push(c);
  }

  return chars.join("");
}

/**
 * Repairs a truncated JSON string — if the JSON ends while inside a string
 * value (no closing quote), appends the missing closing quote.
 *
 * Exported for testing.
 */
export function repairTruncatedString(raw: string): string {
  // Check if we're inside an unterminated string at the end
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (c === "\\") {
      escapeNext = true;
      continue;
    }

    if (c === '"') {
      inString = !inString;
    }
  }

  // If we're still inside a string at EOF, append the missing closing quote
  if (inString) {
    return raw + '"';
  }

  return raw;
}

/**
 * Repairs missing closing braces/brackets at the end of JSON.
 * Counts opening vs closing { } [ ] and appends what's missing.
 */
function repairMissingClosers(raw: string): string {
  let inString = false;
  let escapeNext = false;
  const stack: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (c === "\\") {
      escapeNext = true;
      continue;
    }

    if (c === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (c === "{") {
      stack.push("}");
    } else if (c === "[") {
      stack.push("]");
    } else if (c === "}" || c === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === c) {
        stack.pop();
      }
      // If mismatched closer, ignore (don't try to fix structural errors)
    }
  }

  // Append any missing closers in reverse order
  if (stack.length > 0) {
    return raw + stack.reverse().join("");
  }

  return raw;
}

export interface DispatchResult {
  toolCallId: string;
  toolName: string;
  observation: unknown;
  isError: boolean;
}

/**
 * Checks the call's arguments against that tool's declared `required` fields in
 * TOOL_SCHEMAS — reused rather than duplicated, so this can't drift out of sync with the
 * schemas the model actually sees. Catches cases like a `run_command_tool` call with `{}`
 * (missing `command`) before it reaches the tool implementation, where it would otherwise
 * crash with a raw, unhelpful runtime error (e.g. Node's "The \"file\" argument must be of
 * type string. Received undefined" from spawn()) that doesn't tell the model what it did wrong
 * or that it should retry with the missing field.
 */
function findMissingRequiredArgs(name: string, args: Record<string, unknown>): string[] {
  const schema = TOOL_SCHEMAS.find((s) => s.function.name === name);
  const required = schema?.function.parameters.required ?? [];
  return required.filter((key) => args[key] === undefined || args[key] === null || args[key] === "");
}

/**
 * Executes a single tool call requested by the LLM and returns the Observation
 * (or an error observation) to be fed back into the ReAct loop as a tool-role message.
 */
/**
 * Tool groups that can be disabled server-wide via env var, enforced HERE — the single choke
 * point every engine's tool calls pass through (see EngineRegistry.ts's engines, all of which
 * ultimately call dispatchToolCall for a real tool). Filtering only the TOOL_SCHEMAS list
 * offered to the LLM would be weaker: it would only stop the model from being told a tool
 * exists, not stop a call from actually running if some code path still requested it (a
 * subagent handed a custom tool list, a future engine that forgets to filter, a model that
 * "remembers" a tool name from an earlier turn's system prompt). Blocking at dispatch is the
 * real enforcement boundary regardless of what schema list was shown upstream.
 *
 * SECURITY CONTEXT: run_command_tool executes an arbitrary shell command with the full
 * privileges of the server process (see runCommandTool.ts — this is "unrestricted shell access
 * by design," not a bug). The ssh_ and docker_ tools extend that same unrestricted execution to
 * remote hosts. In a shared-infrastructure SaaS deployment where multiple tenants' tasks run
 * as the same OS user on the same filesystem, NO application-level check (this one included)
 * can fully prevent a task using these tools from reading/writing another tenant's files,
 * making arbitrary outbound network connections (including to cloud metadata endpoints), or
 * otherwise acting with the server process's full privileges. These kill switches let an
 * operator who has not yet set up per-tenant sandboxing (a container or microVM per task,
 * which is the only complete fix) disable the tools that make that gap exploitable, rather
 * than discovering the gap in production. See the security review notes for the full writeup.
 */
const SHELL_AND_REMOTE_EXEC_TOOLS = new Set([
  "run_command_tool",
  "ssh_tool",
  "ssh_copy_tool",
  "ssh_run_command",
  "docker_compose_deploy_tool",
  "docker_deploy_ssh_tool",
]);

const NETWORK_FETCH_TOOLS = new Set([
  "playwright_run_tool",
  "crawl_and_generate_playwright_test_tool",
  "crawl_site_mapper_tool",
  "summarize_url_tool",
  "api_test_tool",
  "github_tool",
]);

function disabledToolReason(name: string): string | undefined {
  if (SHELL_AND_REMOTE_EXEC_TOOLS.has(name) && /^(1|true)$/i.test(process.env.XCODER_DISABLE_SHELL_TOOLS ?? "")) {
    return `${name} is disabled on this server (XCODER_DISABLE_SHELL_TOOLS is set) — shell/remote-execution tools are unavailable until per-tenant sandboxing is configured.`;
  }
  if (NETWORK_FETCH_TOOLS.has(name) && /^(1|true)$/i.test(process.env.XCODER_DISABLE_NETWORK_TOOLS ?? "")) {
    return `${name} is disabled on this server (XCODER_DISABLE_NETWORK_TOOLS is set) — outbound-network tools are unavailable on this deployment.`;
  }
  return undefined;
}

export async function dispatchToolCall(call: ToolCall, cwd: string = process.cwd()): Promise<DispatchResult> {
  const name = call.function.name;
  let args: Record<string, any>;

  const disabledReason = disabledToolReason(name);
  if (disabledReason) {
    return { toolCallId: call.id, toolName: name, observation: { error: disabledReason }, isError: true };
  }

  try {
    args = safeParseJson(call.function.arguments || "{}");
  } catch (err) {
    return { toolCallId: call.id, toolName: name, observation: { error: `Invalid JSON arguments: ${err}` }, isError: true };
  }

  const missing = findMissingRequiredArgs(name, args);
  if (missing.length > 0) {
    return {
      toolCallId: call.id,
      toolName: name,
      observation: {
        error: `Missing required argument(s) for ${name}: ${missing.join(", ")}. The tool was not run — retry the call with all required fields filled in.`,
        providedArgs: args,
      },
      isError: true,
    };
  }

  try {
    switch (name) {
                case "clarification_tool": {
          // The clarification_tool is handled by the orchestrator/engine before dispatch.
          // If it reaches the dispatcher, it means the engine didn't intercept it — return
          // the clarification request as the observation so the engine can process it.
          return {
            toolCallId: call.id,
            toolName: name,
            observation: {
              type: "clarification_request",
              question: args.question,
              context: args.context,
              options: args.options,
              message: "Clarification requested — the engine should intercept this before dispatch."
            },
            isError: false,
          };
        }
case "conversation_tool": {
          // Print the response directly to the console so the user sees it immediately
          console.log(`\n🤖 xcoder: ${args.reply}`);

          return {
            toolCallId: call.id,
            toolName: name,
            observation: {
              status: "success",
              message: "Message successfully relayed to the user via terminal interface.",
              timestamp: new Date().toISOString()
            },
            isError: false,
          };
        }
      case "glob_tool": {
        const result = await globTool(args.pattern, cwd);
        return { toolCallId: call.id, toolName: name, observation: { files: result }, isError: false };
      }
      case "grep_tool": {
        const result = await grepTool(args.regex, args.globPattern ?? "**/*", cwd);
        return { toolCallId: call.id, toolName: name, observation: { matches: result }, isError: false };
      }
      case "read_tool": {
        const result = readTool(args.filePath, cwd);
        return { toolCallId: call.id, toolName: name, observation: { content: result }, isError: false };
      }
      case "write_edit_tool": {
        if (args.mode === "edit" && (args.oldStr === undefined || args.newStr === undefined)) {
          return {
            toolCallId: call.id,
            toolName: name,
            observation: { error: "write_edit_tool with mode='edit' requires both 'oldStr' and 'newStr'. The tool was not run.", providedArgs: args },
            isError: true,
          };
        }
        const result =
          args.mode === "write"
            ? writeFile(args.filePath, args.content ?? "", cwd)
            : editFile(args.filePath, args.oldStr, args.newStr, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "run_command_tool": {
        const result = await runCommand(args.command, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: result.exitCode !== 0 };
      }
      case "ssh_tool": {
        // Resolve credentials: prefer env-var names (safer), fall back to inline values
        const resolvedUser = args.userEnvVar ? (process.env[args.userEnvVar] ?? "") : (args.user ?? "");
        const resolvedPassword = args.passwordEnvVar ? (process.env[args.passwordEnvVar] ?? "") : undefined;
        const target: SshTarget = {
          host: args.host,
          user: resolvedUser,
          port: args.port,
          keyPath: args.keyPath,
          password: resolvedPassword,
        };
        let result;
        if (args.action === "exec") {
          result = await sshExec(target, args.command);
        } else if (args.action === "upload") {
          result = await scpUpload(target, args.localPath, args.remotePath, args.recursive);
        } else if (args.action === "download") {
          result = await scpDownload(target, args.remotePath, args.localPath, args.recursive);
        } else {
          return { toolCallId: call.id, toolName: name, observation: { error: `Unknown ssh_tool action: ${args.action}` }, isError: true };
        }
        return { toolCallId: call.id, toolName: name, observation: result, isError: result.exitCode !== 0 };
      }
      case "schedule_task_tool": {
        switch (args.action) {
          case "add": {
            const r = await scheduleCron(args.id, args.cronExpr, args.command);
            return { toolCallId: call.id, toolName: name, observation: r, isError: false };
          }
          case "once": {
            const r = await scheduleOnce(args.delaySeconds, args.command);
            return { toolCallId: call.id, toolName: name, observation: r, isError: false };
          }
          case "list": {
            const r = await listScheduled();
            return { toolCallId: call.id, toolName: name, observation: { jobs: r }, isError: false };
          }
          case "remove": {
            const r = await removeScheduled(args.id);
            return { toolCallId: call.id, toolName: name, observation: r, isError: !r.removed };
          }
          default:
            return { toolCallId: call.id, toolName: name, observation: { error: `Unknown schedule_task_tool action: ${args.action}` }, isError: true };
        }
      }
      case "playwright_run_tool": {
        const result = await runPlaywrightTest(args.scriptPath, args.cwd ?? cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: result.exitCode !== 0 };
      }
      case "crawl_and_generate_playwright_test_tool": {
        const result = await crawlAndGeneratePlaywrightTest(args.url, args.outputPath, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "ssh_copy_tool": {
        const remoteConfig = loadRemoteConfig();
        if (!remoteConfig) {
          return {
            toolCallId: call.id,
            toolName: name,
            observation: {
              error:
                "No remote fleet configured. Set XCODER_SSH_TARGETS (and XCODER_SSH_USER/XCODER_SSH_PASSWORD) to use ssh_copy_tool.",
            },
            isError: true,
          };
        }
        const result = await sshCopy(remoteConfig, cwd, { localPath: args.localPath, remotePath: args.remotePath, target: args.target });
        return { toolCallId: call.id, toolName: name, observation: result, isError: !result.ok };
      }
      case "ssh_run_command": {
        const remoteConfig = loadRemoteConfig();
        if (!remoteConfig) {
          return {
            toolCallId: call.id,
            toolName: name,
            observation: {
              error:
                "No remote fleet configured. Set XCODER_SSH_TARGETS (and XCODER_SSH_USER/XCODER_SSH_PASSWORD) to use ssh_run_command.",
            },
            isError: true,
          };
        }
        const result = await sshRunCommand(remoteConfig, { command: args.command, target: args.target });
        return { toolCallId: call.id, toolName: name, observation: result, isError: !result.ok };
      }
      case "crawl_site_mapper_tool": {
        const result = await crawlSiteMap(args.url, {
          maxPages: args.maxPages ?? 50,
          maxDepth: args.maxDepth ?? 5,
          sameDomain: args.sameDomain ?? true,
        });
        const formatted = formatSiteMap(result);
        return {
          toolCallId: call.id,
          toolName: name,
          observation: { siteMap: result, formatted },
          isError: false,
        };
      }
      case "github_tool": {
        let result;
        switch (args.action) {
          case "clone":
            result = await githubClone(args.repoUrl, args.repoDir ?? args.targetDir, args.branch);
            break;
          case "fetch":
            result = await githubFetch(args.repoDir, args.remote);
            break;
          case "pull":
            result = await githubPull(args.repoDir, args.remote, args.branch);
            break;
          case "status":
            result = await githubStatus(args.repoDir);
            break;
          case "commit":
            result = await githubCommit(args.repoDir, args.message, args.files);
            break;
          case "push":
            result = await githubPush(args.repoDir, args.remote, args.branch);
            break;
          default:
            return { toolCallId: call.id, toolName: name, observation: { error: `Unknown github_tool action: ${args.action}` }, isError: true };
        }
        return { toolCallId: call.id, toolName: name, observation: result, isError: result.exitCode !== 0 };
      }
      case "docker_compose_deploy_tool": {
        const result = await dockerComposeUp(args.projectDir, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: result.exitCode !== 0 };
      }
      case "docker_deploy_ssh_tool": {
        // Dynamic import with cache-busting so newly compiled code is picked up without restart
        const { deployWorkspaceViaSsh } = await import("./dockerDeploySshTool.js?t=" + Date.now());
        // Resolve credentials: prefer env-var names (safer), fall back to inline values
        const resolvedUser = args.userEnvVar ? (process.env[args.userEnvVar] ?? "") : (args.user ?? "");
        const resolvedPassword = args.passwordEnvVar ? (process.env[args.passwordEnvVar] ?? "") : undefined;
        const result = await deployWorkspaceViaSsh({
          host: args.host,
          user: resolvedUser,
          password: resolvedPassword,
          port: args.port,
          keyPath: args.keyPath,
          remotePath: args.remotePath,
          dockerCommand: args.dockerCommand,
          composeFile: args.composeFile,
          envFile: args.envFile,
          pullFromRegistry: args.pullFromRegistry,
          skipValidation: args.skipValidation,
          skipHealthCheck: args.skipHealthCheck,
          skipRollback: args.skipRollback,
          healthCheckTimeoutMs: args.healthCheckTimeoutMs,
          dockerCommandTimeoutMs: args.dockerCommandTimeoutMs,
        }, cwd);
        const isError = !result.success;
        return { toolCallId: call.id, toolName: name, observation: result, isError };
      }
      case "indexing_tool": {
        if (args.action === "rebuild") {
          const result = await rebuildIndex(cwd);
          return {
            toolCallId: call.id,
            toolName: name,
            observation: { entriesCount: result.entriesCount, generatedAt: result.generatedAt },
            isError: false,
          };
        } else if (args.action === "read") {
          if (!args.filepath) {
            return { toolCallId: call.id, toolName: name, observation: { error: "filepath is required when action='read'" }, isError: true };
          }
          const content = readIndexedFile(args.filepath, cwd);
          if (content === undefined) {
            return { toolCallId: call.id, toolName: name, observation: { error: `File '${args.filepath}' not found in index. Try rebuilding the index first.` }, isError: true };
          }
          return { toolCallId: call.id, toolName: name, observation: { content }, isError: false };
        } else {
          return { toolCallId: call.id, toolName: name, observation: { error: `Unknown indexing_tool action: ${args.action}. Use 'rebuild' or 'read'.` }, isError: true };
        }
      }
      case "workspace_info_tool": {
        const result = await getWorkspaceInfo(cwd, args.refresh === true);
        return {
          toolCallId: call.id,
          toolName: name,
          observation: { summary: result.summary, refreshed: result.refreshed, generatedAt: result.info.generatedAt },
          isError: false,
        };
      }
      case "task_history_tool": {
        if (args.action === "recent") {
          const tasks = readTaskHistory(cwd, args.limit ?? 5);
          return { toolCallId: call.id, toolName: name, observation: { tasks, count: tasks.length }, isError: false };
        } else if (args.action === "search") {
          if (!args.query) {
            return { toolCallId: call.id, toolName: name, observation: { error: "query is required when action='search'" }, isError: true };
          }
          const tasks = searchTaskHistory(cwd, args.query, args.limit ?? 5);
          return { toolCallId: call.id, toolName: name, observation: { tasks, count: tasks.length }, isError: false };
        } else {
          return { toolCallId: call.id, toolName: name, observation: { error: `Unknown task_history_tool action: ${args.action}. Use 'recent' or 'search'.` }, isError: true };
        }
      }
      case "save_plan_tool": {
        const { PlanStore } = await import("../api/planStore.js");
        const planStore = new PlanStore();
        try {
          const plan = await planStore.savePlan(args.taskDescription, args.planContent, args.tasks ?? []);
          return { toolCallId: call.id, toolName: name, observation: { plan, status: "saved" }, isError: false };
        } finally {
          await planStore.close();
        }
      }
      case "update_task_status_tool": {
        const { PlanStore } = await import("../api/planStore.js");
        const planStore = new PlanStore();
        try {
          const updated = await planStore.updateTaskStatus(args.taskId, args.status);
          if (!updated) {
            return { toolCallId: call.id, toolName: name, observation: { error: "Task not found" }, isError: true };
          }
          return { toolCallId: call.id, toolName: name, observation: { updated: true, taskId: args.taskId, status: args.status }, isError: false };
        } finally {
          await planStore.close();
        }
      }
      case "add_plan_task_tool": {
        const { PlanStore } = await import("../api/planStore.js");
        const planStore = new PlanStore();
        try {
          const task = await planStore.addTask(args.planId, args.description);
          if (!task) {
            return { toolCallId: call.id, toolName: name, observation: { error: "Plan not found" }, isError: true };
          }
          return { toolCallId: call.id, toolName: name, observation: { task, status: "added" }, isError: false };
        } finally {
          await planStore.close();
        }
      }
      case "delete_plan_task_tool": {
        const { PlanStore } = await import("../api/planStore.js");
        const planStore = new PlanStore();
        try {
          const deleted = await planStore.deleteTask(args.taskId);
          if (!deleted) {
            return { toolCallId: call.id, toolName: name, observation: { error: "Task not found" }, isError: true };
          }
          return { toolCallId: call.id, toolName: name, observation: { deleted: true, taskId: args.taskId }, isError: false };
        } finally {
          await planStore.close();
        }
      }
      case "summarize_url_tool": {
        const result = await summarizeUrl(args.url);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "api_test_tool": {
        const result = await testApiEndpoint({
          url: args.url,
          method: args.method,
          queryParams: args.queryParams,
          headers: args.headers,
          body: args.body,
          bodyType: args.bodyType,
          maxBodyLength: args.maxBodyLength,
          timeout: args.timeout,
          expectStatus: args.expectStatus,
          expectBodyContains: args.expectBodyContains,
        });

        // If expectStatus was set and doesn't match, return as error
        if (args.expectStatus !== undefined && result.statusCode !== args.expectStatus) {
          return {
            toolCallId: call.id,
            toolName: name,
            observation: {
              error: `Expected status ${args.expectStatus} but got ${result.statusCode}`,
              result,
            },
            isError: true,
          };
        }

        // If expectBodyContains was set and body doesn't contain it, return as error
        if (args.expectBodyContains !== undefined) {
          const bodyStr = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
          if (!bodyStr.includes(args.expectBodyContains)) {
            return {
              toolCallId: call.id,
              toolName: name,
              observation: {
                error: `Expected body to contain "${args.expectBodyContains}" but it did not`,
                result,
              },
              isError: true,
            };
          }
        }

        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "list_directory_tool": {
        const result = await listDirectoryHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "find_files_tool": {
        const result = await findFilesHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "get_dependency_graph_tool": {
        const result = await getDependencyGraphHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "search_code_tool": {
        const result = await searchCodeHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "search_ast_tool": {
        const result = await searchAstHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "read_outline_tool": {
        const result = await readOutlineHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "read_file_range_tool": {
        const result = await readFileRangeHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "read_multiple_files_tool": {
        const result = await readMultipleFilesHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "read_full_file_tool": {
        const result = await readFullFileHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "git_diff_tool": {
        const result = await gitDiffHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "git_log_tool": {
        const result = await gitLogHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "search_replace_block_tool": {
        const result = await searchReplaceBlockHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "sed_replace_tool": {
        const result = await sedReplaceHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "sed_replace_multi_tool": {
        const result = await sedReplaceMultiHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "line_patch_tool": {
        const result = await linePatchHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "update_function_tool": {
        const result = await updateFunctionHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "rename_symbol_tool": {
        const result = await renameSymbolHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "apply_unified_diff_tool": {
        const result = await applyUnifiedDiffHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "write_file_tool": {
        const result = await writeFileToolHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      case "validate_file_tool": {
        const result = await validateFileHandler(args as any, cwd);
        return { toolCallId: call.id, toolName: name, observation: result, isError: false };
      }
      default:
        return { toolCallId: call.id, toolName: name, observation: { error: `Unknown tool: ${name}` }, isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { toolCallId: call.id, toolName: name, observation: { error: message }, isError: true };
  }
}

