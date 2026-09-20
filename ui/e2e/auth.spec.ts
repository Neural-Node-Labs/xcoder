import { test as base, expect } from "@playwright/test";
import { ADMIN_USERNAME, ADMIN_PASSWORD, USER_USERNAME, USER_PASSWORD, apiLogin } from "./fixtures";

/**
 * Authentication — implements AUTH-01..AUTH-05 from test_scenario.md.
 *
 * Unlike every other spec, these drive the real login *form* rather than using fixtures.ts's
 * API-login shortcut — the form is exactly what's under test here.
 *
 * AUTH-01 (first-run bootstrap) is conditional: it only runs against a genuinely fresh instance
 * with zero users. On any instance that's already seeded (which is what the rest of this suite
 * requires), it skips rather than failing, since the bootstrap path is a one-time thing that
 * can't be re-entered without wiping the user store.
 */

const test = base;

/** Login form fields, scoped through their .field wrapper since labels aren't htmlFor-linked. */
function usernameInput(page: import("@playwright/test").Page) {
  return page.locator(".field", { hasText: "Username" }).locator("input");
}
function passwordInput(page: import("@playwright/test").Page) {
  return page.locator(".field", { hasText: "Password" }).locator("input");
}

test.beforeEach(async ({ page }) => {
  // Always start from a clean, logged-out state — otherwise a leftover token from another spec
  // would skip the login screen entirely and these assertions would be meaningless.
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
});

test("AUTH-01: first-run bootstrap offers admin creation on a genuinely empty instance", async ({ page, request }) => {
  const res = await request.get("/api/v1/users/count");
  const body = await res.json();
  test.skip(
    !body?.data || body.data.count !== 0,
    "Instance already has users — the one-time bootstrap path can't be re-entered without wiping the user store."
  );

  await expect(page.getByText(/No accounts exist yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create admin account" })).toBeVisible();

  await usernameInput(page).fill(ADMIN_USERNAME);
  await passwordInput(page).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Create admin account" }).click();

  // Straight into the app, already signed in as the new admin.
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar").getByText(ADMIN_USERNAME)).toBeVisible();
});

test("AUTH-02: valid credentials sign in and land on the app shell", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  await usernameInput(page).fill(USER_USERNAME);
  await passwordInput(page).fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar").getByText(USER_USERNAME)).toBeVisible();
  // Default landing page.
  await expect(page.getByRole("button", { name: /Run a task/ })).toBeVisible();
});

test("AUTH-03: a wrong password shows an inline error and stays on the login screen", async ({ page }) => {
  await usernameInput(page).fill(USER_USERNAME);
  await passwordInput(page).fill("definitely-the-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Invalid username or password")).toBeVisible();
  // Crucially: still on the login screen, no session created.
  await expect(page.locator(".login-card")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("xcoder_token"))).toBeNull();
});

test("AUTH-04: logging out clears the session and does not silently re-authenticate on reload", async ({ page }) => {
  await usernameInput(page).fill(USER_USERNAME);
  await passwordInput(page).fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();

  // The sign-out control is the power icon in the sidebar footer.
  await page.locator(".sidebar-footer").getByRole("button").click();

  await expect(page.locator(".login-card")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("xcoder_token"))).toBeNull();

  // A reload must not resurrect the session.
  await page.reload();
  await expect(page.locator(".login-card")).toBeVisible();
});

test("AUTH-05: a stale token is force-cleared back to the login screen instead of dead-ending", async ({ page }) => {
  // Simulates the real-world case this guards: xcoder's token store is in-memory, so every API
  // process restart invalidates every previously-issued token while the browser still holds one.
  await page.evaluate(() => {
    localStorage.setItem("xcoder_token", "stale-token-from-a-previous-server-run");
    localStorage.setItem("xcoder_user_id", "1");
    localStorage.setItem("xcoder_username", "ghost");
    localStorage.setItem("xcoder_role", "admin");
  });
  await page.goto("/");

  // The boot-time session check should wipe the bad session and show the login screen, rather
  // than leaving the user staring at a broken shell with no way out.
  await expect(page.locator(".login-card")).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    expect(await page.evaluate(() => localStorage.getItem("xcoder_token"))).toBeNull();
  }).toPass({ timeout: 15_000 });

  // The app shell must never have rendered at all. Previously it did — the stale token was
  // trusted, the whole signed-in UI mounted, and only then did requests start failing, leaving
  // the user inside an app where nothing worked and nothing explained why.
  await expect(page.locator(".sidebar")).toHaveCount(0);

  // And the user is told why they're looking at a login form, rather than being bounced here
  // with no explanation (which reads as a bug rather than as a session timeout).
  await expect(page.getByText(/session ended/i)).toBeVisible();
});

test("AUTH-07: a valid restored session is NOT interrupted by the boot check", async ({ page, request }) => {
  // The inverse guard for AUTH-05. It would be easy to make stale tokens fail safely by simply
  // distrusting every restored token — that would pass AUTH-05 and be useless, because it
  // would also sign out every legitimate returning user. So: a good token must survive a
  // reload untouched, with no login screen and no expiry notice flashing up on the way.
  const session = await apiLogin(request, USER_USERNAME, USER_PASSWORD);
  await page.evaluate((s) => {
    localStorage.setItem("xcoder_token", s.token);
    localStorage.setItem("xcoder_user_id", s.userId);
    localStorage.setItem("xcoder_username", s.username);
    localStorage.setItem("xcoder_role", s.role);
  }, session);
  await page.goto("/");

  await expect(page.locator(".sidebar")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".login-card")).toHaveCount(0);
  await expect(page.getByText(/session ended/i)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("xcoder_token"))).toBe(session.token);
});
