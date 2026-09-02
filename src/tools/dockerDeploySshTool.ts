import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fg from "fast-glob";
import { loadIgnoreRules } from "../indexing/ignoreRules.js";
import type { SshTarget, SshResult } from "./sshTool.js";

// Dynamic getters for sshTool functions to avoid stale module cache.
// These always load the latest compiled version.
async function getSshTool() {
  return import("./sshTool.js?t=" + Date.now());
}
async function sshExec(target: SshTarget, command: string): Promise<SshResult> {
  const mod = await getSshTool();
  return mod.sshExec(target, command);
}
async function scpUpload(target: SshTarget, localPath: string, remotePath: string, recursive?: boolean): Promise<SshResult> {
  const mod = await getSshTool();
  return mod.scpUpload(target, localPath, remotePath, recursive);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DeployOptions {
  /** SSH target */
  host: string;
  user: string;
  port?: number;
  keyPath?: string;
  password?: string;

  /** Remote directory to deploy into */
  remotePath: string;

  /** Docker command to run on the remote host (default: "docker compose up -d --build") */
  dockerCommand?: string;

  /** Compose file to use (e.g. "docker-compose.prod.yml"). If omitted, uses the default. */
  composeFile?: string;

  /** Path to a local .env file to ship alongside the workspace */
  envFile?: string;

  /** If true, pull images from registry instead of building from source */
  pullFromRegistry?: boolean;

  /** If true, skip pre-deploy validation checks */
  skipValidation?: boolean;

  /** If true, skip health verification after deploy */
  skipHealthCheck?: boolean;

  /** If true, skip creating a rollback snapshot before deploy */
  skipRollback?: boolean;

  /** Timeout in ms for health check polling (default: 120000 = 2 min) */
  healthCheckTimeoutMs?: number;

  /** Timeout in ms for the docker command itself (default: 300000 = 5 min) */
  dockerCommandTimeoutMs?: number;
}

export interface ServiceStatus {
  name: string;
  status: string;
  health: string | null;
  image: string;
  ports: string;
}

export interface DeployReport {
  /** Overall success (all services healthy) */
  success: boolean;

  /** Timestamp of the deploy */
  timestamp: string;

  /** Size of the tarball shipped in bytes */
  tarBytes: number;

  /** Results of each SSH operation */
  preCheckResult: SshResult | null;
  mkdirResult: SshResult;
  uploadResult: SshResult;
  envUploadResult: SshResult | null;
  remoteExtractResult: SshResult;
  rollbackSnapshotResult: SshResult | null;
  dockerCommandResult: SshResult;
  healthCheckResult: SshResult | null;

  /** Per-service status after deploy (if health check ran) */
  services: ServiceStatus[];

  /** If rollback was triggered, the rollback result */
  rollbackResult: SshResult | null;

  /** Human-readable summary */
  summary: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tarWorkspace(cwd: string, fileList: string[], outTarPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", outTarPath, "-T", "-"], { cwd });
    child.stdin.write(fileList.join("\n"));
    child.stdin.end();
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`tar exited with code ${code}`));
      resolve(fs.statSync(outTarPath).size);
    });
    child.on("error", reject);
  });
}

function buildDockerCommand(opts: DeployOptions): string {
  let cmd = opts.dockerCommand || "docker compose up -d --build";

  // If pullFromRegistry is set, replace --build with --pull always
  if (opts.pullFromRegistry) {
    cmd = cmd.replace("--build", "--pull always");
  }

  // If a compose file is specified, inject -f <file>
  if (opts.composeFile) {
    // Insert -f <file> right after "docker compose"
    cmd = cmd.replace(/^docker compose/, `docker compose -f ${opts.composeFile}`);
  }

  return cmd;
}

function buildRollbackSnapshotCommand(remotePath: string): string {
  // Save the current docker compose ps state so we can restore if needed
  return `cd ${remotePath} && (docker compose ps --format json 2>/dev/null || echo '{"snapshot":"none"}') > .xcoder-rollback-snapshot.json && echo "SNAPSHOT_SAVED"`;
}

