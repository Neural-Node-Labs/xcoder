import { test, expect, goToPage } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Dashboard — Chat tab. Implements CHAT-01..CHAT-03 from test_scenario.md.
 * (CHAT-04's rollback-on-failure path needs a forced backend error — see test_scenario.md's
 * "Not yet automated" section.)
 */

function composer(page: Page) {
  return page.locator(".jarvis-input-bar textarea");
}

test.beforeEach(async ({ userPage }) => {
  await goToPage(userPage, "Run a task");
  await userPage.getByRole("button", { name: /Chat/ }).click();
  await expect(composer(userPage)).toBeVisible();
});

test("CHAT-01: shows the Hologram, an empty state, and the pill input bar", async ({ userPage }) => {
  await expect(userPage.locator(".jarvis-hologram-wrap")).toBeVisible();
  await expect(userPage.getByText(/Ask the Assistant engine anything/)).toBeVisible();
  await expect(userPage.locator(".jarvis-input-bar")).toBeVisible();

  // The Hologram is a presence indicator only — status line, no readout box. It used to type
  // out a trimmed copy of the latest reply, which put every answer on screen twice.
  await expect(userPage.locator(".jarvis-hologram-wrap").getByText(/ONLINE/)).toBeVisible();
  await expect(userPage.getByText(/RUNNING MATRIX DIAGNOSTICS/)).toHaveCount(0);

  // Send is disabled until there's something to send.
  await expect(userPage.locator(".jarvis-send-btn")).toBeDisabled();
});

test("CHAT-05: the model picker is populated and defaults to the server's configured model", async ({ userPage, request }) => {
  // The picker only renders when the server offers more than one model, so ask the server
  // first rather than assuming a particular deployment's model set.
  const res = await request.get("/api/v1/models");
  // /models sits behind auth; the fixture's request context carries the session.
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const models: string[] = body?.data?.models ?? [];
  const serverDefault: string = body?.data?.default ?? "";

  const picker = userPage.locator(".jarvis-meta-row select[aria-label='Model']");

  if (models.length > 1) {
    await expect(picker).toBeVisible();
    // Selecting the default must not require the user to pick anything.
    await expect(picker).toHaveValue(serverDefault);
    expect(await picker.locator("option").count()).toBe(models.length);
  } else {
    await expect(picker).toHaveCount(0);
  }
});

test("CHAT-02: sending a message adds a user bubble, a thinking state, then the reply", async ({ userPage }) => {
  await composer(userPage).fill("Reply with the single word: pong");
  await expect(userPage.locator(".jarvis-send-btn")).toBeEnabled();
  await composer(userPage).press("Enter");

  // User bubble appears immediately (optimistic), and the composer clears.
  await expect(userPage.locator(".chat-bubble-user")).toHaveCount(1);
  await expect(composer(userPage)).toHaveValue("");

  // Thinking placeholder while in flight.
  await expect(userPage.getByText("thinking…")).toBeVisible({ timeout: 10_000 });

  // Then a real assistant bubble replaces it. Generous timeout for a real LLM round-trip.
  await expect(userPage.locator(".chat-bubble-assistant")).toHaveCount(1, { timeout: 120_000 });
  await expect(userPage.getByText("thinking…")).toHaveCount(0);
  await expect(userPage.locator(".chat-bubble-assistant").first()).not.toBeEmpty();

  // The reply appears exactly once. This is the regression guard for the duplicated-response
  // problem: the Hologram used to render a trimmed copy of the same text directly above the
  // bubble, so every answer was on screen twice.
  const reply = ((await userPage.locator(".chat-bubble-assistant").first().textContent()) ?? "").trim();
  expect(reply.length).toBeGreaterThan(0);
  expect(await userPage.getByText(reply, { exact: false }).count()).toBe(1);
});

test("CHAT-03: Enter sends, Shift+Enter inserts a newline instead", async ({ userPage }) => {
  // Shift+Enter must NOT send — it should leave a multi-line value in the composer.
  await composer(userPage).fill("first line");
  await composer(userPage).press("Shift+Enter");
  await composer(userPage).pressSequentially("second line");

  await expect(composer(userPage)).toHaveValue("first line\nsecond line");
  // Nothing was sent.
  await expect(userPage.locator(".chat-bubble-user")).toHaveCount(0);

  // Plain Enter does send.
  await composer(userPage).press("Enter");
  await expect(userPage.locator(".chat-bubble-user")).toHaveCount(1);
  await expect(composer(userPage)).toHaveValue("");
});
