/**
 * Live na console reporting para sa ReAct loop. Purong presentational — hindi kailanman
 * nakakaapekto sa control flow. Ang telemetry (src/telemetry/logger.ts) ang nananatiling
 * pinagmumulan ng katotohanan para sa naka-persist na record; ang module na ito ay
 * sinasalamin lamang ang nangyayari patungo sa stdout habang ito ay nangyayari, sa halip
 * na tumahimik ang terminal sa buong tagal ng bawat LLM call at pagsasagawa ng tool.
 *
 * Maayos na bumababa ang antas kapag hindi TTY ang stdout (piped output, CI logs, atbp.):
 * lulukapan ang animated spinner pabor sa isang static na linya, at aalisin ang mga ANSI
 * color code.
 */

const isTTY = Boolean(process.stdout.isTTY);

/**
 * Verbose mode raises the truncation limits on thought/action/observation console output
 * (see `truncate()`/`summarizeInput()` below) and enables `reportStartupBanner()`. Set via
 * `--verbose` on the CLI (src/cli/index.ts). A plain module-level flag rather than a per-call
 * parameter threaded through every reporter function, since it's a global "how much detail
 * does this whole run print" setting, not something that varies call to call.
 */
let verboseMode = false;

export function setVerbose(v: boolean): void {
  verboseMode = v;
}

export function isVerbose(): boolean {
  return verboseMode;
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  brightCyan: "\x1b[96m",
  magenta: "\x1b[35m",
  brightMagenta: "\x1b[95m",
  green: "\x1b[32m",
  brightGreen: "\x1b[92m",
  red: "\x1b[31m",
  brightRed: "\x1b[91m",
  yellow: "\x1b[33m",
  brightYellow: "\x1b[93m",
  blue: "\x1b[34m",
  brightBlue: "\x1b[94m",
  bgMagenta: "\x1b[45m",
  white: "\x1b[97m",
};

function color(text: string, code: string): string {
  return isTTY ? `${code}${text}${ANSI.reset}` : text;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Nagpapakita ng animated na "thinking" spinner habang tumatakbo ang isang async na operasyon
 * (isang LLM call), pagkatapos ay linisin ang linya. Nagno-no-op sa animation (bumabalik sa
 * isang static na linya) kapag hindi TTY ang stdout, dahil walang saysay ang carriage-return
 * redraws sa piped/log output.
 */
export class Spinner {
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;

  start(label: string): void {
    this.startedAt = Date.now();
    if (!isTTY) {
      console.log(color(`… ${label}`, ANSI.dim));
      return;
    }
    process.stdout.write(`${SPINNER_FRAMES[0]} ${label}`);
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
      process.stdout.write(`\r${color(SPINNER_FRAMES[this.frame], ANSI.cyan)} ${label} ${color(`(${elapsed}s)`, ANSI.dim)}\x1b[K`);
    }, 90);
  }

  /** Nililinis ang linya ng spinner. Magpasa ng mensahe para mag-iwan ng maikling buod sa halip nito. */
  stop(message?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (isTTY) {
      process.stdout.write("\r\x1b[K");
    }
    if (message) console.log(message);
  }
}

/** Indent prefix para makikitang naiiba visually ang output ng subagent sa parent run. */
function prefix(indent: number): string {
  return indent > 0 ? "  ".repeat(indent) + color("↳ ", ANSI.dim) : "";
}

/**
 * Ini-print ang reasoning/thought ng model para sa hakbang na ito. Ang `reasoningContent` ay
 * ang thinking-mode chain-of-thought ng DeepSeek (tingnan ang deepseekClient.ts); bumabalik sa
 * `content` kapag naka-off ang thinking mode o walang ibinalik ang model, para laging may
 * ipinapakita.
 *
 * Sadyang ito ang pinaka-visually prominent na linya sa loop (naka-highlight na label +
 * maliwanag na katawan, hindi dimmed) — ito ang isang linyang talagang gustong mahuli ng isang
 * taong skim-reading sa isang matagal-tumatakbong task, kaya hindi ito dapat magmukhang
 * kapareho ng bigat ng lahat ng iba pa.
 */
