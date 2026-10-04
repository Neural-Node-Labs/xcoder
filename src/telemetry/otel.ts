import {
  context,
  metrics,
  trace,
  SpanStatusCode,
  type Attributes,
  type Counter,
  type Histogram,
  type Span,
} from "@opentelemetry/api";
import type { TelemetryInterface, ReActStep } from "../core/types.js";
import { redactAndTruncate } from "./redact.js";

/**
 * OpenTelemetry integration for xcoder.
 *
 * Design rules:
 *  1. **Telemetry can never crash or slow the engine.** Every call into the OTel API is wrapped;
 *     a failing exporter, a broken SDK or a bad attribute degrades to "no telemetry".
 *  2. **Zero cost when off.** Instrumentation code uses only `@opentelemetry/api`, whose default
 *     tracer/meter are no-ops. The heavy SDK + OTLP exporters are loaded lazily, and only when
 *     `initOpenTelemetry()` decides telemetry is enabled.
 *  3. **Nothing sensitive leaves the process.** All free-text attributes/events go through
 *     `redactAndTruncate`. Prompts/responses are NOT exported (only sizes and token counts);
 *     tool *names* and short redacted summaries are.
 *  4. **Standard configuration.** Enabled by `XCODER_OTEL_ENABLED=1` or by any standard
 *     `OTEL_EXPORTER_OTLP_[TRACES_|METRICS_]ENDPOINT`; `OTEL_SDK_DISABLED=true` always wins.
 *     `XCODER_OTEL_CONSOLE=1` prints spans to stdout for local debugging. The rest
 *     (OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_HEADERS, ...) is read by the OTel SDK itself.
 */

export const TRACER_NAME = "xcoder";
export const METER_NAME = "xcoder";

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");

export function isOtelEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (truthy(env.OTEL_SDK_DISABLED)) return false;
  return (
    truthy(env.XCODER_OTEL_ENABLED) ||
    truthy(env.XCODER_OTEL_CONSOLE) ||
    Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)
  );
}

let shutdownFn: (() => Promise<void>) | undefined;
let initialized = false;

/**
 * Starts the OTel SDK (traces + metrics, OTLP/HTTP). Idempotent, never throws. Returns a
 * `shutdown()` that flushes pending data (call on process exit). Returns a no-op when disabled.
 */
export async function initOpenTelemetry(opts: { force?: boolean; serviceVersion?: string } = {}): Promise<() => Promise<void>> {
  if (initialized) return shutdownOpenTelemetry;
  if (!opts.force && !isOtelEnabledByEnv()) return async () => {};
  initialized = true;
  try {
    const [{ NodeTracerProvider }, base, sdkMetrics, resources, semconv] = await Promise.all([
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
    ]);

    const resource = resources.resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "xcoder",
      [semconv.ATTR_SERVICE_VERSION]: opts.serviceVersion ?? process.env.npm_package_version ?? "0.1.0",
    });

    const spanProcessors: import("@opentelemetry/sdk-trace-base").SpanProcessor[] = [];
    const hasOtlp = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
    if (hasOtlp || truthy(process.env.XCODER_OTEL_ENABLED)) {
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
      spanProcessors.push(new base.BatchSpanProcessor(new OTLPTraceExporter(), { maxQueueSize: 2048, exportTimeoutMillis: 10_000 }));
    }
    if (truthy(process.env.XCODER_OTEL_CONSOLE)) {
      spanProcessors.push(new base.SimpleSpanProcessor(new base.ConsoleSpanExporter()));
    }
    const tracerProvider = new NodeTracerProvider({ resource, spanProcessors });
    tracerProvider.register(); // installs the AsyncLocalStorage context manager + global provider

    const readers: import("@opentelemetry/sdk-metrics").MetricReader[] = [];
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || truthy(process.env.XCODER_OTEL_ENABLED)) {
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
      readers.push(new sdkMetrics.PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 }));
    }
    const meterProvider = new sdkMetrics.MeterProvider({ resource, readers });
    metrics.setGlobalMeterProvider(meterProvider);

    shutdownFn = async () => {
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    };
  } catch (err) {
    // Telemetry must never prevent startup.
    console.warn(`[otel] initialization failed, continuing without OpenTelemetry: ${err instanceof Error ? err.message : String(err)}`);
  }
  return shutdownOpenTelemetry;
}

export async function shutdownOpenTelemetry(): Promise<void> {
  try {
    await shutdownFn?.();
  } catch {
    /* ignore */
  } finally {
    shutdownFn = undefined;
    initialized = false;
  }
}

// ─── Safe span helpers ───────────────────────────────────────────────────────────────

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Runs `fn` inside a new span (child of the active one). Guarantees: `fn`'s result/exception
 * is returned/rethrown unchanged; span is always ended; OTel failures are swallowed.
 */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = safe(() => getTracer().startSpan(name, { attributes }));
  if (!span) return fn(trace.wrapSpanContext({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }));
  const ctx = safe(() => trace.setSpan(context.active(), span));
  try {
    const run = () => fn(span);
    return await (ctx ? context.with(ctx, run) : run());
  } catch (err) {
    safe(() => {
      span.recordException({ name: err instanceof Error ? err.name : "Error", message: redactAndTruncate(err instanceof Error ? err.message : err, 300) });
      span.setStatus({ code: SpanStatusCode.ERROR, message: redactAndTruncate(err instanceof Error ? err.message : err, 200) });
    });
    throw err;
  } finally {
    safe(() => span.end());
  }
}

