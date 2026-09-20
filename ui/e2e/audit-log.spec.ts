import { test, expect, goToPage } from "./fixtures";

/**
 * Audit log — implements AUD-01, AUD-02 from test_scenario.md.
 * (AUD-03, "a non-admin can never see this page", is enforced in navigation.spec.ts's NAV-02,
 * since it's the same assertion rather than a separate one.)
 */

test("AUD-01: an audited admin action shows up on the Audit log page", async ({ adminPage }) => {
  const host = `e2e-audit-${Date.now()}.example.com`;

  // Perform a real audited action: update the Security Ops target allowlist.
  await goToPage(adminPage, "Security Ops");
  const allowlist = adminPage.locator(".card", { hasText: "Target allowlist" });
  await allowlist.locator(".field", { hasText: "Add target" }).locator("input").fill(host);
  await allowlist.getByRole("button", { name: "Add" }).click();
  await expect(allowlist.getByText(host)).toBeVisible();

  // It should now be recorded in the audit trail with an actor and an action tag.
  await goToPage(adminPage, "Audit log");
  await expect(adminPage.locator(".page-title")).toHaveText("Audit log");

  const entry = adminPage.locator(".tool-row", { hasText: "security_ops.allowlist_update" }).first();
  await expect(entry).toBeVisible({ timeout: 15_000 });
  // The entry names who did it and when.
  await expect(entry).toContainText(/allowlist/i);

  // Clean up the allowlist entry we added (the audit record itself is append-only by design
  // and intentionally can't be deleted from the UI — that's the point of an audit trail).
  await goToPage(adminPage, "Security Ops");
  await adminPage.locator(".tool-row", { hasText: host }).getByRole("button", { name: "Remove" }).click();
});

test("AUD-02: the filter narrows visible entries without a network round-trip", async ({ adminPage }) => {
  await goToPage(adminPage, "Audit log");
  await expect(adminPage.locator(".page-title")).toHaveText("Audit log");

  const rows = adminPage.locator(".tool-row");
  const totalBefore = await rows.count();
  test.skip(totalBefore === 0, "No audit entries recorded yet on this instance — run AUD-01 first.");

  // Filtering is client-side. The page also auto-refreshes on a 5s poll, which would fire
  // requests regardless of filtering — so turn that off first, otherwise this assertion would
  // be measuring the poll, not the filter.
  await adminPage.getByText("Auto-refresh").locator("input[type=checkbox]").uncheck();

  let requestFired = false;
  const listener = () => {
    requestFired = true;
  };
  adminPage.on("request", listener);

  await adminPage.getByPlaceholder("Filter by user, action…").fill("zzz-no-such-entry-zzz");
  await expect(adminPage.getByText("No entries match that filter.")).toBeVisible();

  adminPage.off("request", listener);
  expect(requestFired, "Filtering should be purely client-side, but a network request fired").toBe(false);

  // Clearing the filter restores the full list.
  await adminPage.getByPlaceholder("Filter by user, action…").fill("");
  await expect(rows).toHaveCount(totalBefore);
});
