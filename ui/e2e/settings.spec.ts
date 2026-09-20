import { test, expect, goToPage } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Settings — implements SET-01..SET-05 from test_scenario.md.
 *
 * SET-03 is the notable one: it specifically guards against the "you must restart the server"
 * claim that was investigated in STATUS.md §13 and found to be false (loadLlmConfig() re-reads
 * llm.yaml from disk on every request, with no caching anywhere). If that message ever comes
 * back, this test fails.
 */

function llmCard(page: Page) {
  return page.locator(".card", { hasText: "LLM provider" });
}

function providerSelect(page: Page) {
  return llmCard(page).locator(".field", { hasText: "Provider" }).locator("select");
}

function modelInput(page: Page) {
  return llmCard(page).locator(".field", { hasText: "Model" }).locator("input");
}

test.beforeEach(async ({ adminPage }) => {
  await goToPage(adminPage, "Settings");
  await expect(adminPage.locator(".page-title")).toHaveText("Settings");
});

test("SET-01: the LLM provider card loads with the server's real current provider and model", async ({ adminPage, request }) => {
  await expect(providerSelect(adminPage)).toBeVisible();

  // Whatever the UI shows must match what the API reports — not a hardcoded default.
  const res = await request.get("/api/v1/settings/llm-config");
  const body = await res.json();
  const serverProvider = body?.data?.provider;
  const serverModel = body?.data?.model;

  expect(serverProvider, "Server should report a configured provider").toBeTruthy();
  await expect(providerSelect(adminPage)).toHaveValue(serverProvider);
  await expect(modelInput(adminPage)).toHaveValue(serverModel);

  // Ollama is xcoder's shipped default and should be offered in the list regardless.
  const options = await providerSelect(adminPage).locator("option").allTextContents();
  expect(options.some((o) => o.includes("ollama"))).toBe(true);
});

test("SET-02: choosing a known provider pre-fills that provider's defaults", async ({ adminPage }) => {
  const originalProvider = await providerSelect(adminPage).inputValue();
  const originalModel = await modelInput(adminPage).inputValue();

  await providerSelect(adminPage).selectOption("openai");

  // Model and api_key_env should switch to OpenAI's known defaults, not stay on the old ones.
  await expect(modelInput(adminPage)).not.toHaveValue(originalModel);
  await expect(llmCard(adminPage).locator(".field", { hasText: "API key env var" }).locator("input"))
    .toHaveValue("OPENAI_API_KEY");

  // Ollama is the one provider that shouldn't ask for a key at all.
  await providerSelect(adminPage).selectOption("ollama");
  await expect(llmCard(adminPage).locator(".field", { hasText: "API key env var" })).toHaveCount(0);

  // Restore the picker to where it started — this test only exercises the form, it must not
  // leave the instance on a different provider for the next test.
  await providerSelect(adminPage).selectOption(originalProvider);
});

test("SET-03: saving a provider confirms it applies on the next request, with no restart claim", async ({ adminPage, request }) => {
  const res = await request.get("/api/v1/settings/llm-config");
  const current = (await res.json())?.data;

  // Re-save the *current* settings — a no-op change, so this test never actually reconfigures
  // the instance it's running against, while still exercising the full save path.
  await providerSelect(adminPage).selectOption(current.provider);
  await modelInput(adminPage).fill(current.model);
  await llmCard(adminPage).getByRole("button", { name: "Save provider" }).click();

  const success = llmCard(adminPage).locator(".badge-green");
  await expect(success).toBeVisible({ timeout: 15_000 });
  await expect(success).toContainText(/no restart needed/i);

  // The regression this guards: the old message told users to restart the server, which was
  // never true. If that copy ever returns, fail loudly.
  await expect(success).not.toContainText(/restart xcoder/i);
  await expect(success).not.toContainText(/Restart .* for this to take effect/i);
});

test("SET-04: a non-admin's provider save surfaces the server's 403 as a visible error", async ({ userPage }) => {
  await goToPage(userPage, "Settings");
  await expect(userPage.locator(".page-title")).toHaveText("Settings");

  // The form renders for everyone (it's read-only data), but saving is admin-gated server-side.
  await expect(providerSelect(userPage)).toBeVisible();
  await llmCard(userPage).getByRole("button", { name: "Save provider" }).click();

  // Must fail loudly, not silently no-op or crash the page.
  await expect(llmCard(userPage).locator(".badge-red")).toBeVisible({ timeout: 15_000 });
  await expect(userPage.locator(".page-title")).toHaveText("Settings"); // page still alive
});

test("SET-05: setting and clearing the LLM API key updates the status badge", async ({ adminPage }) => {
  const keyCard = adminPage.locator(".card", { hasText: "LLM API key" });
  await expect(keyCard).toBeVisible();

  const hadKey = (await keyCard.getByText("Key configured").count()) > 0;
  test.skip(
    hadKey,
    "This instance already has an API key stored — skipping rather than clearing a real key that other tests (and the instance itself) may depend on."
  );

  await expect(keyCard.getByText(/No key stored/)).toBeVisible();

  await keyCard.locator("input[type=password]").fill("e2e-test-key-not-a-real-credential");
  await keyCard.getByRole("button", { name: "Save key" }).click();
  await expect(keyCard.getByText("Key configured")).toBeVisible({ timeout: 15_000 });

  // Clean up: remove the placeholder key we just set, restoring the instance's original state.
  adminPage.once("dialog", (d) => d.accept());
  await keyCard.getByRole("button", { name: "Remove" }).click();
  await expect(keyCard.getByText(/No key stored/)).toBeVisible();
});
