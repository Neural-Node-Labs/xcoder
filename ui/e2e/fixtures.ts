import { test as base, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * Credentials this suite expects to already exist on the target server — see e2e/README.md for
 * exactly how to seed them. Intentionally NOT hardcoded to a single "admin"/"password123" pair:
 * a shared demo/CI instance may already have real accounts, so every test reads from env vars
 * with a same-named fallback only for a fresh local instance seeded per the README.
 */
export const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? "e2e_admin";
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-pass-1";
export const USER_USERNAME = process.env.E2E_USER_USERNAME ?? "e2e_user";
export const USER_PASSWORD = process.env.E2E_USER_PASSWORD ?? "e2e-user-pass-1";

export interface SeededSession {
  token: string;
  userId: string;
  username: string;
  role: "admin" | "user";
}

/** Logs in via the real API (not the UI) and returns the session xcoder's frontend would have
 *  stored after a UI login — see AuthContext.tsx's `persist()` for the exact shape. Used by
 *  `loginAs()` below to skip re-testing the login form in every unrelated spec; the login form
 *  itself gets its own dedicated coverage in auth.spec.ts. */
export async function apiLogin(request: APIRequestContext, username: string, password: string): Promise<SeededSession> {
  const res = await request.post("/api/v1/login", { data: { username, password } });
  if (!res.ok()) {
    throw new Error(
      `apiLogin('${username}') failed with ${res.status()}: ${await res.text()}. ` +
        `See e2e/README.md — this user needs to exist on the target server before running the suite.`
    );
  }
  const body = await res.json();
  if (!body.success) throw new Error(`apiLogin('${username}') failed: ${body.error}`);
  return { token: body.data.token, userId: body.data.userId, username: body.data.username, role: body.data.role };
}

/** Injects a session into localStorage under the same keys AuthContext.tsx reads on load
 *  (xcoder_token/xcoder_user_id/xcoder_username/xcoder_role), then loads the app so it picks
 *  the session up. localStorage is origin-scoped, so this only works after at least one
 *  same-origin navigation — callers don't need to think about that, this does it for them. */
export async function loginAs(page: Page, session: SeededSession): Promise<void> {
  await page.goto("/");
  await page.evaluate((s) => {
    localStorage.setItem("xcoder_token", s.token);
    localStorage.setItem("xcoder_user_id", s.userId);
    localStorage.setItem("xcoder_username", s.username);
    localStorage.setItem("xcoder_role", s.role);
  }, session);
  await page.goto("/");
  // Sidebar only renders once AuthContext + the app shell have mounted with a real session.
  await expect(page.locator(".sidebar")).toBeVisible();
}

/** Clicks a sidebar nav item by its visible label (see Sidebar.tsx's NAV table) and waits for
 *  the corresponding content heading to render, so callers don't need their own wait logic. */
export async function goToPage(page: Page, navLabel: string): Promise<void> {
  await page.getByRole("button", { name: navLabel, exact: false }).click();
}

/**
 * The app keeps every page it has visited mounted and only hides the inactive ones (see the
 * keepAlive() helper in src/App.tsx) so page state survives navigation. Playwright's locators
 * don't skip hidden elements, so an unscoped `locator("select")` or `.field` filter — written
 * back when leaving a page unmounted it — would also match the Dashboard's hidden copy and either
 * pick the wrong element or trip strict mode. Restricting page-level locators to visible
 * elements restores what every spec here actually means by "on this page".
 */
function visibleOnly(page: Page): Page {
  const wrap = <K extends "locator" | "getByText" | "getByPlaceholder" | "getByLabel">(name: K) => {
    const original = (page[name] as (...a: never[]) => ReturnType<Page["locator"]>).bind(page);
    (page as unknown as Record<string, unknown>)[name] = (...args: never[]) => original(...args).filter({ visible: true });
  };
  wrap("locator");
  wrap("getByText");
  wrap("getByPlaceholder");
  wrap("getByLabel");
  return page;
}

type Fixtures = {
  adminSession: SeededSession;
  userSession: SeededSession;
  adminPage: Page;
  userPage: Page;
};

/** Extends the base Playwright test with ready-to-use logged-in pages for both roles, so most
 *  specs can just destructure `{ adminPage }` or `{ userPage }` instead of repeating the
 *  apiLogin()+loginAs() dance. Sessions are fetched once per test via API (fast, not exercising
 *  the login *form* — that's auth.spec.ts's job), then injected into a fresh page's
 *  localStorage. */
export const test = base.extend<Fixtures>({
  adminSession: async ({ request }, use) => {
    await use(await apiLogin(request, ADMIN_USERNAME, ADMIN_PASSWORD));
  },
  userSession: async ({ request }, use) => {
    await use(await apiLogin(request, USER_USERNAME, USER_PASSWORD));
  },
  adminPage: async ({ page, adminSession }, use) => {
    await loginAs(visibleOnly(page), adminSession);
    await use(page);
  },
  userPage: async ({ page, userSession }, use) => {
    await loginAs(visibleOnly(page), userSession);
    await use(page);
  },
});

export { expect };
