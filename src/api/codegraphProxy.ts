/**
 * Minimal same-origin reverse proxy for the CodeGraph API, mounted at /codegraph-api in
 * server.ts. Lets the bundled codegraph-ui (served statically at /codegraph-ui, see
 * CODEGRAPH_UI_DIST) talk to CodeGraph without CORS and without exposing CodeGraph's own port
 * externally. Registered on the raw `app` BEFORE express.json() so large request bodies
 * (project .zip uploads, up to CodeGraph's own 200MB limit) stream straight through rather than
 * being buffered/parsed by Express first.
 */

import http from "node:http";
import https from "node:https";
import type { Request, Response } from "express";
import { getCodegraphConnection } from "./codegraphKeyStore.js";

export function codegraphProxyMiddleware() {
  return (req: Request, res: Response) => {
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
