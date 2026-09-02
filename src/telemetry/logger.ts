import fs from "node:fs";
import path from "node:path";
import { TelemetryInterface, ReActStep } from "../core/types.js";
import { resolveLogsDir } from "../config/paths.js";

/**
 * Default na implementasyon ng telemetry: flat na mga log file sa ilalim ng .agent/logs/.
 * (DATI ay nasa top-level na .log/ ito, hiwalay sa .agent/ — pinagsama-sama na ngayon ang
 * lahat ng system-generated na file sa ilalim ng .agent/ lamang; tingnan ang src/config/paths.ts.)
 * Nasasapatan nito ang TelemetryInterface stub para gumana ang xcoder nang walang
 * anumang config. Palitan ito (PostgresTelemetry) sa pamamagitan ng pag-implement ng
 * TelemetryInterface at pag-wire nito sa core/orchestrator sa halip na FileTelemetry.
 *
 * Log rotation: kapag lumampas ang isang log file sa MAX_LOG_SIZE (default 2MB), ito ay
 * pinapalitan ng pangalan sa <name>_YYYY-MM-DD.log at may bagong file na sinisimulan.
 * Pinipigilan nito ang walang-hanggang paggamit ng disk mula sa matagal-tumatakbong sessions.
 */
export class FileTelemetry implements TelemetryInterface {
  private logDir: string;
  private maxLogSize: number;

  constructor(workspaceRoot: string = process.cwd(), maxLogSize?: number) {
    this.logDir = resolveLogsDir(workspaceRoot);
    this.maxLogSize = maxLogSize ?? 2 * 1024 * 1024; // default na 2 MB
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  /**
   * Suriin kung lumampas ang isang file sa max size at i-rotate ito kung gayon.
   * Pinapalitan ang pangalan ng <file> sa <name>_YYYY-MM-DD.log at gumagawa ng bagong <file>.
   */
  private rotateIfNeeded(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size >= this.maxLogSize) {
          const ext = path.extname(filePath);
          const base = filePath.slice(0, -ext.length);
          const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
          const rotatedPath = `${base}_${dateStr}${ext}`;
          // Iwasan ang pag-overwrite sa isang file na na-rotate na sa parehong araw
          let finalPath = rotatedPath;
          let counter = 1;
          while (fs.existsSync(finalPath)) {
            finalPath = `${base}_${dateStr}_${counter}${ext}`;
            counter++;
          }
          fs.renameSync(filePath, finalPath);
        }
      }
    } catch {
      // Kung nabigo ang rotation (permissions, atbp.), magpatuloy na lamang sa pag-append
    }
  }

  private append(file: string, line: unknown) {
    const p = path.join(this.logDir, file);
    this.rotateIfNeeded(p);
    const entry = `${new Date().toISOString()} ${JSON.stringify(line)}\n`;
    fs.appendFileSync(p, entry, "utf-8");
  }

  async logThought(step: ReActStep): Promise<void> {
    this.append("thinking.log", step);
  }

  async logLlmCall(request: unknown, response: unknown): Promise<void> {
    this.append("llm.log", { request, response });
  }

  async logError(err: unknown, context?: string): Promise<void> {
    const serialized =
      err instanceof Error ? { message: err.message, stack: err.stack } : { err };
    this.append("sys.log", { context, ...serialized });
  }
}

/** No-op na telemetry, kapaki-pakinabang para sa tests o kapag tahasang naka-disable ang logging. */
export class NullTelemetry implements TelemetryInterface {
  async logThought(): Promise<void> {}
  async logLlmCall(): Promise<void> {}
  async logError(): Promise<void> {}
}


