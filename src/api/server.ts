import express from "express";
import cors from "cors";
import { createRouter } from "./routes.js";
// Auth is always enabled — no more static admin credentials

export interface ApiServerOptions {
  port?: number;
  host?: string;
}

const DEFAULT_PORT = 3001;
const DEFAULT_HOST = "0.0.0.0";

/**
 * Start the xcoder HTTP API server.
 *
 * Returns the server instance so the caller can close it (e.g. for testing or graceful shutdown).
 */
export function startApiServer(opts: ApiServerOptions = {}): import("http").Server {
  const port = parseInt(process.env.XCODER_API_PORT ?? String(opts.port ?? DEFAULT_PORT), 10);
  const host = process.env.XCODER_API_HOST ?? opts.host ?? DEFAULT_HOST;

  // SECURITY: workspace confinement (src/tools/workspaceConfinement.ts) defaults to OFF
  // platform-wide, since the CLI's typical single-user, single-invocation use case often has
  // legitimate reasons to read/write outside the current project directory. The API server is
  // a different risk profile: it's the multi-tenant surface, serving many workspaces from one
  // long-running process, where a path-confinement bypass (a prompt-injected instruction from
  // a crawled page, a malicious file in a repo, or the model simply making a mistake) could
  // reach another tenant's project directory. Default it ON specifically here unless the
  // operator has explicitly set the env var themselves (including explicitly opting back out
  // with "false") — this only changes the default for API-server processes, not the CLI.
  if (process.env.XCODER_RESTRICT_TO_WORKSPACE === undefined) {
    process.env.XCODER_RESTRICT_TO_WORKSPACE = "true";
  }

  const app = express();

  // Middleware
  //
  // SECURITY: previously `cors()` with no options — the `cors` package's default is
  // `Access-Control-Allow-Origin: *`, meaning ANY website can make cross-origin requests to
  // this API from a browser. Bearer-token auth (not cookies) limits the worst-case impact
  // (a malicious page still can't silently reuse a signed-in user's session the way it could
  // with cookie auth), but a wildcard origin still lets any site probe the API's behavior and
  // is not appropriate for a production SaaS. Set XCODER_CORS_ORIGIN to a comma-separated
  // allowlist (e.g. "https://app.example.com,https://staging.example.com") in production. With
  // nothing configured, this falls back to same-origin-only (no cross-origin access at all)
  // rather than silently defaulting back to a wildcard.
  const corsOrigins = (process.env.XCODER_CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(cors(corsOrigins.length > 0 ? { origin: corsOrigins } : { origin: false }));
  app.use(express.json({ limit: "1mb" }));

  // Routes
  const router = createRouter();
  app.use("/api/v1", router);

  // 404 catch-all
  app.use((_req, res) => {
    res.status(404).json({ success: false, error: "Not found" });
  });

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[xcoder API] Unhandled error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  });

  const server = app.listen(port, host, () => {
    console.log(`[xcoder API] Listening on http://${host}:${port}`);
    console.log(`[xcoder API] Endpoints:`);
    console.log(`  POST /api/v1/login`);
    console.log(`  POST /api/v1/logout`);
    console.log(`  GET  /api/v1/health`);
    console.log(`  POST /api/v1/chat`);
    console.log(`  POST /api/v1/chat/plan`);
    console.log(`  POST /api/v1/chat/execute`);
    console.log(`  GET  /api/v1/telemetry?log=thinking&limit=50`);
    console.log(`  GET  /api/v1/skills`);
    console.log(`  GET  /api/v1/users`);
    console.log(`  POST /api/v1/users`);
    console.log(`  PUT  /api/v1/users/:id`);
    console.log(`  DELETE /api/v1/users/:id`);
    console.log(`  GET  /api/v1/plans`);
    console.log(`  POST /api/v1/plans`);
    console.log(`  GET  /api/v1/plans/:id`);
    console.log(`  PUT  /api/v1/plans/:id/status`);
    console.log(`  PUT  /api/v1/plans/:planId/tasks/:taskId`);
    console.log(`  POST /api/v1/plans/:id/tasks`);
    console.log(`  DELETE /api/v1/plans/:planId/tasks/:taskId`);
    console.log(`[xcoder API] Auth: Token-based authentication active. First user to register becomes admin.`);
  });

  return server;
}


