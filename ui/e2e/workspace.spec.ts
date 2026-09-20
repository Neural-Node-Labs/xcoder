import { test, expect, goToPage } from "./fixtures";
import type { Page } from "@playwright/test";
import AdmZip from "adm-zip";

/**
 * Workspace file browser — implements WS-01..WS-10 from test_scenario.md.
 *
 * Each test creates its own uniquely-named project first (via the Projects page) so it gets a
 * genuinely empty workspace to act on, rather than depending on whatever files happen to exist
 * in a shared project — which would make assertions about listing/sorting/exclusion unstable.
 */

function uniqueName(prefix: string) {
  return `${prefix}-${Date.now()}`;
}

/** Creates a fresh project and navigates to the Workspace page with it selected. */
async function freshWorkspace(page: Page): Promise<string> {
  const name = uniqueName("e2e-ws");
  await goToPage(page, "Projects");
  await page.locator(".field", { hasText: "Name" }).locator("input").fill(name);
  await page.getByRole("button", { name: "Add project" }).click();
  await expect(page.getByText(name)).toBeVisible();

  await goToPage(page, "Workspace");
  await page.locator(".field", { hasText: "Project" }).locator("select").selectOption({ label: new RegExp(name) as never });
  return name;
}

function fileList(page: Page) {
  return page.locator(".tool-list");
}
function editor(page: Page) {
  return page.locator("textarea.mono");
}

test("WS-01/WS-02: creating a file lists it and opens it in the editor", async ({ userPage }) => {
  await freshWorkspace(userPage);

  await userPage.getByPlaceholder("new-file.ts").fill("hello.txt");
  await userPage.getByRole("button", { name: "+ File" }).click();

  await expect(fileList(userPage).getByText("hello.txt")).toBeVisible();
  // Opens straight into the editor, ready to type into.
  await expect(userPage.getByText("hello.txt", { exact: false }).first()).toBeVisible();
  await expect(editor(userPage)).toBeVisible();
  await expect(editor(userPage)).toHaveValue("");
});

test("WS-03/WS-07: editing and saving persists; Save is disabled until content actually differs", async ({ userPage }) => {
  await freshWorkspace(userPage);
  await userPage.getByPlaceholder("new-file.ts").fill("notes.md");
  await userPage.getByRole("button", { name: "+ File" }).click();
  await expect(editor(userPage)).toBeVisible();

  const saveBtn = userPage.getByRole("button", { name: "Save" });
  // Freshly opened, unmodified — nothing to save.
  await expect(saveBtn).toBeDisabled();
  await expect(userPage.getByText("unsaved")).toHaveCount(0);

  const content = "# Notes\n\nWritten by the e2e suite.";
  await editor(userPage).fill(content);

  // Now genuinely dirty.
  await expect(userPage.getByText("unsaved")).toBeVisible();
  await expect(saveBtn).toBeEnabled();

  await saveBtn.click();

  // Dirty state clears once saved.
  await expect(userPage.getByText("unsaved")).toHaveCount(0);
  await expect(saveBtn).toBeDisabled();

  // And it really persisted — reload the page and reopen the file.
  await userPage.reload();
  await goToPage(userPage, "Workspace");
  await fileList(userPage).getByText("notes.md").click();
  await expect(editor(userPage)).toHaveValue(content);
});

test("WS-04: creating a folder and navigating into it updates the breadcrumbs", async ({ userPage }) => {
  await freshWorkspace(userPage);

  await userPage.getByPlaceholder("new-folder").fill("src");
  await userPage.getByRole("button", { name: "+ Folder" }).click();
  await expect(fileList(userPage).getByText("src")).toBeVisible();

  // Enter the folder.
  await fileList(userPage).getByText("src").click();
  await expect(userPage.getByRole("button", { name: "↑ Up" })).toBeVisible();
  await expect(userPage.getByRole("button", { name: "src" })).toBeVisible();

  // A file created here lands inside the folder, not at the root.
  await userPage.getByPlaceholder("new-file.ts").fill("index.ts");
  await userPage.getByRole("button", { name: "+ File" }).click();
  await expect(fileList(userPage).getByText("index.ts")).toBeVisible();

  // Navigate back out via "Up" — index.ts should no longer be listed at the root.
  await userPage.getByRole("button", { name: "↑ Up" }).click();
  await expect(fileList(userPage).getByText("src")).toBeVisible();
  await expect(fileList(userPage).getByText("index.ts")).toHaveCount(0);
});

test("WS-05: deleting a file removes it from the listing and closes the editor", async ({ userPage }) => {
  await freshWorkspace(userPage);
  await userPage.getByPlaceholder("new-file.ts").fill("doomed.txt");
  await userPage.getByRole("button", { name: "+ File" }).click();
  await expect(editor(userPage)).toBeVisible();

  const row = fileList(userPage).locator(".tool-row", { hasText: "doomed.txt" });

  // Dismissing the confirm leaves it alone.
  userPage.once("dialog", (d) => d.dismiss());
  await row.getByRole("button", { name: "✕" }).click();
  await expect(fileList(userPage).getByText("doomed.txt")).toBeVisible();

  // Accepting removes it, and the editor pane returns to its empty state.
  userPage.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "✕" }).click();
  await expect(fileList(userPage).getByText("doomed.txt")).toHaveCount(0);
  await expect(userPage.getByText("Select a file to view or edit it.")).toBeVisible();
});

