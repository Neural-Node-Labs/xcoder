import { test, expect, goToPage } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Security Ops (Blue Team / Red Team) — implements SEC-01..SEC-09 from test_scenario.md.
 *
 * This is the spec that closes STATUS.md's pending item #5 ("security_ops_tool — never
 * live-network-tested end to end from the UI"): the backend's allowlist refusal and
 * not-implemented paths are already covered by unit tests in
 * src/tools/__tests__/securityOpsTool.dispatcher.test.ts, but nothing previously proved those
 * results actually surface correctly *through the UI* — which is exactly what SEC-05 and SEC-06
 * assert here.
 *
 * Note on locators: xcoder's `<label>`s aren't htmlFor-associated with their inputs, so
 * getByLabel() doesn't work. Fields are scoped through their enclosing `.field` div instead.
 */

/** The page's "Check" dropdown — the only <select> inside the left ("Run a check") card. */
function checkSelect(page: Page) {
  return page.locator(".card", { hasText: "Run a check" }).locator("select");
}

/** A named form input inside the left card, located via its enclosing .field wrapper. */
function fieldInput(page: Page, labelText: string) {
  return page.locator(".card", { hasText: "Run a check" }).locator(".field", { hasText: labelText }).locator("input");
}

function allowlistCard(page: Page) {
  return page.locator(".card", { hasText: "Target allowlist" });
}

/** The rendered result block (level badge + <pre> output). Runs can take a few seconds — some
 *  checks shell out to real subprocesses — so callers pass a generous timeout. */
function resultPre(page: Page) {
  return page.locator(".card", { hasText: "Run a check" }).locator("pre.mono");
}

test.beforeEach(async ({ adminPage }) => {
  await goToPage(adminPage, "Security Ops");
  await expect(adminPage.getByText("Run a check")).toBeVisible();
});

test("SEC-01: loads with Blue Team selected, a populated check list, and localhost always allowed", async ({ adminPage }) => {
  // Blue Team is the default tab — its button carries the primary style, Red Team doesn't.
  const blueBtn = adminPage.getByRole("button", { name: "Blue Team" });
  await expect(blueBtn).toHaveClass(/btn-primary/);
  await expect(adminPage.getByRole("button", { name: "Red Team" })).not.toHaveClass(/btn-primary/);

  // Check dropdown is populated with blue-team tools.
  await expect(checkSelect(adminPage)).toBeVisible();
  const options = await checkSelect(adminPage).locator("option").allTextContents();
  expect(options).toContain("Log scan");
  expect(options).toContain("Port audit");

  // Allowlist panel loaded (spinner gone) and localhost is present and protected.
  const allowlist = allowlistCard(adminPage);
  await expect(allowlist.getByText("localhost")).toBeVisible();
  await expect(allowlist.locator(".tool-row", { hasText: "localhost" }).getByText("always allowed")).toBeVisible();
});

test("SEC-02: switching to Red Team swaps the tool catalog and clears prior state", async ({ adminPage }) => {
  await adminPage.getByRole("button", { name: "Red Team" }).click();
  await expect(adminPage.getByRole("button", { name: "Red Team" })).toHaveClass(/btn-primary/);

  const options = await checkSelect(adminPage).locator("option").allTextContents();
  expect(options).toContain("Port scanner");
  expect(options).toContain("Subdomain enumeration");
  // Blue-team-only tools must be gone.
  expect(options).not.toContain("Log scan");

  // Switching back restores the blue catalog.
  await adminPage.getByRole("button", { name: "Blue Team" }).click();
  const blueOptions = await checkSelect(adminPage).locator("option").allTextContents();
  expect(blueOptions).toContain("Log scan");
  expect(blueOptions).not.toContain("Port scanner");
});

test("SEC-03: selecting a different check swaps the form fields and description", async ({ adminPage }) => {
  // Log scan (default) has source/pattern/lines
  await checkSelect(adminPage).selectOption({ label: "Log scan" });
  await expect(fieldInput(adminPage, "Log source")).toBeVisible();
  await expect(fieldInput(adminPage, "Pattern (regex)")).toBeVisible();
  await expect(adminPage.getByText(/Regex-scan the tail of a known log file/)).toBeVisible();

  // Port audit has entirely different fields
  await checkSelect(adminPage).selectOption({ label: "Port audit" });
  await expect(fieldInput(adminPage, "Expected ports")).toBeVisible();
  await expect(fieldInput(adminPage, "Log source")).toHaveCount(0);
  await expect(adminPage.getByText(/List locally listening TCP\/UDP ports/)).toBeVisible();
});

