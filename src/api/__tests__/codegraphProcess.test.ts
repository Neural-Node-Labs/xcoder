import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Covers the connection-state reporting the CodeGraph Explorer page depends on. Regression
 * context: under docker-compose the page used to show an empty panel with no explanation while
 * xcoder was still connecting to (or had failed to reach) the codegraph-api sibling service, and
 * never retried after the first background attempt gave up.
 */

type LoginBehavior = "ok" | "reject";

function startFakeCodegraph(login: () => LoginBehavior): Promise<{ url: string; close: () => Promise<void>; loginCalls: () => number }> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" }).end("<html></html>");
    } else if (req.method === "POST" && req.url === "/api/auth/login") {
      calls++;
      req.resume();
      if (login() === "ok") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ token: "tok", user: { id: 1, username: "admin", role: "admin", api_key: "cg_key" } }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" }).end("{}");
      }
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        loginCalls: () => calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  if (!cond()) throw new Error("waitFor timed out");
}

describe("codegraphProcess connection state", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.XCODER_CODEGRAPH_API_KEY;
  });
  afterEach(() => {
    delete process.env.XCODER_CODEGRAPH_URL;
    delete process.env.XCODER_CODEGRAPH_ADMIN_PASSWORD;
  });

  it("reports running + external after connecting to a sibling service", async () => {
    const fake = await startFakeCodegraph(() => "ok");
    try {
      const mod = await import("../codegraphProcess.js");
      const status = await mod.connectExternalCodegraph(fake.url, "pw", 2000);
      expect(status.running).toBe(true);
      expect(status.external).toBe(true);
      expect(status.connecting).toBe(false);
      expect(status.connectError).toBeUndefined();
      expect(mod.getSsoSession()?.apiUrl).toBe("/codegraph-api");
    } finally {
      await fake.close();
    }
  });

  it("surfaces configuredUrl, and a connectError instead of silence when the login is rejected", async () => {
    const fake = await startFakeCodegraph(() => "reject");
    process.env.XCODER_CODEGRAPH_URL = fake.url;
    process.env.XCODER_CODEGRAPH_ADMIN_PASSWORD = "wrong";
    try {
      const mod = await import("../codegraphProcess.js");
      expect(mod.getStatus().configuredUrl).toBe(fake.url);

      mod.autoConnectFromEnv();
      expect(mod.getStatus().connecting).toBe(true);

      await waitFor(() => !mod.getStatus().connecting);
      const status = mod.getStatus();
      expect(status.running).toBe(false);
      expect(status.connectError).toMatch(/login .* failed \(401\)/);
    } finally {
      await fake.close();
    }
  });

  it("retries a failed connection when status is polled, but throttles it", async () => {
    let behavior: LoginBehavior = "reject";
    const fake = await startFakeCodegraph(() => behavior);
    process.env.XCODER_CODEGRAPH_URL = fake.url;
    process.env.XCODER_CODEGRAPH_ADMIN_PASSWORD = "pw";
    try {
      const mod = await import("../codegraphProcess.js");
      mod.autoConnectFromEnv();
      await waitFor(() => !mod.getStatus().connecting);
      const callsAfterFirst = fake.loginCalls();

      // Within the throttle window: a polling UI must not be able to hammer the service.
      mod.retryAutoConnectIfNeeded(60_000);
      expect(fake.loginCalls()).toBe(callsAfterFirst);
      expect(mod.getStatus().connecting).toBe(false);

      // codegraph-api "comes up" late — the next poll past the throttle window connects.
      behavior = "ok";
      mod.retryAutoConnectIfNeeded(0);
      await waitFor(() => mod.getStatus().running);
      expect(mod.getStatus().connectError).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it("does nothing when a fixed API key is configured (no login needed)", async () => {
    process.env.XCODER_CODEGRAPH_URL = "http://127.0.0.1:1";
    process.env.XCODER_CODEGRAPH_ADMIN_PASSWORD = "pw";
    process.env.XCODER_CODEGRAPH_API_KEY = "fixed";
    const mod = await import("../codegraphProcess.js");
    expect(mod.getStatus().configuredUrl).toBeUndefined();
    mod.autoConnectFromEnv();
    expect(mod.getStatus().connecting).toBe(false);
  });
});