test("WS-01 (sorting) + WS-06: folders sort before files, and excluded dirs never appear", async ({ userPage }) => {
  await freshWorkspace(userPage);

  // Create files and folders in deliberately non-alphabetical creation order.
  await userPage.getByPlaceholder("new-file.ts").fill("b.txt");
  await userPage.getByRole("button", { name: "+ File" }).click();
  await userPage.getByPlaceholder("new-file.ts").fill("a.txt");
  await userPage.getByRole("button", { name: "+ File" }).click();
  await userPage.getByPlaceholder("new-folder").fill("zfolder");
  await userPage.getByRole("button", { name: "+ Folder" }).click();

  // Directories first, then files alphabetically within each group.
  const names = await fileList(userPage).locator(".tool-row").allTextContents();
  const cleaned = names.map((n) => n.replace(/[▸▤✕]/g, "").trim().split(/\s+/)[0]);
  expect(cleaned[0]).toBe("zfolder");
  expect(cleaned.indexOf("a.txt")).toBeLessThan(cleaned.indexOf("b.txt"));

  // WS-06: excluded directories must never appear in the listing. Creating a real
  // `node_modules`/`.git` inside the project would need filesystem access to the server's
  // workspace root, which this suite deliberately doesn't have — and the UI's own "+ Folder"
  // goes through the same API, so creating one that way would only prove the create path, not
  // the listing filter.
  //
  // So this asserts the *observable* half only: whatever is on disk, none of the excluded names
  // are ever listed. On a fresh project that's a weak assertion (nothing to filter yet); it
  // becomes meaningful when pointed at a project that really does have a node_modules — e.g.
  // set E2E_PREPOPULATED_PROJECT to such a project's name to exercise it properly.
  // The strong version of this check is already covered server-side by
  // src/api/__tests__/workspaceFiles.test.ts ("skips excluded directories like node_modules and
  // .git"), which creates them for real and asserts they're filtered out.
  const prepopulated = process.env.E2E_PREPOPULATED_PROJECT;
  if (prepopulated) {
    await userPage.locator(".field", { hasText: "Project" }).locator("select").selectOption({ label: new RegExp(prepopulated) as never });
    await expect(fileList(userPage).locator(".tool-row").first()).toBeVisible();
  }
  for (const excluded of ["node_modules", ".git", "dist"]) {
    await expect(fileList(userPage).getByText(excluded, { exact: true })).toHaveCount(0);
  }
});

/** Builds a zip in memory — no fixture files on disk, no cleanup needed. */
function zipOf(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content, "utf-8"));
  return zip.toBuffer();
}

function uploadZipButton(page: Page) {
  return page.getByRole("button", { name: /Upload zip/ });
}
/** The hidden <input type=file> the Upload zip button clicks — Playwright can target it
 *  directly via setInputFiles() without needing the native OS file picker. */
function zipFileInput(page: Page) {
  return page.locator('input[type="file"][accept*="zip"]');
}

test("WS-08: uploading a zip extracts its contents into the current directory", async ({ userPage }) => {
  await freshWorkspace(userPage);

  const buf = zipOf({
    "readme.md": "# hello from a zip",
    "src/index.ts": "export const x = 1;",
    "src/lib/util.ts": "export const y = 2;",
  });

  await expect(uploadZipButton(userPage)).toBeVisible();
  await zipFileInput(userPage).setInputFiles({ name: "bundle.zip", mimeType: "application/zip", buffer: buf });

  // Result banner reports what happened.
  await expect(userPage.getByText(/Extracted 3 files/)).toBeVisible({ timeout: 15_000 });
  await expect(userPage.getByText(/into 2 folders/)).toBeVisible();

  // And the files are genuinely there, in the right place.
  await expect(fileList(userPage).getByText("readme.md")).toBeVisible();
  await expect(fileList(userPage).getByText("src")).toBeVisible();

  await fileList(userPage).getByText("readme.md").click();
  await expect(editor(userPage)).toHaveValue("# hello from a zip");

  await fileList(userPage).getByText("src").click();
  await expect(fileList(userPage).getByText("index.ts")).toBeVisible();
  await fileList(userPage).getByText("lib").click();
  await expect(fileList(userPage).getByText("util.ts")).toBeVisible();
});

test("WS-09: a zip containing node_modules/.git extracts everything else and reports the rest as skipped", async ({ userPage }) => {
  await freshWorkspace(userPage);

  const buf = zipOf({
    "package.json": '{"name":"demo"}',
    "node_modules/left-pad/index.js": "module.exports = () => {};",
    ".git/HEAD": "ref: refs/heads/main",
  });

  await zipFileInput(userPage).setInputFiles({ name: "with-junk.zip", mimeType: "application/zip", buffer: buf });

  await expect(userPage.getByText(/Extracted 1 file/)).toBeVisible({ timeout: 15_000 });
  await expect(userPage.getByText(/Skipped 2 entries/)).toBeVisible();

  await expect(fileList(userPage).getByText("package.json")).toBeVisible();
  // And critically, the skipped directories never actually landed on disk either.
  await expect(fileList(userPage).getByText("node_modules", { exact: true })).toHaveCount(0);
  await expect(fileList(userPage).getByText(".git", { exact: true })).toHaveCount(0);
});

test("WS-10: selecting a non-zip file is rejected client-side before any upload", async ({ userPage }) => {
  await freshWorkspace(userPage);

  let uploadRequestFired = false;
  userPage.on("request", (req) => {
    if (req.url().includes("/workspace/upload-zip")) uploadRequestFired = true;
  });

  await zipFileInput(userPage).setInputFiles({
    name: "not-a-zip.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("just some text"),
  });

  await expect(userPage.getByText("Only .zip files are accepted.")).toBeVisible();
  expect(uploadRequestFired, "A non-zip file should never reach the upload endpoint").toBe(false);

  // And nothing was added to the listing.
  await expect(fileList(userPage).getByText("not-a-zip.txt")).toHaveCount(0);
});
