// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LlmConnectionsPanel } from "./LlmConnectionsPanel";

afterEach(cleanup);
const base = { connections: [], providers: { openai: { model: "gpt-x" } }, slots: ["default", "chat", "task"] as const };

describe("LlmConnectionsPanel", () => {
  it("renders a tab per slot and switches", () => {
    const api = { save: vi.fn(), remove: vi.fn(), test: vi.fn(), reload: vi.fn() };
    render(<LlmConnectionsPanel {...base} slots={[...base.slots]} api={api} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Default", "Chat", "Tasks"]);
    fireEvent.click(screen.getByRole("tab", { name: /Tasks/ }));
    expect(screen.getByRole("tab", { name: /Tasks/ }).getAttribute("aria-selected")).toBe("true");
  });
  it("never prefills the key field", async () => {
    const api = { save: vi.fn().mockResolvedValue({}), remove: vi.fn(), test: vi.fn(), reload: vi.fn() };
    const conn = [{ slot: "chat", mode: "custom", provider: "openai", model: "m", hasKey: true }] as never;
    render(<LlmConnectionsPanel {...base} slots={[...base.slots]} connections={conn} api={api} />);
    fireEvent.click(screen.getByRole("tab", { name: /Chat/ }));
    await waitFor(() => expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe(""));
  });
});