/**
 * Isang beses na naka-print na banner sa simula ng run kapag naka-on ang --verbose: ipinapakita
 * ang engine, provider, model, saklaw ng workspace, at kung mock ang koneksyon. Walang epekto
 * kapag naka-off ang verbose mode -- purong opt-in na detalye, hindi karagdagang default noise.
 */
export function reportStartupBanner(info: {
  engine: string;
  provider: string;
  model: string;
  mock: boolean;
  cwd: string;
}): void {
  if (!verboseMode) return;
  const label = color("▸ VERBOSE", ANSI.bold + ANSI.brightBlue);
  console.log(`${label} engine=${color(info.engine, ANSI.brightCyan)} provider=${color(info.provider, ANSI.brightCyan)} model=${color(info.model, ANSI.brightCyan)}`);
  console.log(`${label} mock=${color(String(info.mock), info.mock ? ANSI.brightYellow : ANSI.dim)} cwd=${color(info.cwd, ANSI.dim)}`);
  if (info.mock) {
    console.log(`${label} ${color("running against a MOCK connection — no real LLM API calls will be made.", ANSI.brightYellow)}`);
  }
}

export function reportThought(text: string | undefined, indent = 0): void {
  if (!text || !text.trim()) return;
  const label = isTTY
    ? `${ANSI.bgMagenta}${ANSI.white}${ANSI.bold} THOUGHT ${ANSI.reset}`
    : "[THOUGHT]";
  const body = truncate(text.trim(), 500);
  console.log(`${prefix(indent)}${label} ${color(body, isTTY ? ANSI.brightMagenta : "")}`);
}

export function reportAction(tool: string, input: unknown, indent = 0): void {
  const label = color("🔧 ACTION", ANSI.brightCyan + ANSI.bold);
  console.log(`${prefix(indent)}${label} ${color(tool, ANSI.brightCyan)} ${color(summarizeInput(input), ANSI.dim)}`);
}

export function reportObservation(observation: unknown, isError: boolean, indent = 0, score?: number): void {
  const label = isError
    ? color("✖ OBSERVATION", ANSI.brightRed + ANSI.bold)
    : color("👁 OBSERVATION", ANSI.brightGreen + ANSI.bold);
  const bodyColor = isError ? ANSI.brightRed : ANSI.dim;
  const scoreBit = score === undefined ? "" : ` ${scoreBadge(score)}`;
  console.log(`${prefix(indent)}${label} ${color(summarizeInput(observation), bodyColor)}${scoreBit}`);
}

function scoreBadge(score: number): string {
  const code = score >= 70 ? ANSI.green : score >= 40 ? ANSI.yellow : ANSI.brightRed;
  return color(`[health ${score}]`, code);
}

/** Ini-print nang isang beses kapag bumaba ang rolling health average nang sapat para
 *  mag-trigger ng self-correction nudge — tingnan ang orchestrator.ts. Sadyang malakas
 *  (hindi dim) dahil layunin nitong makahuli ng atensyon. */
export function reportHealthWarning(rollingAvg: number, indent = 0): void {
  const label = isTTY
    ? `${ANSI.brightRed}${ANSI.bold}⚠ SELF-CHECK${ANSI.reset}`
    : "[SELF-CHECK]";
  console.log(
    `${prefix(indent)}${label} ${color(`rolling health ${rollingAvg}/100 — nudging the agent to reconsider its approach`, ANSI.brightRed)}`
  );
}

export function reportSubagentStart(task: string, indent = 0): void {
  console.log(`${prefix(indent)}${color("🧩 SUBAGENT", ANSI.brightBlue + ANSI.bold)} ${color(truncate(task, 200), ANSI.brightBlue)}`);
}

