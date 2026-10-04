import type { TelemetryInterface } from "../core/types.js";
import { FileTelemetry } from "./logger.js";
import { OtelTelemetry, isOtelEnabledByEnv } from "./otel.js";

/** The telemetry sink every entry point should use: file logs, plus OpenTelemetry mirroring when enabled. */
export function createTelemetry(workspaceRoot: string = process.cwd()): TelemetryInterface {
  const file = new FileTelemetry(workspaceRoot);
  return isOtelEnabledByEnv() ? new OtelTelemetry(file) : file;
}

export * from "./otel.js";
export { redactSecrets, redactAndTruncate } from "./redact.js";
