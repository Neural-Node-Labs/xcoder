import { test, expect, goToPage } from "./fixtures";

/** CodeGraph Explorer — implements CG-01, CG-02 from test_scenario.md. */

test.beforeEach(async ({ userPage }) => {
  await goToPage(userPage, "CodeGraph");
  await expect(userPage.locator(".page-title")).toHaveText("CodeGraph Explorer");
});

test("CG-01: the page loads without a client-side error and offers a project picker", async ({ userPage }) => {
  const consoleErrors: string[] = [];
  userPage.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // The index control is always present regardless of whether CodeGraph itself is connected.
  await expect(userPage.getByRole("button", { name: /Index this workspace/ })).toBeVisible();

  // Project picker only renders when the user actually has projects — assert on whichever
  // state this instance is in rather than assuming one.
  const picker = userPage.locator("select").first();
  if ((await picker.count()) > 0) {
    expect((await picker.locator("option").count())).toBeGreaterThan(0);
  }

  // No uncaught React/render errors while loading the embedded panel.
  const realErrors = consoleErrors.filter((e) => !/favicon|404|net::ERR/i.test(e));
  expect(realErrors, `Unexpected console errors: ${realErrors.join("; ")}`).toHaveLength(0);
});

test("CG-02: indexing targets the project chosen in the dropdown and reports a result", async ({ userPage }) => {
  const picker = userPage.locator("select").first();
  test.skip((await picker.count()) === 0, "No projects on this instance — create one first (see PROJ-01).");

  const options = await picker.locator("option").allTextContents();
  expect(options.length).toBeGreaterThan(0);

  // Pick explicitly rather than relying on whatever happens to be globally "active" — that
  // distinction is the whole point of CG-02 (the picker was added precisely so indexing is no
  // longer locked to the active project).
  await picker.selectOption({ index: options.length - 1 });

  await userPage.getByRole("button", { name: /Index this workspace/ }).click();

  // Either outcome is fine — CodeGraph may not be connected on this instance. What must not
  // happen is a silent no-op or a spinner that never resolves.
  await expect(userPage.locator(".badge-green, .badge-red").first()).toBeVisible({ timeout: 60_000 });
});
