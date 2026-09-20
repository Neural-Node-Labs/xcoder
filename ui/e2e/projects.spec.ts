import { test, expect, goToPage } from "./fixtures";

/** Projects — implements PROJ-01..PROJ-05 from test_scenario.md. */

/** Unique per run so repeated runs against the same instance don't collide with leftovers. */
function uniqueProjectName() {
  return `e2e-proj-${Date.now()}`;
}

test.beforeEach(async ({ userPage }) => {
  await goToPage(userPage, "Projects");
  await expect(userPage.getByText("Add a project")).toBeVisible();
});

test("PROJ-01: creating a project adds it to the list and makes it selectable elsewhere", async ({ userPage }) => {
  const name = uniqueProjectName();

  await userPage.locator(".field", { hasText: "Name" }).locator("input").fill(name);
  await userPage.getByRole("button", { name: "Add project" }).click();

  await expect(userPage.getByText(name)).toBeVisible();

  // It should now be offered as a project option on the Workspace page too — this is the part
  // that actually matters, not just that a row rendered on this page.
  await goToPage(userPage, "Workspace");
  const projectSelect = userPage.locator(".field", { hasText: "Project" }).locator("select");
  await expect(projectSelect.locator("option", { hasText: name })).toHaveCount(1);
});

test("PROJ-02: clicking a project expands a detail panel with its id, path, and created date", async ({ userPage }) => {
  const name = uniqueProjectName();
  await userPage.locator(".field", { hasText: "Name" }).locator("input").fill(name);
  await userPage.getByRole("button", { name: "Add project" }).click();
  await expect(userPage.getByText(name)).toBeVisible();

  // Collapsed by default — the detail fields aren't shown yet.
  await expect(userPage.getByText("Project ID")).toHaveCount(0);

  await userPage.getByRole("button", { name: new RegExp(name) }).click();

  await expect(userPage.getByText("Project ID")).toBeVisible();
  await expect(userPage.getByText("Created")).toBeVisible();
  await expect(userPage.getByText("Included when running tasks")).toBeVisible();
  await expect(userPage.getByRole("button", { name: "Open in Workspace" })).toBeVisible();
  await expect(userPage.getByRole("button", { name: "Index for CodeGraph" })).toBeVisible();
});

test("PROJ-03: 'Index for CodeGraph' reports a clear result badge either way", async ({ userPage }) => {
  const name = uniqueProjectName();
  await userPage.locator(".field", { hasText: "Name" }).locator("input").fill(name);
  await userPage.getByRole("button", { name: "Add project" }).click();
  await userPage.getByRole("button", { name: new RegExp(name) }).click();

  await userPage.getByRole("button", { name: "Index for CodeGraph" }).click();

  // Either outcome is acceptable here — CodeGraph may or may not be connected on the target
  // instance. What must NOT happen is a silent no-op or a spinner that never resolves: the user
  // has to be told something either way.
  const badge = userPage.locator(".badge-green, .badge-red").filter({
    hasText: /Indexed|CodeGraph|not connected|failed|error/i,
  });
  await expect(badge.first()).toBeVisible({ timeout: 60_000 });
});

test("PROJ-04: a non-admin never sees the 'View all users' toggle", async ({ userPage }) => {
  await expect(userPage.getByText("Your projects")).toBeVisible();
  await expect(userPage.getByText("View all users (admin)")).toHaveCount(0);
});

test("PROJ-04b: an admin does see the 'View all users' toggle", async ({ adminPage }) => {
  await goToPage(adminPage, "Projects");
  await expect(adminPage.getByText("View all users (admin)")).toBeVisible();
});

test("PROJ-05: removing a project asks for confirmation first", async ({ userPage }) => {
  const name = uniqueProjectName();
  await userPage.locator(".field", { hasText: "Name" }).locator("input").fill(name);
  await userPage.getByRole("button", { name: "Add project" }).click();
  await expect(userPage.getByText(name)).toBeVisible();

  const row = userPage.locator("div").filter({ hasText: name }).last();

  // First: dismiss the confirm — the project must survive.
  userPage.once("dialog", (d) => d.dismiss());
  await row.getByRole("button", { name: "Remove" }).first().click();
  await expect(userPage.getByText(name)).toBeVisible();

  // Then: accept it — and it's gone. (Also cleans up after this test.)
  userPage.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Remove" }).first().click();
  await expect(userPage.getByText(name)).toHaveCount(0);
});
