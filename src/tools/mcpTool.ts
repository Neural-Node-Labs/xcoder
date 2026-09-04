/**
 * mcp_tool — a minimal Model Context Protocol (MCP) client so xcoder engines (in particular the
 * "assistant" chat engine, see EngineRegistry.ts) can discover and call tools exposed by any
 * MCP server, the same way an editor like Claude Desktop would. No SDK dependency: MCP's stdio
 * transport is just newline-delimited JSON-RPC 2.0 over a child process's stdin/stdout, so this
 * hand-rolls the handshake + one request/response round trip rather than pulling in
 * @modelcontextprotocol/sdk for what is, at xcoder's scope, a small and stable surface.
 *
 * Every call spawns a fresh server process, does the required `initialize` handshake, performs
 * exactly one operation (tools/list or tools/call), then shuts the process down. This trades a
 * little startup latency per call for zero long-lived process/state management — appropriate
 * for an agent tool that may go minutes between MCP calls.
 */

import { spawn } from "node:child_process";
import { resolveBundledMcpLaunch } from "../api/codegraphProcess.js";

export interface McpToolArgs {
  action: "list" | "call";
  command: string;
  args?: string[];
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /** Max time to wait for the server to respond before giving up. Default: 20s. */
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Speak just enough MCP over stdio to run one `initialize` + one follow-up request against a
 * freshly spawned server, then tear it down. Returns the follow-up request's `result`.
 */
function runMcpRequest(
  command: string,
  args: string[],
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  env?: Record<string, string>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env });

    let buffer = "";
    let settled = false;
    let initialized = false;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let nextId = 1;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`mcp_tool: timed out after ${timeoutMs}ms waiting for '${command} ${args.join(" ")}'`));
    }, timeoutMs);

    function send(m: string, p: Record<string, unknown>): Promise<unknown> {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }) + "\n");
      });
    }

    function finish(err: Error | null, value?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      if (err) reject(err); else resolve(value);
    }

    let stderrBuf = "";
    child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString(); });

    child.on("error", (err) => finish(new Error(`mcp_tool: failed to launch '${command}': ${err.message}`)));
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`mcp_tool: server exited (code ${code}) before responding.${stderrBuf ? " stderr: " + stderrBuf.slice(0, 500) : ""}`));
      }
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // MCP servers may log non-JSON lines to stdout; ignore what doesn't parse
        }
        if (msg.id === undefined || typeof msg.id !== "number") continue;
        const waiter = pending.get(msg.id);
        if (!waiter) continue;
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        else waiter.resolve(msg.result);
      }
    });

    (async () => {
      try {
        await send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "xcoder", version: "1.0.0" },
        });
        initialized = true;
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

        const result = await send(method, params);
        finish(null, result);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    void initialized;
  });
}

export async function runMcpTool(args: McpToolArgs): Promise<string> {
  const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 20_000;

  // "codegraph-mcp" is a convenience alias for the CodeGraph MCP server bundled with xcoder
  // (integrations/codegraph/codegraph-mcp) — resolves to the right interpreter, script path,
  // and CODEGRAPH_API_URL/CODEGRAPH_API_KEY env for whichever CodeGraph instance is currently
  // connected, so callers don't need to know its on-disk location or credentials.
  let command = args.command;
  let cmdArgs = args.args ?? [];
  let env: Record<string, string> | undefined;
  if (command === "codegraph-mcp") {
    const launch = resolveBundledMcpLaunch();
    command = launch.command;
    cmdArgs = launch.args;
    env = launch.env;
  }

  if (args.action === "list") {
    const result = await runMcpRequest(command, cmdArgs, "tools/list", {}, timeoutMs, env);
    return JSON.stringify(result, null, 2);
  }

  if (args.action === "call") {
    if (!args.toolName) throw new Error("mcp_tool: 'toolName' is required for action='call'.");
    const result = await runMcpRequest(
      command,
      cmdArgs,
      "tools/call",
      { name: args.toolName, arguments: args.toolArgs ?? {} },
      timeoutMs,
      env
    );
    return JSON.stringify(result, null, 2);
  }

  throw new Error(`mcp_tool: unknown action '${(args as { action: string }).action}'.`);
}