export function setSpanAttrs(span: Span | undefined, attrs: Attributes): void {
  if (!span) return;
  safe(() => span.setAttributes(attrs));
}

export function markSpanError(span: Span | undefined, message: string): void {
  if (!span) return;
  safe(() => span.setStatus({ code: SpanStatusCode.ERROR, message: redactAndTruncate(message, 200) }));
}

export function addActiveSpanEvent(name: string, attrs?: Attributes): void {
  safe(() => trace.getActiveSpan()?.addEvent(name, attrs));
}

// ─── Metrics ────────────────────────────────────────────────────────────────────────

export interface XcoderMetrics {
  runs: Counter;
  stageDuration: Histogram;
  stageOutcomes: Counter;
  healingAttempts: Counter;
  escalations: Counter;
  budgetExceeded: Counter;
  timeouts: Counter;
  llmTokens: Counter;
  validationOutcomes: Counter;
  checkpointFailures: Counter;
}

let cached: { meterProviderTag: unknown; m: XcoderMetrics } | undefined;

/** Instruments are created lazily against whatever MeterProvider is currently global, and
 *  re-created if the provider changed (e.g. tests swapping in an in-memory reader). */
export function xcoderMetrics(): XcoderMetrics {
  const tag = metrics.getMeterProvider();
  if (cached && cached.meterProviderTag === tag) return cached.m;
  const meter = metrics.getMeter(METER_NAME);
  const m: XcoderMetrics = {
    runs: meter.createCounter("xcoder.sdlc.runs", { description: "SDLC pipeline runs, by outcome and entry stage" }),
    stageDuration: meter.createHistogram("xcoder.sdlc.stage.duration", { unit: "ms", description: "Wall-clock time of one SDLC stage (all attempts)" }),
    stageOutcomes: meter.createCounter("xcoder.sdlc.stage.outcomes", { description: "Stage results by stage and status" }),
    healingAttempts: meter.createCounter("xcoder.sdlc.healing.attempts", { description: "Re-attempts after a failed stage/validation" }),
    escalations: meter.createCounter("xcoder.sdlc.escalations", { description: "Stages that exhausted healing and halted the pipeline" }),
    budgetExceeded: meter.createCounter("xcoder.sdlc.budget.exceeded", { description: "Runs stopped by token/time budget" }),
    timeouts: meter.createCounter("xcoder.sdlc.stage.timeouts", { description: "Sub-agent timeouts" }),
    llmTokens: meter.createCounter("xcoder.llm.tokens", { unit: "{token}", description: "LLM tokens consumed, by type" }),
    validationOutcomes: meter.createCounter("xcoder.sdlc.validation.outcomes", { description: "Validation Gate verdicts" }),
    checkpointFailures: meter.createCounter("xcoder.sdlc.checkpoint.failures", { description: "Failed attempts to persist SDLC state" }),
  };
  cached = { meterProviderTag: tag, m };
  return m;
}

/** Fire-and-forget metric write that can never throw. */
export function recordMetric(fn: (m: XcoderMetrics) => void): void {
  safe(() => fn(xcoderMetrics()));
}

// ─── TelemetryInterface decorator ───────────────────────────────────────────────────────

/**
 * Wraps any TelemetryInterface (normally FileTelemetry) and mirrors its events onto the active
 * span as span events / exceptions. The inner sink keeps working exactly as before, and an
 * inner-sink failure no longer propagates into the engine either.
 */
export class OtelTelemetry implements TelemetryInterface {
  constructor(private readonly inner: TelemetryInterface) {}

  async logThought(step: ReActStep): Promise<void> {
    safe(() =>
      addActiveSpanEvent("react.step", {
        "xcoder.iteration": step.iteration,
        "xcoder.phase": String(step.phase),
        ...(step.action?.tool ? { "xcoder.tool": step.action.tool } : {}),
        ...(typeof step.score === "number" ? { "xcoder.step_score": step.score } : {}),
      })
    );
    try {
      await this.inner.logThought(step);
    } catch {
      /* sink failure must not crash the engine */
    }
  }

  async logLlmCall(request: unknown, response: unknown): Promise<void> {
    safe(() => {
      const usage = (response as { usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number } } | undefined)?.usage;
      addActiveSpanEvent("llm.call", {
        ...(usage?.totalTokens !== undefined ? { "gen_ai.usage.total_tokens": usage.totalTokens } : {}),
        ...(usage?.promptTokens !== undefined ? { "gen_ai.usage.input_tokens": usage.promptTokens } : {}),
        ...(usage?.completionTokens !== undefined ? { "gen_ai.usage.output_tokens": usage.completionTokens } : {}),
      });
    });
    try {
      await this.inner.logLlmCall(request, response);
    } catch {
      /* ignore */
    }
  }

  async logError(err: unknown, context?: string): Promise<void> {
    safe(() => {
      const span = trace.getActiveSpan();
      span?.addEvent("error", { "xcoder.error.context": redactAndTruncate(context ?? "", 200), "xcoder.error.message": redactAndTruncate(err instanceof Error ? err.message : err, 300) });
    });
    try {
      await this.inner.logError(err, context);
    } catch {
      /* ignore */
    }
  }
}
