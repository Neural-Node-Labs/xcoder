import { createContext, useContext, useEffect, useRef } from "react";

/**
 * Pages in the shell are kept mounted once visited (see App.tsx) so their state — the task you
 * were typing, a chat in progress, an open file, a run still executing — survives navigating away
 * and back. The flip side is that a hidden page is still alive, so two things that used to be
 * implicit in mount/unmount now need to be explicit:
 *
 *  - Polling should pause while the page is hidden (usePageActive).
 *  - Data loaded on mount goes stale while hidden, so pages refetch when they become visible
 *    again (useOnActivate) instead of only ever loading once.
 */
const PageActiveContext = createContext(true);

export const PageActiveProvider = PageActiveContext.Provider;

/** Whether the page this component lives in is the one currently shown. */
export function usePageActive(): boolean {
  return useContext(PageActiveContext);
}

/** Runs `cb` each time the page becomes visible again. Does NOT run on first mount — pages
 *  already load their data then. */
export function useOnActivate(cb: () => void): void {
  const active = usePageActive();
  const first = useRef(true);
  const latest = useRef(cb);
  latest.current = cb;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (active) latest.current();
  }, [active]);
}
