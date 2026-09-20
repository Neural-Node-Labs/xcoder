// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { App } from "../App";
import { setAuthToken } from "../api/client";

const DATA: Record<string, unknown> = {
  "/auth/me": { userId: "1", username: "tester", role: "admin", expiresAt: Date.now() + 3600_000 },
  "/engines": { engines: ["assistant"], default: "assistant" },
  "/projects": [],
  "/health": { mockLlm: false },
  "/models": { models: [], default: "" },
  "/skills": [],
  "/platform/tools": { tools: [] },
  "/platform/integrations": { integrations: [] },
  "/platform/integrations/codegraph/status": { bundled: false, running: false, external: false, uiAvailable: false, connecting: false },
  "/task-history": { tasks: [] },
};
const calls: string[] = [];

afterEach(() => cleanup());
beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  setAuthToken("t");
  localStorage.setItem("xcoder_user_id", "1");
  localStorage.setItem("xcoder_username", "tester");
  localStorage.setItem("xcoder_role", "admin");
  (Element.prototype as any).scrollTo = () => {};
  (Element.prototype as any).scrollIntoView = () => {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.replace(/^.*\/api\/v1/, "").split("?")[0];
    calls.push(path);
    const data = path in DATA ? DATA[path] : [];
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

const nav = (label: string) => fireEvent.click(within(document.querySelector(".sidebar") as HTMLElement).getByRole("button", { name: new RegExp(label) }));
const tab = (name: RegExp) => fireEvent.click(within(document.querySelector(".chat-tabs") as HTMLElement).getByRole("button", { name }));
const taskBox = () => document.querySelector(".jarvis-task-card textarea") as HTMLTextAreaElement;

describe("pages keep their state across navigation", () => {
  it("keeps the task draft after visiting another page and coming back", async () => {
    render(<App />);
    await waitFor(() => expect(taskBox()).toBeTruthy());
    fireEvent.change(taskBox(), { target: { value: "add rate limiting" } });
    expect(taskBox().value).toBe("add rate limiting");

    nav("Skills");
    await waitFor(() => expect(document.querySelector(".page-title")?.textContent).toBe("Skills"));
    nav("Run a task");
    await waitFor(() => expect(document.querySelector(".page-title")?.textContent).toBe("Run a task"));
    expect(taskBox().value).toBe("add rate limiting");
  });

  it("keeps the chat transcript-side input when switching Task<->Chat tabs and pages", async () => {
    render(<App />);
    await waitFor(() => expect(taskBox()).toBeTruthy());
    tab(/Chat/);
    const chatInput = () => document.querySelector(".jarvis-input-bar textarea") as HTMLTextAreaElement;
    await waitFor(() => expect(chatInput()).toBeTruthy());
    fireEvent.change(chatInput(), { target: { value: "hello chat" } });

    tab(/Task/);
    await waitFor(() => expect(taskBox()).toBeTruthy());
    tab(/Chat/);
    expect(chatInput().value).toBe("hello chat");

    nav("Tools");
    await waitFor(() => expect(document.querySelector(".page-title")?.textContent).toBe("Tools"));
    nav("Run a task");
    await waitFor(() => expect(document.querySelector(".page-title")?.textContent).toBe("Run a task"));
    expect(chatInput().value).toBe("hello chat");
  });

  it("hides (doesn't unmount) inactive pages, and refetches data when returning", async () => {
    render(<App />);
    await waitFor(() => expect(taskBox()).toBeTruthy());
    nav("Skills");
    await waitFor(() => expect(calls.filter((c) => c === "/skills").length).toBe(1));
    // Dashboard is still in the DOM, just hidden.
    expect(taskBox()).toBeTruthy();
    expect((taskBox().closest("[style*='display: none']"))).toBeTruthy();
    nav("Run a task");
    nav("Skills");
    await waitFor(() => expect(calls.filter((c) => c === "/skills").length).toBe(2)); // refreshed, not stale
  });

  it("restores the last page after a reload (same tab)", async () => {
    const first = render(<App />);
    await waitFor(() => expect(taskBox()).toBeTruthy());
    nav("Skills");
    await waitFor(() => expect(document.querySelector(".page-title")?.textContent).toBe("Skills"));
    first.unmount();
    render(<App />);
    await waitFor(() => expect(document.querySelector(".page-title")?.textContent).toBe("Skills"));
  });
});
