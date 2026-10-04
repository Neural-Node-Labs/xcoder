/** Smoke test of the REAL export path: initOpenTelemetry() → OTLP/HTTP → a local fake collector. */
import http from "node:http";
import { AddressInfo } from "node:net";

const received: Record<string, number> = {};
const bodies: Record<string, Buffer[]> = {};
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received[req.url ?? "?"] = (received[req.url ?? "?"] ?? 0) + 1;
    (bodies[req.url ?? "?"] ??= []).push(Buffer.concat(chunks));
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
process.env.OTEL_SERVICE_NAME = "xcoder-smoke";

const { initOpenTelemetry } = await import("../telemetry/otel.js");
const shutdown = await initOpenTelemetry();
const { SCENARIOS } = await import("./sdlcScenarios.js");
const { SdlcEngine } = await import("../core/engine/SdlcEngine.js");
const { ScriptedDeveloperLlm, makeWorkspace } = await import("./sdlcScenarios.js");
const { AutoIO } = await import("../core/io/AutoIO.js");
const { NullTelemetry } = await import("../telemetry/logger.js");

const scn = SCENARIOS.find((s) => s.id === "failed-deployment")!;
const cwd = makeWorkspace("otlp");
const seeded = scn.seed?.(cwd) ?? {};
const engine = new SdlcEngine(new ScriptedDeveloperLlm(scn.plans), new NullTelemetry(), { cwd, io: new AutoIO({ silent: true }), intake: { ...scn.intake, evidence: seeded.evidence }, acceptanceOverrides: scn.acceptance });
await engine.run(scn.task);
await shutdown(); // flushes batch span processor + metric reader
await new Promise((r) => setTimeout(r, 200));
server.close();

const traces = Buffer.concat(bodies["/v1/traces"] ?? []).toString();
const names = [...new Set([...traces.matchAll(/"name":"(sdlc\.[a-z.]+)"/g)].map((m) => m[1]))];
const svc = traces.includes('"xcoder-smoke"');
const metricsBody = Buffer.concat(bodies["/v1/metrics"] ?? []).toString();
const metricNames = [...new Set([...metricsBody.matchAll(/"name":"(xcoder\.[a-z._]+)"/g)].map((m) => m[1]))];
console.log(JSON.stringify({ received, spanNames: names, serviceNameOnResource: svc, metricNames }, null, 2));
const ok = (received["/v1/traces"] ?? 0) > 0 && (received["/v1/metrics"] ?? 0) > 0 && names.includes("sdlc.run") && svc && metricNames.includes("xcoder.sdlc.runs");
console.log(ok ? "OTLP EXPORT OK" : "OTLP EXPORT FAILED");
process.exit(ok ? 0 : 1);
