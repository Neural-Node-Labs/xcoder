/**
 * subagentWorker.ts — Entry point para sa mga subagent child process.
 *
 * Ang script na ito ay ina-spawn sa pamamagitan ng `child_process.fork()` ng SubprocessManager.
 * Tumatanggap ito ng task configuration sa pamamagitan ng IPC, isinasagawa ang logic ng
 * subagent, nagpapadala ng pana-panahong heartbeat ping sa parent, at nag-uulat ng resulta.
 *
 * Protocol:
 * 1. Ipinapadala ng Parent ang { type: "start", data: { task, ... } } sa pamamagitan ng IPC
 * 2. Ipinapadala ng Worker ang { type: "heartbeat" } bawat 2s
 * 3. Ipinapadala ng Worker ang { type: "result", data: <result> } kapag matagumpay, tapos aalis nang exit 0
 * 4. Ipinapadala ng Worker ang { type: "error", data: <error> } kapag nabigo, tapos aalis nang exit 1
 * 5. Nahuhuli at iniuulat bilang mga error ang mga uncaught exception / unhandled rejection
 */

// ─── Heartbeat ────────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 2_000;

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    try {
      if (process.send) {
        process.send({ type: "heartbeat" });
      }
    } catch {
      stopHeartbeat();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

// ─── Paghawak ng error ───────────────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  sendError(`Uncaught exception: ${message}`);
  stopHeartbeat();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  sendError(`Unhandled rejection: ${message}`);
  stopHeartbeat();
  process.exit(1);
});

// ─── Message handler (tagapangasiwa ng mensahe) ────────────────────────────────────

process.on("message", async (msg: unknown) => {
  const message = msg as Record<string, unknown>;

  if (message?.type !== "start") {
    return;
  }

  const workerData = message.data as Record<string, unknown> | undefined;
  if (!workerData) {
    sendError("No worker data received");
    process.exit(1);
    return;
  }

  const task = workerData.task as string | undefined;
  if (!task) {
    sendError("No task provided in worker data");
    process.exit(1);
    return;
  }

  startHeartbeat();

  try {
    const result = await executeSubagentTask(workerData);
    stopHeartbeat();

    if (process.send) {
      process.send({ type: "result", data: result });
    }

    process.exit(0);
  } catch (err) {
    stopHeartbeat();
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    sendError(`Subagent execution failed: ${message}`);
    process.exit(1);
  }
});

// ─── Mga helper function ────────────────────────────────────────────────────────────

function sendError(message: string): void {
  try {
    if (process.send) {
      process.send({ type: "error", data: message });
    }
  } catch {
    // Maaaring nadiskonekta na ang parent
  }
}

/**
 * Isagawa ang subagent task sa nakahiwalay na proseso na ito.
 * Ini-import ang orchestrator at pinapatakbo ang task gamit ang ibinigay na konpigurasyon.
 */
async function executeSubagentTask(workerData: Record<string, unknown>): Promise<unknown> {
  const task = workerData.task as string;
  const maxIterations = (workerData.maxIterations as number) ?? 20;
  const cwd = (workerData.cwd as string) ?? process.cwd();
  const projectRoot = (workerData.projectRoot as string) ?? cwd;

  // Dynamic import ng orchestrator — ito ang tunay na logic ng subagent
  const { ReActOrchestrator } = await import("../core/orchestrator.js");
  const { AutoIO } = await import("../core/io/AutoIO.js");
  const { DeepSeekClient } = await import("../llm/deepseekClient.js");

  // Muling buuin ang LLM config mula sa serialized na data. Ipinapasa lamang ang mga field na
  // talagang naroroon sa parent's config -- HINDI pinuprovide ang mga default na partikular sa
  // deepseek (base_url, api_key_env) kapag ibang provider (hal. ollama) ang aktwal na
  // pinili ng parent, dahil papalitan lang nito ang tamang resolution (registry lookup para sa
  // base_url, walang required na key para sa mga no-auth provider) ng maling deepseek default.
  const llmConfig = workerData.llmConfig as Record<string, unknown> | undefined;
  const config = llmConfig
    ? {
        provider: String(llmConfig.provider ?? "deepseek"),
        ...(llmConfig.base_url ? { base_url: String(llmConfig.base_url) } : {}),
        ...(llmConfig.endpoint ? { endpoint: String(llmConfig.endpoint) } : {}),
        model: String(llmConfig.model ?? "deepseek-v4-flash"),
        ...(llmConfig.api_key_env ? { api_key_env: String(llmConfig.api_key_env) } : {}),
        max_tokens: Number(llmConfig.max_tokens ?? 16384),
        temperature: Number(llmConfig.temperature ?? 0.0),
        thinking: Boolean(llmConfig.thinking ?? false),
      }
    : {
        provider: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        endpoint: "/chat/completions",
        model: "deepseek-v4-flash",
        api_key_env: "DEEPSEEK_API_KEY",
        max_tokens: 16384,
        temperature: 0.0,
        thinking: false,
      };

  // Gumawa ng telemetry
  const telemetry = createNoopTelemetry();

  const llm = new DeepSeekClient(config, telemetry);

  const sub = new ReActOrchestrator(llm, telemetry, {
    cwd,
    projectRoot,
    maxIterations,
    consoleIndent: (workerData.consoleIndent as number) ?? 1,
    singlePhase: true,
    io: new AutoIO(),
    validateGoal: false,
    selfHealing: workerData.selfHealing !== false,
  });

  const result = await sub.run(task, { skipPlanMode: true, isSubagent: true });

  return {
    status: sub.getLastOutcome() === "completed" ? "completed" : "iteration_limit",
    summary: result,
    iterationCount: sub.getIterationCount(),
    usage: sub.getCumulativeUsage(),
    partialOutput: sub.getLastOutcome() !== "completed"
      ? extractPartialContext(sub)
      : undefined,
  };
}

/**
 * Kunin ang naipong konteksto mula sa isang subagent na umabot sa limitasyon ng iterasyon.
 */
function extractPartialContext(sub: { getLastMessages(): unknown[] }): {
  lastThought: string;
  toolCalls: string[];
  observations: string[];
} {
  const messages = sub.getLastMessages() as Array<{
    role: string;
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  }>;

  const toolCalls: string[] = [];
  const observations: string[] = [];
  let lastThought = "";

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.content) {
      lastThought = msg.content;
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        try {
          const args = JSON.parse(tc.function.arguments);
          const argSummary = Object.keys(args).length > 0
            ? `(${Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(", ")})`
            : "";
          toolCalls.push(`${tc.function.name} ${argSummary}`);
        } catch {
          toolCalls.push(tc.function.name);
        }
      }
    }
    if (msg.role === "tool" && msg.content) {
      observations.push(String(msg.content).slice(0, 200));
    }
  }

  return { lastThought, toolCalls, observations };
}

/**
 * Gumawa ng no-op telemetry instance para sa proseso ng subagent.
 * Tumatakbo ang subagent nang nakahiwalay at hindi nagbabahagi ng telemetry sa parent.
 */
function createNoopTelemetry() {
  return {
    logThought: async () => {},
    logLlmCall: async () => {},
    logError: async () => {},
  };
}
