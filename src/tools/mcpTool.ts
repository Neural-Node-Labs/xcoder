/**
 * mcp_tool — a minimal Model Context Protocol (MCP) client so xcoder engines (in particular the
 * "assistant" chat engine, see EngineRegistry.ts) can discover and call tools exposed by any
 * MCP server, the same way an editor like Claude Desktop would. No SDK dependency — both
 * transports below are small, verified-against-a-real-server implementations of MCP's wire
 * protocol rather than a pulled-in @modelcontextprotocol/sdk:
 *
 * - stdio: newline-delimited JSON-RPC 2.0 over a spawned child process's stdin/stdout. Every
 *   call spawns a fresh process, does the `initialize` handshake, performs exactly one
 *   operation (tools/list or tools/call), then tears it down.
 * - streamable-http: a single JSON-RPC request POSTed to a running MCP server's HTTP endpoint,
 *   getting a JSON response back directly (server-side run with stateless_http=True,
 *   json_response=True — see integrations/codegraph/codegraph-mcp/server.py). No SSE parsing,
 *   no session bookkeeping, because the server treats every request independently.
 *
 * Which transport is used depends on how the target is specified: `command` (+ optional `args`)
 * spawns a local process over stdio; `url` POSTs to a network MCP server over streamable-http.
 * The special `command: "codegraph-mcp"` alias picks whichever is actually reachable for the
 * bundled CodeGraph integration — see resolveBundledMcpLaunch() in codegraphProcess.ts.
 */

import { spawn } from "node:child_process";
import { resolveBundledMcpLaunch } from "../api/codegraphProcess.js";

export interface McpToolArgs {
  action: "list" | "call";
  /** Spawns a local MCP server over stdio. Mutually exclusive with `url`. The special value
   *  "codegraph-mcp" resolves to the bundled CodeGraph MCP server automatically. */
  command?: string;
  args?: string[];
  /** Calls a network MCP server over streamable-http instead of spawning one. Mutually
   *  exclusive with `command` (except the "codegraph-mcp" alias, which may resolve to either). */
  url?: string;
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

const CLIENT_INFO = { name: "xcoder", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

// ---------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------

/**
 * Speak just enough MCP over stdio to run one `initialize` + one follow-up request against a
 * freshly spawned server, then tear it down. Returns the follow-up request's `result`.
 */
function runMcpStdioRequest(
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
        await send("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
        const result = await send(method, params);
        finish(null, result);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

// ---------------------------------------------------------------------
// streamable-http transport
// ---------------------------------------------------------------------

/**
 * One JSON-RPC request over MCP's streamable-http transport. Verified against a real server run
 * with stateless_http=True, json_response=True (see codegraph-mcp/server.py): each POST gets a
 * complete JSON body back directly, no SSE stream and no session id to carry between calls — so,
 * same as the stdio path, `initialize` is sent first and its result discarded, then the real
 * request is sent as an independent POST.
 */
async function runMcpHttpRequest(
  url: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  const headers = {
    "Content-Type": "application/json",
    // Streamable-http servers may respond with either content type depending on whether the
    // call produces a single result (json) or a stream (event-stream) — accept both even
    // though xcoder's bundled server is configured to always return plain JSON.
    Accept: "application/json, text/event-stream",
  };

  async function post(m: string, p: Record<string, unknown>, id: number): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`mcp_tool: request to '${url}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`mcp_tool: '${url}' returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    const data = (await res.json()) as JsonRpcResponse;
    if (data.error) throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
    return data.result;
  }

  await post("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, 1);
  return post(method, params, 2);
}

// ---------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------

export async function runMcpTool(args: McpToolArgs): Promise<string> {
  const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 20_000;

  // "codegraph-mcp" is a convenience alias for the CodeGraph MCP server bundled with xcoder —
  // resolves to whichever transport can actually reach it: a network URL (the docker-compose
  // `codegraph-mcp` service, or any XCODER_CODEGRAPH_MCP_URL) if one is configured, otherwise a
  // locally-spawned process using the bundled source + venv. See resolveBundledMcpLaunch().
  let mode: "stdio" | "http" = args.url ? "http" : "stdio";
  let command = args.command ?? "";
  let cmdArgs = args.args ?? [];
  let url = args.url ?? "";
  let env: Record<string, string> | undefined;

  if (args.command === "codegraph-mcp") {
    const launch = resolveBundledMcpLaunch();
    if (launch.mode === "http") {
      mode = "http";
      url = launch.url;
    } else {
      mode = "stdio";
      command = launch.command;
      cmdArgs = launch.args;
      env = launch.env;
    }
  } else if (!args.command && !args.url) {
    throw new Error("mcp_tool: either 'command' or 'url' is required.");
  }

  const rpcMethod = args.action === "list" ? "tools/list" : "tools/call";
  const rpcParams =
    args.action === "call"
      ? (() => {
          if (!args.toolName) throw new Error("mcp_tool: 'toolName' is required for action='call'.");
          return { name: args.toolName, arguments: args.toolArgs ?? {} };
        })()
      : {};

  if (args.action !== "list" && args.action !== "call") {
    throw new Error(`mcp_tool: unknown action '${(args as { action: string }).action}'.`);
  }

  const result =
    mode === "http"
      ? await runMcpHttpRequest(url, rpcMethod, rpcParams, timeoutMs)
      : await runMcpStdioRequest(command, cmdArgs, rpcMethod, rpcParams, timeoutMs, env);

  return JSON.stringify(result, null, 2);
}