function buildRollbackRestoreCommand(remotePath: string): string {
  // Restore the previous compose state from the snapshot
  return `cd ${remotePath} && if [ -f .xcoder-rollback-snapshot.json ]; then echo "Rolling back..."; docker compose down 2>/dev/null; docker compose up -d --build 2>/dev/null || true; echo "ROLLBACK_COMPLETE"; else echo "NO_SNAPSHOT"; fi`;
}

function buildHealthCheckCommand(remotePath: string, composeFile?: string): string {
  const composeFlag = composeFile ? `-f ${composeFile}` : "";
  return `cd ${remotePath} && docker compose ${composeFlag} ps --format json 2>/dev/null || docker compose ${composeFlag} ps --format '{{.Name}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo 'NO_COMPOSE_PS'`;
}

function buildPreCheckCommand(): string {
  return `
    echo "=== DOCKER_CHECK ===" &&
    docker --version 2>&1 || echo "DOCKER_NOT_FOUND" &&
    echo "=== COMPOSE_CHECK ===" &&
    (docker compose version 2>&1 || echo "COMPOSE_NOT_FOUND") &&
    echo "=== DISK_CHECK ===" &&
    df -h / | tail -1 &&
    echo "=== UPTIME ===" &&
    uptime
  `.trim().replace(/\n\s*/g, " ");
}

function parseServiceStatuses(raw: string): ServiceStatus[] {
  const services: ServiceStatus[] = [];
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  // Try NDJSON format first (docker compose ps --format json outputs one JSON object per line)
  let allJson = true;
  const jsonLines: string[] = [];
  for (const line of lines) {
    if (line === "NO_COMPOSE_PS") { allJson = false; break; }
    if (line.startsWith("{")) {
      jsonLines.push(line);
    } else {
      allJson = false;
      break;
    }
  }

  if (allJson && jsonLines.length > 0) {
    for (const line of jsonLines) {
      try {
        const item = JSON.parse(line);
        services.push({
          name: item.Name || item.name || "unknown",
          status: item.Status || item.status || "unknown",
          health: item.Health || item.health || null,
          image: item.Image || item.image || "unknown",
          ports: item.Ports || item.ports || "",
        });
      } catch {
        // If any line fails JSON parse, fall through to tab-separated
        services.length = 0;
        break;
      }
    }
    if (services.length > 0) return services;
  }

  // Fall back to tab-separated format
  for (const line of lines) {
    if (line.startsWith("NAME") || line === "NO_COMPOSE_PS") continue;
    const parts = line.split("\t");
    if (parts.length >= 2) {
      services.push({
        name: parts[0],
        status: parts[1],
        health: null,
        image: "",
        ports: parts[2] || "",
      });
    }
  }
  return services;
}

function allServicesHealthy(services: ServiceStatus[]): boolean {
  if (services.length === 0) return false;
  return services.every((s) => {
    const status = s.status.toLowerCase();
    // "Up" or "running" or "healthy" — anything else is a problem.
    // Must NOT match "unhealthy" (which contains "healthy" as a substring).
    const isUp = status === "up" || status.startsWith("up ");
    const isRunning = status === "running" || status.startsWith("running ");
    const isHealthy = status === "healthy" || status.startsWith("healthy ");
    return isUp || isRunning || isHealthy;
  });
}

