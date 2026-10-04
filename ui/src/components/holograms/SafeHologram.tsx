import { Suspense, type ComponentType } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { JarvisHologram } from "../JarvisHologram";
import type { HologramProps } from "./types";

/**
 * Renders a hologram so that it can never take the page down. WebGL being unavailable or lost, a lazy chunk that 404s
 * after a redeploy, or a bug inside one avatar all fall back to the pure-CSS HUD hologram (and, if even that throws,
 * to an empty box of the same size so layout does not jump). Picking a different avatar clears the error and retries.
 */
export function SafeHologram({ Component, id, ...props }: HologramProps & { Component: ComponentType<HologramProps>; id: string }) {
  const size = props.size ?? 220;
  const empty = <div style={{ width: size, height: size }} aria-hidden="true" />;
  const hud = id === "jarvis" ? empty : (
    <ErrorBoundary fallback={empty}><JarvisHologram {...props} /></ErrorBoundary>
  );
  return (
    <ErrorBoundary fallback={hud} resetKeys={[id]}>
      <Suspense fallback={empty}>
        <Component {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
