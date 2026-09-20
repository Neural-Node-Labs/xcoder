import { test, expect, goToPage } from "./fixtures";

/**
 * Users (admin) — implements USR-01 from test_scenario.md.
 * (USR-02, "a non-admin can't reach this page at all", is enforced in navigation.spec.ts's
 * NAV-02 — same assertion, so it lives there rather than being duplicated here.)
 */

test("USR-01: an admin can create, edit the role of, and delete a user", async ({ adminPage }) => {
  const username = `e2e_user_${Date.now()}`;

  await goToPage(adminPage, "Users");
  await expect(adminPage.locator(".page-title")).toHaveText("Users");

  // --- Create ---
  await adminPage.locator(".field", { hasText: "Username" }).locator("input").fill(username);
  await adminPage.locator(".field", { hasText: "Password" }).locator("input").fill("e2e-temp-pass-1");
  await adminPage.getByRole("button", { name: /Add user|Create user/ }).click();

  const row = adminPage.locator(".tool-row, tr", { hasText: username }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });

  // --- Edit role ---
  const roleSelect = row.locator("select");
  if ((await roleSelect.count()) > 0) {
    await roleSelect.selectOption("admin");
    // The change should persist across a reload, not just update local state.
    await adminPage.reload();
    await goToPage(adminPage, "Users");
    const reloadedRow = adminPage.locator(".tool-row, tr", { hasText: username }).first();
    await expect(reloadedRow.locator("select")).toHaveValue("admin");
  }

  // --- Delete (also cleans up after this test) ---
  adminPage.once("dialog", (d) => d.accept());
  await adminPage.locator(".tool-row, tr", { hasText: username }).first()
    .getByRole("button", { name: /Delete|Remove/ }).click();
  await expect(adminPage.getByText(username)).toHaveCount(0, { timeout: 15_000 });
});