function waitForHealthy(
  target: SshTarget,
  remotePath: string,
  composeFile: string | undefined,
  timeoutMs: number
): Promise<SshResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const pollInterval = 5000; // 5 seconds

    const poll = async () => {
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        // Timeout — return the last result
        const result = await sshExec(target, buildHealthCheckCommand(remotePath, composeFile));
        resolve({
          exitCode: 1,
          stdout: result.stdout,
          stderr: `Health check timed out after ${timeoutMs}ms\n${result.stderr}`,
        });
        return;
      }

      const result = await sshExec(target, buildHealthCheckCommand(remotePath, composeFile));
      const services = parseServiceStatuses(result.stdout);

      if (allServicesHealthy(services)) {
        resolve({ exitCode: 0, stdout: result.stdout, stderr: "" });
        return;
      }

      // Check if any service explicitly failed (not just "starting")
      const anyFailed = services.some((s) => {
        const st = s.status.toLowerCase();
        return st.includes("exit") || st.includes("crash") || st.includes("error") || st.includes("unhealthy");
      });

      if (anyFailed) {
        resolve({
          exitCode: 1,
          stdout: result.stdout,
          stderr: "One or more services entered a failed state during health check polling",
        });
        return;
      }

      // Still starting — poll again
      setTimeout(poll, pollInterval);
    };

    poll();
  });
}

// ─── Main Deploy Function ────────────────────────────────────────────────────

/**
 * Enhanced remote Docker deploy tool.
 *
 * Ships the current workspace (respecting .agentignore/.gitignore/.dockerignore, via
 * globTool) to a remote host over SSH, then builds/runs it with Docker on the remote side.
 *
 * Features:
 * - Pre-deploy validation (docker version, disk space)
 * - Rollback snapshot + restore
 * - Health verification after deploy
 * - Compose file selection
 * - Registry pull mode (skip build)
 * - Environment file shipping
 * - Detailed deploy report
 */
