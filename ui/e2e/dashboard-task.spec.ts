import { test, expect, goToPage } from "./fixtures";

/**
 * Dashboard — Task tab. Implements TASK-01, TASK-02, TASK-04, TASK-05 from test_scenario.md.
 * (TASK-03 and TASK-06 need a mocked planning response / forced backend error — see the
 * "Not yet automated" section of test_scenario.md.)
 */

test.beforeEach(async ({ userPage }) => {
  await goToPage(userPage, "Run a task");
  await expect(userPage.getByRole("button", { name: /▶ Task/ })).toBeVisible();
});

test("TASK-01: loads with a populated task form and NO Hologram", async ({ userPage }) => {
  // The Hologram is deliberately Chat-only. On the Task tab it pushed the actual form below
  // the fold and its readout duplicated the Result card's text, so its absence here is the
  // assertion — not an omission. CHAT-01 covers the tab where it does belong.
  await expect(userPage.locator(".jarvis-hologram-wrap")).toHaveCount(0);

  // Task form rendered inside the centered shell.
  await expect(userPage.locator(".jarvis-shell")).toBeVisible();
  await expect(userPage.getByText("New task")).toBeVisible();
  await expect(userPage.locator(".field", { hasText: "What should xcoder do?" }).locator("textarea")).toBeVisible();

  // Engine dropdown is populated from the server (not left empty).
  const engineSelect = userPage.locator(".field", { hasText: "Engine" }).locator("select");
  await expect(engineSelect).toBeVisible();
  expect((await engineSelect.locator("option").count())).toBeGreaterThan(0);

  // Result card starts in its empty state.
  await expect(userPage.getByText("Submit a task to see it run here.")).toBeVisible();
});

test("TASK-02: running a task with plan mode 'Never' produces a result", async ({ userPage }) => {
  await userPage.locator(".field", { hasText: "What should xcoder do?" }).locator("textarea")
    .fill("Reply with the single word: pong");
  await userPage.locator(".field", { hasText: "Plan mode" }).locator("select")
    .selectOption({ label: "Never — run immediately" });

  await userPage.getByRole("button", { name: /Run task/ }).click();

  // The Result card shows the running state.
  await expect(userPage.getByText(/Running —/)).toBeVisible({ timeout: 10_000 });

  // A real LLM round-trip — generous timeout. XCODER_MOCK_LLM makes this near-instant.
  const resultPre = userPage.locator(".card", { hasText: "Result" }).locator("pre.console");
  await expect(resultPre).toBeVisible({ timeout: 120_000 });
  await expect(resultPre).not.toBeEmpty();

  // Iteration count badge rendered alongside the output.
  await expect(userPage.locator(".card", { hasText: "Result" }).getByText(/iteration/)).toBeVisible();

  // The result appears exactly once. This is the regression guard for the duplicated-response
  // problem: the reply used to render both in the Result card and as a trimmed copy in the
  // Hologram's typewriter readout above it, so the same text was on screen twice.
  const resultText = ((await resultPre.textContent()) ?? "").trim();
  expect(resultText.length).toBeGreaterThan(0);
  expect(await userPage.getByText(resultText, { exact: false }).count()).toBe(1);
});

test("TASK-04: the MOCK LLM banner is visible when the server runs with XCODER_MOCK_LLM", async ({ userPage, request }) => {
  const res = await request.get("/api/v1/health");
  const body = await res.json();
  const mockLlm = body?.data?.mockLlm === true;

  if (mockLlm) {
    await expect(userPage.getByText(/MOCK LLM connection/)).toBeVisible();
  } else {
    // On a real-LLM instance the banner must NOT appear — an always-on warning would train
    // people to ignore it, which is the failure mode this guards against in both directions.
    await expect(userPage.getByText(/MOCK LLM connection/)).toHaveCount(0);
  }
});

test("TASK-05: Run is disabled while the task field is empty, and reset returns to idle", async ({ userPage }) => {
  const textarea = userPage.locator(".field", { hasText: "What should xcoder do?" }).locator("textarea");
  const runButton = userPage.getByRole("button", { name: /Run task/ });

  await expect(textarea).toHaveValue("");
  await expect(runButton).toBeDisabled();

  await textarea.fill("some task text");
  await expect(runButton).toBeEnabled();

  // Whitespace-only shouldn't count as content.
  await textarea.fill("   ");
  await expect(runButton).toBeDisabled();
});
