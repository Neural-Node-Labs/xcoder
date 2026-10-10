// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { CacheCard, hitRate, fmtTtl } from "../CacheCard";
import { api, type CacheStats } from "../../api/client";

const base: CacheStats = { enabled: true, backend: "redis", ready: true, approxEntries: 12, hits: 3, misses: 1, bypassed: 2, stored: 1, errors: 0, ttlSeconds: 86400, tokensSaved: 4500 };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("CacheCard", () => {
  it("helpers", () => {
    expect(hitRate({ hits: 3, misses: 1 })).toBe(75); expect(hitRate({ hits: 0, misses: 0 })).toBeNull();
    expect(fmtTtl(86400)).toBe("1 d"); expect(fmtTtl(7200)).toBe("2 h"); expect(fmtTtl(90)).toBe("2 min");
  });
  it("shows stats for an admin", async () => {
    vi.spyOn(api, "cacheStats").mockResolvedValue(base);
    render(<CacheCard />);
    await waitFor(() => expect(screen.getByText(/75% hit rate/)).toBeTruthy());
    expect(screen.getByText(/redis: connected/)).toBeTruthy(); expect(screen.getByText(/4,500 tokens saved/)).toBeTruthy();
  });
  it("is hidden for a non-admin (403)", async () => {
    const spy = vi.spyOn(api, "cacheStats").mockRejectedValue(new Error("Admin privileges required"));
    const { container } = render(<CacheCard />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
  it("explains how to enable it when off, and warns when Redis is unreachable", async () => {
    vi.spyOn(api, "cacheStats").mockResolvedValue({ ...base, enabled: false, backend: "off", ready: false });
    render(<CacheCard />);
    await waitFor(() => expect(screen.getByText(/XCODER_REDIS_URL/)).toBeTruthy());
    cleanup();
    vi.spyOn(api, "cacheStats").mockResolvedValue({ ...base, ready: false });
    render(<CacheCard />);
    await waitFor(() => expect(screen.getByText(/unavailable/)).toBeTruthy());
    expect((screen.getByText("Clear cache") as HTMLButtonElement).disabled).toBe(true);
  });
  it("clear asks for confirmation and reports the count", async () => {
    vi.spyOn(api, "cacheStats").mockResolvedValue(base); const clear = vi.spyOn(api, "clearCache").mockResolvedValue({ removed: 12 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<CacheCard />);
    const btn = await screen.findByText("Clear cache");
    fireEvent.click(btn); expect(clear).not.toHaveBeenCalled();
    fireEvent.click(btn); await waitFor(() => expect(screen.getByText("Cleared 12 cached responses.")).toBeTruthy());
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
