import { spawn } from "node:child_process";

export interface DockerComposeDeployResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `docker compose up -d --build` in the given project directory.
 * If projectDir is not provided, uses the current working directory.
 */
export async function dockerComposeUp(
  projectDir?: string,
  cwd: string = process.cwd()
): Promise<DockerComposeDeployResult> {
  const targetDir = projectDir || cwd;

  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", "up", "-d", "--build"], {
      cwd: targetDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: `Failed to spawn docker compose: ${err.message}`,
      });
    });
  });
}

