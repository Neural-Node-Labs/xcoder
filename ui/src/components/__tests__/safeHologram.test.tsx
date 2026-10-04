// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lazy, type ComponentType } from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";
import { SafeHologram } from "../holograms/SafeHologram";
import type { HologramProps } from "../holograms/types";

const Good: ComponentType<HologramProps> = () => <div data-testid="good">good</div>;
const Boom: ComponentType<HologramProps> = () => { throw new Error("WebGL is unavailable"); };

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(<ErrorBoundary fallback={<p>fb</p>}><Good mood="ready" /></ErrorBoundary>);
    expect(screen.getByTestId("good")).toBeTruthy();
  });
  it("shows the fallback instead of unmounting the page, and reports the error", () => {
    const onError = vi.fn();
    render(<div><span data-testid="sibling">rest of page</span><ErrorBoundary fallback={(e) => <p>fb: {e.message}</p>} onError={onError}><Boom mood="ready" /></ErrorBoundary></div>);
    expect(screen.getByText("fb: WebGL is unavailable")).toBeTruthy();
    expect(screen.getByTestId("sibling")).toBeTruthy();
    expect(onError).toHaveBeenCalledOnce();
  });
  it("a throwing onError reporter cannot break the fallback", () => {
    render(<ErrorBoundary fallback={<p>fb</p>} onError={() => { throw new Error("reporter"); }}><Boom mood="ready" /></ErrorBoundary>);
    expect(screen.getByText("fb")).toBeTruthy();
  });
  it("retries when resetKeys change", () => {
    let fail = true;
    const Flaky: ComponentType<HologramProps> = () => { if (fail) throw new Error("x"); return <div data-testid="ok">ok</div>; };
    const { rerender } = render(<ErrorBoundary fallback={<p>fb</p>} resetKeys={[1]}><Flaky mood="ready" /></ErrorBoundary>);
    expect(screen.getByText("fb")).toBeTruthy();
    fail = false;
    rerender(<ErrorBoundary fallback={<p>fb</p>} resetKeys={[2]}><Flaky mood="ready" /></ErrorBoundary>);
    expect(screen.getByTestId("ok")).toBeTruthy();
  });
});

describe("SafeHologram", () => {
  it("renders the chosen hologram when healthy", () => {
    render(<SafeHologram Component={Good} id="chaos" mood="ready" />);
    expect(screen.getByTestId("good")).toBeTruthy();
  });
  it("falls back to the CSS HUD hologram when the avatar throws (e.g. no WebGL)", () => {
    const { container } = render(<SafeHologram Component={Boom} id="chaos" mood="ready" size={120} />);
    expect(container.querySelector('[role="img"]')).toBeTruthy();       // JarvisHologram's accessible root
    expect(screen.queryByTestId("good")).toBeNull();
  });
  it("falls back when a lazy chunk fails to load (stale hashed asset after a redeploy)", async () => {
    const Lazy = lazy<ComponentType<HologramProps>>(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    const { container } = render(<SafeHologram Component={Lazy} id="orbital" mood="ready" />);
    await waitFor(() => expect(container.querySelector('[role="img"]')).toBeTruthy());
  });
  it("if the HUD itself is the one failing, renders an empty same-size box rather than crashing", () => {
    const { container } = render(<SafeHologram Component={Boom} id="jarvis" mood="ready" size={90} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.width).toBe("90px"); expect(box.style.height).toBe("90px");
  });
  it("choosing another avatar after a failure clears the error and renders it", () => {
    const { rerender } = render(<SafeHologram Component={Boom} id="chaos" mood="ready" />);
    rerender(<SafeHologram Component={Good} id="tactical" mood="ready" />);
    expect(screen.getByTestId("good")).toBeTruthy();
  });
});