/** Token usage bawat tawag, ini-print kaagad pagkatapos ng Thought para sa parehong LLM call. */
export function reportUsage(
  usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number; cachedTokens?: number } | undefined,
  runningTotal: number,
  indent = 0
): void {
  if (!usage) return;
  const bits = [`${usage.promptTokens.toLocaleString()} in`, `${usage.completionTokens.toLocaleString()} out`];
  if (usage.reasoningTokens) bits.push(`${usage.reasoningTokens.toLocaleString()} reasoning`);
  if (usage.cachedTokens) bits.push(`${usage.cachedTokens.toLocaleString()} cached`);
  const tokenBreakdown = color(bits.join(" · "), ANSI.dim);
  const totalLabel = color(`— ${runningTotal.toLocaleString()} total this run`, ANSI.brightYellow + ANSI.bold);
  console.log(`${prefix(indent)}${color("🪙", ANSI.yellow)} ${tokenBreakdown} ${totalLabel}`);
}

/**
 * Color-coded na mga istatistika bawat phase, ini-print pagkatapos matapos ang bawat phase
 * sa phase-planning mode.
 * Bilang ng token: pula kung >1M, berde kung >500K, asul kung <500K.
 * Bilang ng iterasyon: pula kung >100, berde kung >50, asul kung <20.
 */
export function reportPhaseStats(phaseNumber: number, phaseTitle: string, tokens: number, iterations: number, indent = 0): void {
  const tokenColor = tokens > 1_000_000 ? ANSI.red : tokens > 500_000 ? ANSI.green : ANSI.blue;
  const iterColor = iterations > 100 ? ANSI.red : iterations > 50 ? ANSI.green : ANSI.blue;
  const p = prefix(indent);
  console.log(
    `${p}${color("📊 Phase", ANSI.bold)} ${color(`${phaseNumber}: ${phaseTitle}`, ANSI.brightCyan)} — ` +
    `${color(`${tokens.toLocaleString()} tokens`, tokenColor)} · ` +
    `${color(`${iterations} iterations`, iterColor)}`
  );
}

/** Buod sa dulo ng run, ini-print nang isang beses pagkatapos ng huling sagot. */
export function reportTotalUsage(
  cumulative: { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens?: number },
  callCount: number,
  indent = 0
): void {
  if (callCount === 0) return;
  const reasoningBit = cumulative.reasoningTokens ? ` (${cumulative.reasoningTokens.toLocaleString()} reasoning)` : "";
  console.log(
    `${prefix(indent)}${color("🪙 Total", ANSI.bold)} ${color(
      `${cumulative.totalTokens.toLocaleString()} tokens${reasoningBit} — ${cumulative.promptTokens.toLocaleString()} in · ${cumulative.completionTokens.toLocaleString()} out across ${callCount} LLM call${callCount === 1 ? "" : "s"}`,
      ANSI.dim
    )}`
  );
}

/**
 * Naglalabas ng breakdown ng buod ng token usage na naka-aggregate ayon sa task at phase.
 */
export function reportTaskTokenSummary(
  taskTokenSummaries: Record<
    string,
    {
      phases: Record<string, { input: number; output: number; cached: number; total: number; expectedTotal: number }>;
      runningTotal: number;
    }
  >,
  indent = 0
): void {
  const p = prefix(indent);
  console.log(`${p}${color("📋 Task Token Breakdown", ANSI.bold + ANSI.brightYellow)}`);

  for (const [taskId, taskData] of Object.entries(taskTokenSummaries)) {
    console.log(`${p}  ${color(`Task: ${taskId}`, ANSI.brightCyan)} (Running Total: ${taskData.runningTotal.toLocaleString()})`);

    for (const [phaseId, phaseStats] of Object.entries(taskData.phases)) {
      const details = `${phaseStats.input.toLocaleString()} in · ${phaseStats.output.toLocaleString()} out · ${phaseStats.cached.toLocaleString()} cached`;
      console.log(
        `${p}    ${color(`• Phase ${phaseId}:`, ANSI.dim)} ${color(`${phaseStats.total.toLocaleString()} tokens`, ANSI.yellow)} (${color(details, ANSI.dim)})`
      );
    }
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const effectiveMax = verboseMode ? Math.max(max * 8, 4000) : max;
  return oneLine.length > effectiveMax ? `${oneLine.slice(0, effectiveMax)}…` : oneLine;
}

function summarizeInput(value: unknown): string {
  try {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    return truncate(json, 300);
  } catch {
    return String(value);
  }
}
