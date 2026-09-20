# xcoder UI — Playwright e2e suite

Browser tests for xcoder's frontend, using [Playwright](https://playwright.dev). See
`test_scenario.md` in this folder for the full scenario catalog (smoke + regression) these specs
implement, organized by feature area.

## What this suite is (and isn't)

This suite drives a **real running xcoder instance** — API server + frontend — in a real
browser. It does not start xcoder for you (there's no `webServer` block in
`playwright.config.ts`): xcoder needs a real LLM backend configured (or
`XCODER_MOCK_LLM=true`) and at least two seeded accounts before these tests are meaningful, so
"just run it and see" would mostly produce confusing failures rather than a useful signal.

## 1. Start xcoder

From the repo root, with whatever LLM provider you want tested (Ollama is the shipped default;
`XCODER_MOCK_LLM=true` also works and is the fastest/cheapest way to get TASK-01/02 and CHAT-01/02
passing without needing a real model call):

```bash
npm run build && npm start        # backend, from the repo root
cd ui && npm run dev              # frontend, in a second terminal — defaults to :5173
```

## 2. Seed the two accounts this suite expects

xcoder's very first account is created through the login screen's own bootstrap flow (no users
yet → "Create the first (admin) account"). Everything after that needs an admin to create the
second account. Fastest path, from a terminal, once the backend above is running:

```bash
# 1. Bootstrap the admin account (only works once — while the user count is genuinely zero)
curl -s -X POST http://localhost:3000/api/v1/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"e2e_admin","password":"e2e-admin-pass-1"}'
# copy the returned "token" from the response for step 2

# 2. Create the second (non-admin) account as that admin
curl -s -X POST http://localhost:3000/api/v1/users \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token from step 1>' \
  -d '{"username":"e2e_user","password":"e2e-user-pass-1","role":"user"}'
```

If your target instance already has real users you don't want to disturb, seed differently-named
accounts and point the suite at them via env vars instead of the defaults above (see below) —
nothing in this suite creates or assumes a specific username beyond what you configure.

## 3. Configure and run

```bash
cd ui
npm install
npx playwright install chromium   # downloads the browser binary Playwright drives

# only needed if you used different values than the defaults in step 2, or a non-default port:
export E2E_BASE_URL=http://localhost:5173
export E2E_ADMIN_USERNAME=e2e_admin
export E2E_ADMIN_PASSWORD=e2e-admin-pass-1
export E2E_USER_USERNAME=e2e_user
export E2E_USER_PASSWORD=e2e-user-pass-1

npm run test:e2e          # headless, CLI output
npm run test:e2e:ui       # Playwright's interactive UI mode — best for writing/debugging specs
npm run test:e2e:headed   # headless=false, watch the browser actually do it
```

## Files in this folder

- `test_scenario.md` — the scenario catalog (source of truth for *what* is worth testing).
- `fixtures.ts` — shared setup: reads the env vars above, logs in via the real API (fast, and
  keeps the login *form* itself as auth.spec.ts's dedicated concern rather than re-testing it in
  every other spec), and exposes ready-to-use `adminPage`/`userPage` fixtures.
- `auth.spec.ts`, `navigation.spec.ts`, `dashboard-task.spec.ts`, `dashboard-chat.spec.ts`,
  `projects.spec.ts`, `workspace.spec.ts`, `codegraph.spec.ts`, `security-ops.spec.ts`,
  `audit-log.spec.ts`, `settings.spec.ts`, `users.spec.ts` — one file per feature area, matching
  `test_scenario.md`'s sections.

## Notes on how these are written

- Most of xcoder's form `<label>` elements aren't `htmlFor`-associated with their `<input>`/
  `<select>` (a pre-existing accessibility gap, not something this suite works around silently —
  see the note at the bottom of `test_scenario.md`'s catalog). Where `page.getByLabel()` would
  normally be the right tool, these specs instead scope a CSS locator to the enclosing `.field`
  div, e.g. `page.locator('.field', { hasText: 'Host' }).locator('input')`.
- Tests that mutate shared server state (creating a project, adding a Security Ops allowlist
  entry, creating a user) generate a unique-per-run name (timestamp-suffixed) so repeated runs
  against the same instance don't collide with leftovers from a previous run, and clean up after
  themselves where the UI makes that possible.
- `fullyParallel` is off and `workers` is pinned to 1 in `playwright.config.ts` — several specs
  share the same seeded admin/user accounts and mutate the same server-side lists (allowlist,
  project list, user list), so running them concurrently would be flaky by construction rather
  than a real bug. This trades speed for determinism, which is the right trade for a suite this
  size.