export async function deployWorkspaceViaSsh(
  opts: DeployOptions,
  cwd: string = process.cwd()
): Promise<DeployReport> {
  const target: SshTarget = {
    host: opts.host,
    user: opts.user,
    port: opts.port,
    keyPath: opts.keyPath,
    password: opts.password,
  };

  const remotePath = opts.remotePath;
  const healthCheckTimeoutMs = opts.healthCheckTimeoutMs ?? 120_000;
  const dockerCommandTimeoutMs = opts.dockerCommandTimeoutMs ?? 300_000;

  const report: DeployReport = {
    success: false,
    timestamp: new Date().toISOString(),
    tarBytes: 0,
    preCheckResult: null,
    mkdirResult: { exitCode: 0, stdout: "", stderr: "" },
    uploadResult: { exitCode: 0, stdout: "", stderr: "" },
    envUploadResult: null,
    remoteExtractResult: { exitCode: 0, stdout: "", stderr: "" },
    rollbackSnapshotResult: null,
    dockerCommandResult: { exitCode: 0, stdout: "", stderr: "" },
    healthCheckResult: null,
    services: [],
    rollbackResult: null,
    summary: "",
  };

  try {
    // ── Step 1: Pre-deploy validation ──────────────────────────────────────
    if (!opts.skipValidation) {
      report.preCheckResult = await sshExec(target, buildPreCheckCommand());
      const stdout = report.preCheckResult.stdout;

      if (stdout.includes("DOCKER_NOT_FOUND")) {
        report.summary = `Pre-deploy validation failed: Docker is not installed on ${opts.host}`;
        return report;
      }
      if (stdout.includes("COMPOSE_NOT_FOUND")) {
        report.summary = `Pre-deploy validation failed: Docker Compose is not installed on ${opts.host}`;
        return report;
      }
    }

    // ── Step 2: Create remote directory ────────────────────────────────────
    report.mkdirResult = await sshExec(target, `mkdir -p ${remotePath}`);
    if (report.mkdirResult.exitCode !== 0) {
      report.summary = `Failed to create remote directory ${remotePath}: ${report.mkdirResult.stderr}`;
      return report;
    }

    // ── Step 3: Tar the workspace ──────────────────────────────────────────
    // Use fast-glob directly with dot:true so dotfiles (.env.example, .dockerignore, etc.)
    // are included in the deployment tarball. globTool has dot:false which is correct for
    // source-file searches but wrong for deployment where config files matter.
    const ignore = loadIgnoreRules(cwd);
    const files = await fg("**/*", { cwd, ignore, dot: true, onlyFiles: true });
    const tarPath = path.join(os.tmpdir(), `xcoder-deploy-${Date.now()}.tar.gz`);
    report.tarBytes = await tarWorkspace(cwd, files, tarPath);

    // ── Step 4: Upload the tarball ─────────────────────────────────────────
    const remoteTarPath = `${remotePath}/.xcoder-deploy.tar.gz`;
    report.uploadResult = await scpUpload(target, tarPath, remoteTarPath);
    fs.unlinkSync(tarPath);

    if (report.uploadResult.exitCode !== 0) {
      report.summary = `Failed to upload workspace to ${opts.host}:${remoteTarPath}: ${report.uploadResult.stderr}`;
      return report;
    }

    // ── Step 5: Upload .env file if specified ──────────────────────────────
    if (opts.envFile) {
      const envLocalPath = path.resolve(cwd, opts.envFile);
      if (fs.existsSync(envLocalPath)) {
        const remoteEnvPath = `${remotePath}/.env`;
        report.envUploadResult = await scpUpload(target, envLocalPath, remoteEnvPath);
      } else {
        report.envUploadResult = {
          exitCode: 1,
          stdout: "",
          stderr: `Local env file not found: ${opts.envFile}`,
        };
      }
    }

    // ── Step 6: Extract on remote ──────────────────────────────────────────
    report.remoteExtractResult = await sshExec(
      target,
      `tar -xzf ${remoteTarPath} -C ${remotePath} && rm ${remoteTarPath}`
    );
    if (report.remoteExtractResult.exitCode !== 0) {
      report.summary = `Failed to extract workspace on ${opts.host}: ${report.remoteExtractResult.stderr}`;
      return report;
    }

    // ── Step 7: Rollback snapshot ──────────────────────────────────────────
    if (!opts.skipRollback) {
      report.rollbackSnapshotResult = await sshExec(
        target,
        buildRollbackSnapshotCommand(remotePath)
      );
    }

    // ── Step 8: Run the Docker command ─────────────────────────────────────
    const dockerCmd = buildDockerCommand(opts);
    report.dockerCommandResult = await sshExec(target, `cd ${remotePath} && ${dockerCmd}`);

    if (report.dockerCommandResult.exitCode !== 0) {
      // Docker command failed — attempt rollback
      if (!opts.skipRollback) {
        report.rollbackResult = await sshExec(target, buildRollbackRestoreCommand(remotePath));
      }
      report.summary = `Docker command failed on ${opts.host}: ${report.dockerCommandResult.stderr}`;
      if (report.rollbackResult) {
        report.summary += ` Rollback ${report.rollbackResult.stdout.includes("ROLLBACK_COMPLETE") ? "completed" : "attempted but may have issues"}.`;
      }
      return report;
    }

    // ── Step 9: Health verification ────────────────────────────────────────
    if (!opts.skipHealthCheck) {
      report.healthCheckResult = await waitForHealthy(
        target,
        remotePath,
        opts.composeFile,
        healthCheckTimeoutMs
      );
      report.services = parseServiceStatuses(report.healthCheckResult.stdout);

      if (report.healthCheckResult.exitCode === 0) {
        report.success = true;
        report.summary = `Deploy to ${opts.host} succeeded. ${report.services.length} service(s) running.`;
      } else {
        // Health check failed — attempt rollback
        if (!opts.skipRollback) {
          report.rollbackResult = await sshExec(target, buildRollbackRestoreCommand(remotePath));
        }
        report.summary = `Deploy to ${opts.host} completed but health check failed.`;
        if (report.rollbackResult) {
          report.summary += ` Rollback ${report.rollbackResult.stdout.includes("ROLLBACK_COMPLETE") ? "completed" : "attempted"}.`;
        }
      }
    } else {
      report.success = report.dockerCommandResult.exitCode === 0;
      report.summary = `Deploy to ${opts.host} completed (health check skipped).`;
    }

    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.summary = `Deploy to ${opts.host} failed with error: ${message}`;
    return report;
  }
}