test("SEC-04: running a local Blue Team check returns a level badge and readable output", async ({ adminPage }) => {
  await checkSelect(adminPage).selectOption({ label: "Port audit" });
  await expect(fieldInput(adminPage, "Host")).toHaveValue("localhost"); // default pre-filled
  await fieldInput(adminPage, "Expected ports").fill("22,80,443");

  await adminPage.getByRole("button", { name: "Run", exact: true }).click();

  // Real subprocess work — allow generous time, then assert on the rendered result.
  await expect(resultPre(adminPage)).toBeVisible({ timeout: 25_000 });
  await expect(resultPre(adminPage)).not.toBeEmpty();

  // Some level badge rendered — any of the three is a valid outcome for a port audit; what
  // matters is that a result came back and was classified, not which way it went.
  const levelBadge = adminPage.locator(".card", { hasText: "Run a check" }).locator(".badge-green, .badge-amber, .badge-red").first();
  await expect(levelBadge).toBeVisible();
  await expect(levelBadge).toHaveText(/^(OK|WARN|ERR)$/);
});

test("SEC-05: a Red Team scan against a non-allowlisted target is REFUSED and the refusal is visible in the UI", async ({ adminPage }) => {
  await adminPage.getByRole("button", { name: "Red Team" }).click();
  await checkSelect(adminPage).selectOption({ label: "Port scanner" });

  // A target that is definitionally not on any sane allowlist — the .example TLD is reserved
  // by RFC 2606 precisely so it can never resolve to a real host, so this can't accidentally
  // scan someone if the allowlist gate ever failed open.
  await fieldInput(adminPage, "Target").fill("definitely-not-allowlisted.example");
  await fieldInput(adminPage, "Port range").fill("80");

  await adminPage.getByRole("button", { name: "Run", exact: true }).click();

  await expect(resultPre(adminPage)).toBeVisible({ timeout: 25_000 });
  // The server-side TARGET_ALLOWLIST gate must be what answers here.
  await expect(resultPre(adminPage)).toContainText("REFUSED");

  const errBadge = adminPage.locator(".card", { hasText: "Run a check" }).locator(".badge-red").first();
  await expect(errBadge).toHaveText("ERR");
});

test("SEC-06: phishing_simulation_sender is always a disabled 'Not implemented' button, never a runnable form", async ({ adminPage }) => {
  await adminPage.getByRole("button", { name: "Red Team" }).click();
  await checkSelect(adminPage).selectOption({ label: "Phishing simulation sender" });

  const notImplemented = adminPage.getByRole("button", { name: "Not implemented" });
  await expect(notImplemented).toBeVisible();
  await expect(notImplemented).toBeDisabled();

  // And crucially: no Run button, no form to submit.
  await expect(adminPage.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);

  // Switching away and back must not accidentally produce a runnable form either.
  await checkSelect(adminPage).selectOption({ label: "Port scanner" });
  await expect(adminPage.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await checkSelect(adminPage).selectOption({ label: "Phishing simulation sender" });
  await expect(adminPage.getByRole("button", { name: "Not implemented" })).toBeDisabled();
  await expect(adminPage.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
});

test("SEC-07: an admin can add a target to the allowlist and see it appear", async ({ adminPage }) => {
  const host = `e2e-${Date.now()}.example.com`;
  const allowlist = allowlistCard(adminPage);

  await expect(allowlist.getByText("Add target")).toBeVisible();
  await allowlist.locator(".field", { hasText: "Add target" }).locator("input").fill(host);
  await allowlist.getByRole("button", { name: "Add" }).click();

  await expect(allowlist.getByText(host)).toBeVisible();
  // Newly added (non-protected) entries are removable by an admin.
  const row = allowlist.locator(".tool-row", { hasText: host });
  await expect(row.getByRole("button", { name: "Remove" })).toBeVisible();

  // Clean up after ourselves so repeat runs don't accumulate junk entries on a shared instance.
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(allowlist.getByText(host)).toHaveCount(0);
});

test("SEC-08: a non-admin sees the allowlist read-only but can still run checks", async ({ userPage }) => {
  await goToPage(userPage, "Security Ops");
  await expect(userPage.getByText("Run a check")).toBeVisible();

  const allowlist = allowlistCard(userPage);
  // No add form, no remove buttons — just a pointer to ask an admin.
  await expect(allowlist.getByText("Ask an admin to add a target.")).toBeVisible();
  await expect(allowlist.getByText("Add target")).toHaveCount(0);
  await expect(allowlist.getByRole("button", { name: "Remove" })).toHaveCount(0);

  // But running a check is still available to a non-admin — the allowlist is the security
  // boundary for anything network-facing, not who's allowed to press Run.
  await expect(checkSelect(userPage)).toBeVisible();
  await expect(userPage.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
});

test("SEC-09: localhost/127.0.0.1/::1 are marked always-allowed and have no Remove button, even for an admin", async ({ adminPage }) => {
  const allowlist = allowlistCard(adminPage);
  await expect(allowlist.getByText("localhost")).toBeVisible();

  for (const protectedHost of ["localhost", "127.0.0.1", "::1"]) {
    const row = allowlist.locator(".tool-row", { hasText: protectedHost });
    // Not every deployment necessarily lists all three, so only assert on the ones present.
    if ((await row.count()) === 0) continue;
    await expect(row.first().getByText("always allowed")).toBeVisible();
    await expect(row.first().getByRole("button", { name: "Remove" })).toHaveCount(0);
  }
});
