import { test, expect, goToPage } from "./fixtures";

/**
 * Navigation & role gating — implements NAV-01..NAV-04 from test_scenario.md, and is also where
 * AUD-03 and USR-02 are actually enforced (both are "a non-admin must never be able to reach
 * this page", which is the same assertion as NAV-02 rather than a separate one).
 *
 * The nav table these mirror lives in ui/src/components/Sidebar.tsx.
 */

/** Every nav item visible to any logged-in user, paired with the heading its page renders.
 *  Headings come from App.tsx's TITLES map. */
const SHARED_PAGES: { nav: string; heading: string }[] = [
  { nav: "Run a task", heading: "Run a task" },
  { nav: "DAG / WBS board", heading: "DAG / WBS board" },
  { nav: "Task history", heading: "Task history" },
  { nav: "Live logs", heading: "Live logs" },
  { nav: "Skills", heading: "Skills" },
  { nav: "Tools", heading: "Tools" },
  { nav: "CodeGraph", heading: "CodeGraph Explorer" },
  { nav: "Security Ops", heading: "Security Ops" },
  { nav: "Projects", heading: "Projects" },
  { nav: "Workspace", heading: "Workspace" },
  { nav: "Settings", heading: "Settings" },
];

const ADMIN_ONLY_PAGES: { nav: string; heading: string }[] = [
  { nav: "Users", heading: "Users" },
  { nav: "Audit log", heading: "Audit log" },
];

test("NAV-01: every shared nav item opens its page for a regular user", async ({ userPage }) => {
  for (const { nav, heading } of SHARED_PAGES) {
    await goToPage(userPage, nav);
    // The page heading lives in the content header's .page-title, not the sidebar — scope to
    // avoid matching the nav button we just clicked.
    await expect(userPage.locator(".page-title")).toHaveText(heading);
  }
});

test("NAV-02: a non-admin never sees the Users or Audit log nav items", async ({ userPage }) => {
  const sidebar = userPage.locator(".sidebar");
  await expect(sidebar).toBeVisible();

  for (const { nav } of ADMIN_ONLY_PAGES) {
    await expect(sidebar.getByRole("button", { name: nav, exact: true })).toHaveCount(0);
  }

  // Sanity check that the sidebar did render normally otherwise — otherwise the assertions
  // above would pass trivially on a blank/broken sidebar.
  await expect(sidebar.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(sidebar.getByText("USER")).toBeVisible();
});

test("NAV-03: an admin sees and can open every nav item, including the Admin section", async ({ adminPage }) => {
  for (const { nav, heading } of [...SHARED_PAGES, ...ADMIN_ONLY_PAGES]) {
    await goToPage(adminPage, nav);
    await expect(adminPage.locator(".page-title")).toHaveText(heading);
  }
});

test("NAV-04: the active nav item is marked and stays in sync while navigating", async ({ userPage }) => {
  const sidebar = userPage.locator(".sidebar");

  await goToPage(userPage, "Projects");
  await expect(sidebar.getByRole("button", { name: "Projects", exact: true })).toHaveClass(/active/);
  // And only one thing is active at a time.
  await expect(sidebar.locator(".nav-item.active")).toHaveCount(1);

  await goToPage(userPage, "Workspace");
  await expect(sidebar.getByRole("button", { name: "Workspace", exact: true })).toHaveClass(/active/);
  await expect(sidebar.getByRole("button", { name: "Projects", exact: true })).not.toHaveClass(/active/);
  await expect(sidebar.locator(".nav-item.active")).toHaveCount(1);
});
