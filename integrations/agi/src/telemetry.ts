import { EventEmitter } from "node:events";
import { trace, SpanStatusCode, Span } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Everything the UI sees flows through this bus (spans, approvals, evolutions, kpis). */
export const bus = new EventEmitter();
bus.setMaxListeners(50);
export const recent: any[] = [];
export function publish(kind: string, data: any) {
  const e = { kind, t: Date.now(), ...data };
  recent.push(e);
  if (recent.length > 800) recent.shift();
  bus.emit("event", e);
}

const SECRET = /(sk-ant-[\w-]+|Bearer\s+[\w.-]+|x-api-key[:=]\s*\S+)/gi;
export function redact(v: unknown): any {
  if (typeof v === "string") return v.replace(SECRET, "[redacted]").slice(0, 300);
  if (typeof v === "number" || typeof v === "boolean") return v;
  return String(JSON.stringify(v) ?? "").replace(SECRET, "[redacted]").slice(0, 300);
}
const clean = (a: Record<string, any>) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, redact(v)]));

class LiveSpanProcessor implements SpanProcessor {
  onStart(span: any) {
    publish("span", {
      phase: "start", id: span.spanContext().spanId, trace: span.spanContext().traceId,
      parent: span.parentSpanContext?.spanId ?? span.parentSpanId, name: span.name, attrs: clean(span.attributes ?? {}),
    });
  }
  onEnd(span: ReadableSpan) {
    publish("span", {
      phase: "end", id: span.spanContext().spanId, name: span.name, attrs: clean(span.attributes ?? {}),
      error: span.status.code === SpanStatusCode.ERROR ? span.status.message : undefined,
      events: span.events.map((e) => ({ name: e.name, attrs: clean(e.attributes ?? {}) })),
      ms: Math.round(span.duration[0] * 1e3 + span.duration[1] / 1e6),
    });
  }
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}

export function startTelemetry() {
  const processors: SpanProcessor[] = [new LiveSpanProcessor()];
  const ep = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (ep) processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${ep.replace(/\/$/, "")}/v1/traces` })));
  const sdk = new NodeSDK({ serviceName: "agi-devops", spanProcessors: processors });
  sdk.start();
  return sdk;
}

const tracer = trace.getTracer("agi");
export async function span<T>(name: string, attrs: Record<string, any>, fn: (s: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: clean(attrs) }, async (s) => {
    try { return await fn(s); }
    catch (e: any) { s.setStatus({ code: SpanStatusCode.ERROR, message: String(e?.message ?? e) }); throw e; }
    finally { s.end(); }
  });
}
