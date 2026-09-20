import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { createRouter } from "../routes.js";

/**
 * Whole-surface authentication coverage.
 *
 * This exists because of a real bypass: `registerProjectRoutes(router)` and
 * `registerPlanRoutes(router)` used to be called at the very top of createRouter(), while
 * `router.use(authMiddleware)` is mounted much further down. An Express Router dispatches its
 * layers in registration order, so those 16 routes sat entirely in front of the auth
 * middleware and were reachable with no token at all — `GET /projects` returned 200 and a
 * project list to a completely anonymous caller, and `POST /projects/:id/upload`,
 * `GET /projects/:id/download` and `DELETE /projects/:id/files` were unauthenticated file
 * write, read and delete. Nothing failed loudly, because those handlers read the caller via a
 * helper that degrades to `{ userId: "", isAdmin: false }` when authMiddleware never ran.
 *
 * A unit test of authMiddleware itself would not have caught that — the middleware was always
 * correct, it just wasn't in the request path. So this test doesn't test the middleware: it
 * walks the router's actual layer stack, fires a real unauthenticated HTTP request at every
 * registered route, and asserts each one either rejects with 401/403 or is named in
 * PUBLIC_ROUTES below.
 *
 * Adding a new route therefore forces a decision: it's protected by default, and making it
 * public means adding it to PUBLIC_ROUTES here, in a list whose entries each have to justify
 * themselves. That's the property worth keeping — not the specific list.
 */

/**
 * The complete set of endpoints that are intentionally reachable without a token, and why.
 * Every one of these is required by an unauthenticated client — the login screen, or Docker.
 * Nothing else belongs here.
 */
const PUBLIC_ROUTES = new Set<string>([
  // Credential exchange — these are how a caller *gets* a token, so they cannot require one.
  "POST /login",
  "POST /register",
  "POST /auth/google",

  // Revokes whatever token is in the header. Requiring auth would make an already-invalid
  // token impossible to clean up, and it reveals nothing: with no valid token it's a no-op.
  "POST /logout",

  // Read by the login screen before any token exists, to decide whether this is a fresh
  // install (first account becomes admin) and whether to render the Google button. The Google
  // *client id* is public by design; neither exposes a secret.
  "GET /users/count",
  "GET /auth/google/config",

  // The container healthcheck in docker-compose.yml calls this with no credentials, so it has
  // to stay open. It returns version/uptime/mock-LLM status only — no user or project data.
  "GET /health",
]);

interface RouteRef {
  method: string;
  path: string;
}

/** Walks the Express Router's layer stack and returns every registered method+path pair, in
 *  registration order — which is also dispatch order, and therefore the thing that actually
 *  determines whether authMiddleware runs for a given route. */
function enumerateRoutes(router: express.Router): RouteRef[] {
  const found: RouteRef[] = [];
  for (const layer of (router as unknown as { stack: any[] }).stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      found.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return found;
}

/** Substitutes a throwaway value for any `:param` segment so the request actually reaches the
 *  route. The value never matters: a protected route must reject before it looks at params. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "auth-coverage-probe");
}

let server: Server;
let baseUrl: string;
let routes: RouteRef[];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const router = createRouter();
  routes = enumerateRoutes(router);
  app.use("/api/v1", router);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}/api/v1`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("API authentication coverage", () => {
  it("registers a non-trivial number of routes (guards against the walk silently finding nothing)", () => {
    // Without this, a change to Express's internals that broke enumerateRoutes() would turn
    // the real test below into a vacuous pass over an empty list.
    expect(routes.length).toBeGreaterThan(40);
  });

  it("rejects unauthenticated requests to every route that isn't explicitly public", async () => {
    const leaked: string[] = [];

    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC_ROUTES.has(key)) continue;

      const res = await fetch(`${baseUrl}${concretePath(route.path)}`, {
        method: route.method,
        headers: { "Content-Type": "application/json" },
        body: route.method === "GET" || route.method === "DELETE" ? undefined : "{}",
      });

      // 401 (no/malformed header) and 403 (token present but invalid/expired) are both
      // correct refusals. Anything else means the handler ran for an anonymous caller.
      if (res.status !== 401 && res.status !== 403) {
        leaked.push(`${key} -> ${res.status}`);
      }
    }

    expect(leaked).toEqual([]);
  });

  it("rejects a syntactically valid but unknown bearer token everywhere too", async () => {
    // The no-header case above exercises a different branch of authMiddleware than a
    // well-formed header carrying a token that simply isn't in the store — which is exactly
    // what a stale localStorage token looks like after the API restarts.
    const leaked: string[] = [];

    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC_ROUTES.has(key)) continue;

      const res = await fetch(`${baseUrl}${concretePath(route.path)}`, {
        method: route.method,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer not-a-real-token-just-well-formed",
        },
        body: route.method === "GET" || route.method === "DELETE" ? undefined : "{}",
      });

      if (res.status !== 401 && res.status !== 403) {
        leaked.push(`${key} -> ${res.status}`);
      }
    }

    expect(leaked).toEqual([]);
  });

  it("keeps the project and plan routers behind authMiddleware, not in front of it", () => {
    // The specific regression. Dispatch order is registration order, so "is authMiddleware
    // registered before these routes" is the whole question — assert on position directly
    // rather than only on the observed status codes above.
    const router = createRouter();
    const stack = (router as unknown as { stack: any[] }).stack;
    const authIndex = stack.findIndex((l) => l.name === "authMiddleware");
    expect(authIndex).toBeGreaterThan(-1);

    const guarded = stack
      .map((layer, index) => ({ layer, index }))
      .filter(({ layer }) => layer.route)
      .filter(({ layer }) => /^\/(projects|plans)/.test(layer.route.path));

    expect(guarded.length).toBeGreaterThan(0);
    for (const { layer, index } of guarded) {
      expect.soft(index, `${layer.route.path} must be registered after authMiddleware`).toBeGreaterThan(authIndex);
    }
  });

  it("does not expose the engine registry to anonymous callers", async () => {
    // /engines was public purely because it was registered above authMiddleware. It's only
    // ever read by the Dashboard and Settings pages, both post-login.
    const res = await fetch(`${baseUrl}/engines`);
    expect([401, 403]).toContain(res.status);
  });

  it("serves GET /health without a token, because the container healthcheck depends on it", async () => {
    // The inverse guard: proving the test above isn't passing by accidentally breaking
    // something that has to stay open. docker-compose.yml's api healthcheck calls this
    // unauthenticated, and a 401 here would make the container permanently unhealthy.
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});
