/**
 * Minimal same-origin reverse proxy for the CodeGraph API, mounted at /codegraph-api in
 * server.ts. Lets the bundled codegraph-ui (served statically at /codegraph-ui, see
 * CODEGRAPH_UI_DIST) talk to CodeGraph without CORS and without exposing CodeGraph's own port
 * externally. Registered on the raw `app` BEFORE express.json() so large request bodies
 * (project .zip uploads, up to CodeGraph's own 200MB limit) stream straight through rather than
 * being buffered/parsed by Express first.
 *
 * SECURITY: requires a valid xcoder session before forwarding anything. CodeGraph's own
 * endpoints do all require its own auth (every /api/* route depends on get_current_user — see
 * codegraph/app/api.py), but that's not sufficient on its own: mounted directly on `app` (ahead
 * of the /api/v1 router, for the express.json() reason above) meant this proxy sat entirely
 * outside authMiddleware and its rate limiting. A completely anonymous caller — no xcoder
 * account at all — could hit /codegraph-api/api/auth/login directly and brute-force CodeGraph's
 * admin password with zero rate limiting, bypassing xcoder's own 10-attempts/15-minute login
 * limiter entirely.
 *
 * The check has to be cookie-based, not the Authorization-header check authMiddleware uses
 * elsewhere: the actual browser requests hitting this proxy are made by codegraph-ui's own JS
 * (inside the iframe), which attaches CodeGraph's own token in that header, not xcoder's — an
 * xcoder Bearer-token check would reject every legitimate request from the embedded UI just as
 * readily as an attacker's. A cookie set on xcoder login (see routes.ts's XCODER_PROXY_COOKIE
 * usage) is sent by the browser automatically for any same-origin request under this cookie's
 * path, regardless of which script on the page issued that request — which is exactly the
 * "does this browser currently hold a valid xcoder session" signal this needs.
 */

import http from "node:http";
import https from "node:https";
import type { Request, Response } from "express";
import { getCodegraphConnection } from "./codegraphKeyStore.js";
import { validateToken } from "./auth.js";

/** Cookie name shared with routes.ts (set on login/register/google-login, cleared on logout). */
export const XCODER_PROXY_COOKIE = "xcoder_proxy_token";

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function isAuthorized(req: Request): boolean {
  const cookieToken = readCookie(req, XCODER_PROXY_COOKIE);
  if (cookieToken && validateToken(cookieToken)) return true;
  // Also accept a normal xcoder Bearer token, for non-browser callers (curl, scripts) that
  // don't carry cookies at all — cookies remain the primary path since that's what the actual
  // embedded-iframe traffic uses.
  const header = req.headers.authorization;
  if (header) {
    const parts = header.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer" && validateToken(parts[1])) return true;
  }
  return false;
}

export function codegraphProxyMiddleware() {
  return (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ success: false, error: "Missing or invalid xcoder session — sign in to xcoder first." });
      return;
    }

    const conn = getCodegraphConnection();
    if (!conn) {
      res.status(503).json({ success: false, error: "CodeGraph is not connected. Start it (or connect an external instance) under Platform > Integrations." });
      return;
    }

    let target: URL;
    try {
      target = new URL(conn.baseUrl);
    } catch {
      res.status(500).json({ success: false, error: "CodeGraph integration has an invalid baseUrl configured." });
      return;
    }

    const transport = target.protocol === "https:" ? https : http;
    const { host: _host, connection: _connection, ...forwardedHeaders } = req.headers;

    const proxyReq = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: req.url, // req.url is already relative to the /codegraph-api mount point, e.g. "/api/auth/login"
        method: req.method,
        headers: { ...forwardedHeaders, host: target.host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).json({ success: false, error: `CodeGraph proxy error: ${err.message}` });
      }
    });

    req.pipe(proxyReq);
  };
}
