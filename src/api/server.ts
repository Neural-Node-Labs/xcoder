import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRouter } from "./routes.js";
import { codegraphProxyMiddleware } from "./codegraphProxy.js";
import { CODEGRAPH_UI_DIST, autoConnectFromEnv } from "./codegraphProcess.js";
import { initOpenTelemetry } from "../telemetry/otel.js";
import { closeCache } from "../cache/index.js";
// Auth is always enabled — no more static admin credentials

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This file compiles to dist/api/server.js, so ../../ui/dist resolves to <project-root>/ui/dist
// — the built dashboard's static bundle (see ui/package.json's "build" script / STANDALONE.md).
// Mirrors how CODEGRAPH_UI_DIST is resolved in codegraphProcess.ts. Not present until `ui` has
// been built at least once; express.static below is a no-op (falls through to the SPA fallback,
// which 404s with a helpful message) until then, same tolerant-of-not-being-built pattern the
// CodeGraph Explorer mount already uses.
export const XCODER_UI_DIST = path.join(__dirname, "..", "..", "ui", "dist");

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
  // OpenTelemetry (no-op unless XCODER_OTEL_ENABLED / OTEL_EXPORTER_OTLP_ENDPOINT is set). Never throws.
  const otelShutdown = initOpenTelemetry();
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

  // Behind nginx/a load balancer req.ip is the proxy's address unless told otherwise, which
  // would make every user share one login-limiter bucket. XCODER_TRUST_PROXY = number of
  // proxy hops (docker-compose sets 1). Unset = trust none (a client cannot spoof its IP).
  const trust = process.env.XCODER_TRUST_PROXY;
  if (trust) app.set("trust proxy", /^\d+$/.test(trust) ? Number(trust) : trust);

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

  // Security headers — applied to every response this process serves directly: the JSON API,
  // and (standalone/no-Docker deployments only — see STANDALONE.md) the dashboard's static
  // files and SPA fallback below, since there's no nginx in front to add them in that case. The
  // Docker deployment's nginx (ui/nginx.conf) sets the identical policy itself for its own
  // static responses — keep the two in sync if this ever changes.
  //
  // The CSP's script-src/style-src/connect-src/frame-src carve-outs for accounts.google.com are
  // exactly what Google's own Identity Services docs specify for a CSP-protected page
  // (https://developers.google.com/identity/gsi/web/guides/client-library#content_security_policy)
  // — harmless and unused when XCODER_GOOGLE_CLIENT_ID isn't set (LoginPage.tsx only loads that
  // script when it is). Cross-Origin-Opener-Policy is relaxed to same-origin-allow-popups
  // rather than left at the (stricter) default specifically because Google's own sign-in popup
  // flow needs to talk back to the window that opened it — omitting this breaks that flow
  // silently (the popup opens but the result never reaches the page), the same way a CSP
  // mistake here would; both are the kind of failure that won't show up in an automated test
  // but is immediately obvious in a real browser, so smoke-test login by hand after deploying.
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' https://accounts.google.com/gsi/client",
        "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style https://fonts.googleapis.com",
        "connect-src 'self' https://accounts.google.com/gsi/",
        "frame-src 'self' https://accounts.google.com/gsi/",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'self'",
      ].join("; ")
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    next();
  });

  // Embedded CodeGraph Explorer (integrations/codegraph/codegraph-ui, built to dist/) and its
  // API proxy. Mounted BEFORE express.json() so proxied requests — including large project .zip
  // uploads — stream through untouched rather than being buffered/JSON-parsed first. Both are
  // no-ops (static: 404s until built; proxy: 503s until CodeGraph is connected) rather than
  // errors when CodeGraph isn't set up, so this is always safe to mount.
  app.use("/codegraph-ui", express.static(CODEGRAPH_UI_DIST));
  app.use("/codegraph-api", codegraphProxyMiddleware());

  app.use(express.json({ limit: "1mb" }));

  // Routes
  const router = createRouter();
  app.use("/api/v1", router);

  // xcoder's own dashboard (ui/, built to ui/dist/) — serving it from this same process is
  // what makes a Docker-free / standalone deployment a single process on one port instead of
  // needing a separate nginx container (see docker-compose.yml's `ui` service) or a Vite dev
  // server. Static assets first (JS/CSS/images get their real content-type and far-future
  // cache headers from express.static); anything else that isn't an /api/v1, /codegraph-ui, or
  // /codegraph-api request falls through to index.html so client-side routing (Sidebar's page
  // switching) works on a hard refresh or a deep link, not just on in-app navigation.
  const uiIndexHtml = path.join(XCODER_UI_DIST, "index.html");
  app.use(express.static(XCODER_UI_DIST));
  app.get(/^\/(?!api\/v1|codegraph-ui|codegraph-api).*/, (req, res, next) => {
    if (req.method !== "GET" || !fs.existsSync(uiIndexHtml)) {
      next();
      return;
    }
    res.sendFile(uiIndexHtml);
  });

  // 404 catch-all
  app.use((req, res) => {
    // Echoes back exactly what arrived (method + path) rather than a bare "Not found" — the
    // single most useful thing for diagnosing a misrouted request (wrong reverse-proxy rewrite,
    // a client missing the /api/v1 prefix, a stale frontend build hitting a renamed route,
    // etc.): the caller can immediately see whether xcoder received the path they expected.
    const uiBuilt = fs.existsSync(uiIndexHtml);
    res.status(404).json({
      success: false,
      error: uiBuilt
        ? `Not found: ${req.method} ${req.originalUrl}. Every xcoder API endpoint is mounted under /api/v1 — if that prefix is missing here, check whatever sits in front of this server (reverse proxy, dev server proxy) rather than xcoder's own routing.`
        : `Not found: ${req.method} ${req.originalUrl}. The dashboard hasn't been built yet (no ui/dist) — run "npm run ui:build", or "npm run build:standalone" for a full standalone build. Every xcoder API endpoint is mounted under /api/v1.`,
    });
  });

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[xcoder API] Unhandled error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  });

  const server: import("http").Server = app.listen(port, host, () => {
    console.log(`[xcoder API] Listening on http://${host}:${port}`);
    if (fs.existsSync(uiIndexHtml)) {
      console.log(`[xcoder UI] Dashboard: http://${host}:${port}/`);
    } else {
      console.log(`[xcoder UI] Dashboard not built (no ui/dist) — run "npm run ui:build" to serve it from this same process.`);
    }
    // Fire-and-forget: if XCODER_CODEGRAPH_URL + XCODER_CODEGRAPH_ADMIN_PASSWORD are set (the
    // docker-compose `codegraph-api` service's shape), connect to it in the background. Doesn't
    // block xcoder's own startup — failure here is logged and left for manual connection from
    // Platform > Tools rather than crashing the API server over an optional integration.
    autoConnectFromEnv();
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

  // Flush pending spans/metrics when the server closes.
  server.on("close", () => { void closeCache().catch(() => {}); });
  server.on("close", () => { void otelShutdown.then((shutdown) => shutdown()).catch(() => {}); });
  return server;
}


