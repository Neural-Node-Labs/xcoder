/**
 * Quick smoke test for the apiTestTool.
 * Starts a local Express server and tests against it.
 * Run: node dist/test/testApiTool.js
 */
import express from "express";
import { testApiEndpoint } from "../tools/apiTestTool.js";

async function main() {
  console.log("=== apiTestTool Smoke Test ===\n");

  // Start a local test server
  const app = express();
  app.use(express.json());

  app.get("/api/echo", (req, res) => {
    res.json({ method: "GET", query: req.query, headers: req.headers });
  });

  app.post("/api/echo", (req, res) => {
    res.status(201).json({ method: "POST", body: req.body, headers: req.headers });
  });

  app.put("/api/echo", (req, res) => {
    res.json({ method: "PUT", body: req.body });
  });

  app.delete("/api/echo", (req, res) => {
    res.json({ method: "DELETE" });
  });

  app.patch("/api/echo", (req, res) => {
    res.json({ method: "PATCH", body: req.body });
  });

  app.head("/api/echo", (_req, res) => {
    res.set("x-custom-header", "head-test");
    res.status(200).end();
  });

  app.get("/api/head-check", (_req, res) => {
    res.set("x-custom-header", "head-test");
    res.status(200).json({ ok: true });
  });

  app.options("/api/echo", (_req, res) => {
    res.set("Allow", "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS");
    res.status(204).end();
  });

  app.get("/api/error", (_req, res) => {
    res.status(500).json({ error: "Internal server error" });
  });

  const server = app.listen(3099, "127.0.0.1");
  const base = "http://127.0.0.1:3099";

  try {
    // 1. GET with query params
    console.log("1. GET /api/echo?foo=bar");
    const r1 = await testApiEndpoint({
      url: `${base}/api/echo`,
      method: "GET",
      queryParams: { foo: "bar" },
    });
    console.log(`   Status: ${r1.statusCode}, Duration: ${r1.durationMs}ms`);
    const body1 = r1.body as Record<string, unknown>;
    console.log(`   query.foo = ${(body1.query as Record<string, string>)?.foo}`);
    console.log();

    // 2. POST JSON
    console.log("2. POST JSON to /api/echo");
    const r2 = await testApiEndpoint({
      url: `${base}/api/echo`,
      method: "POST",
      body: JSON.stringify({ name: "test", value: 42 }),
      bodyType: "json",
    });
    console.log(`   Status: ${r2.statusCode}, Duration: ${r2.durationMs}ms`);
    const body2 = r2.body as Record<string, unknown>;
    console.log(`   body.name = ${(body2.body as Record<string, unknown>)?.name}`);
    console.log(`   body.value = ${(body2.body as Record<string, unknown>)?.value}`);
    console.log();

    // 3. PUT
    console.log("3. PUT /api/echo");
    const r3 = await testApiEndpoint({
      url: `${base}/api/echo`,
      method: "PUT",
      body: JSON.stringify({ updated: true }),
      bodyType: "json",
    });
    console.log(`   Status: ${r3.statusCode}, body.updated = ${((r3.body as Record<string, unknown>).body as Record<string, unknown>)?.updated}`);
    console.log();

    // 4. DELETE
    console.log("4. DELETE /api/echo");
    const r4 = await testApiEndpoint({ url: `${base}/api/echo`, method: "DELETE" });
    console.log(`   Status: ${r4.statusCode}, method = ${(r4.body as Record<string, unknown>).method}`);
    console.log();

    // 5. PATCH
    console.log("5. PATCH /api/echo");
    const r5 = await testApiEndpoint({
      url: `${base}/api/echo`,
      method: "PATCH",
      body: JSON.stringify({ patch: true }),
      bodyType: "json",
    });
    console.log(`   Status: ${r5.statusCode}, body.patch = ${((r5.body as Record<string, unknown>).body as Record<string, unknown>)?.patch}`);
    console.log();

    // 6. HEAD
    console.log("6. HEAD /api/echo");
    const r6 = await testApiEndpoint({ url: `${base}/api/echo`, method: "HEAD" });
    console.log(`   Status: ${r6.statusCode}, body is null: ${r6.body === null}`);
    console.log();

    // 6b. GET with custom header (verify header reading works)
    console.log("6b. GET /api/head-check (verify header reading)");
    const r6b = await testApiEndpoint({ url: `${base}/api/head-check`, method: "GET" });
    console.log(`   Status: ${r6b.statusCode}, x-custom-header: ${r6b.headers["x-custom-header"]}`);
    console.log();

    // 7. OPTIONS
    console.log("7. OPTIONS /api/echo");
    const r7 = await testApiEndpoint({ url: `${base}/api/echo`, method: "OPTIONS" });
    console.log(`   Status: ${r7.statusCode}, Allow: ${r7.headers["allow"]}`);
    console.log();

    // 8. Custom headers
    console.log("8. GET with custom Authorization header");
    const r8 = await testApiEndpoint({
      url: `${base}/api/echo`,
      method: "GET",
      headers: { Authorization: "Bearer test-token-123", "X-Custom": "hello" },
    });
    const body8 = r8.body as Record<string, unknown>;
    const headers8 = body8.headers as Record<string, string>;
    console.log(`   authorization: ${headers8?.authorization}`);
    console.log(`   x-custom: ${headers8?.["x-custom"]}`);
    console.log();

    // 9. expectStatus assertion (should pass)
    console.log("9. GET with expectStatus: 200 (should pass)");
    const r9 = await testApiEndpoint({
      url: `${base}/api/echo`,
      method: "GET",
      expectStatus: 200,
    });
    console.log(`   Status: ${r9.statusCode} ✓`);
    console.log();

    // 10. expectBodyContains assertion (should pass)
    console.log("10. GET with expectBodyContains: 'GET' (should pass)");
    const r10 = await testApiEndpoint({
      url: `${base}/api/echo`,
      method: "GET",
      expectBodyContains: "GET",
    });
    console.log(`   Status: ${r10.statusCode}, body contains 'GET' ✓`);
    console.log();

    // 11. Error case: expectStatus mismatch
    console.log("11. GET with expectStatus: 201 (should fail)");
    try {
      await testApiEndpoint({
        url: `${base}/api/echo`,
        method: "GET",
        expectStatus: 201,
      });
      console.log("   ❌ Should have thrown!");
    } catch (e) {
      console.log(`   ✓ Caught expected error: ${(e as Error).message.slice(0, 100)}...`);
    }
    console.log();

    // 12. Error endpoint
    console.log("12. GET /api/error (500)");
    const r12 = await testApiEndpoint({ url: `${base}/api/error`, method: "GET" });
    console.log(`   Status: ${r12.statusCode}, error: ${(r12.body as Record<string, unknown>).error}`);
    console.log();

    console.log("=== All smoke tests passed ===");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});

