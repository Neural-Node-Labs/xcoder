import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { SourceMoodKey } from "./moodMapping";

/**
 * The common Three.js scaffold every Chaos/Tactical/Humanoid/Orbital/Mecha/ReactorCore
 * hologram shares: a renderer sized to its container (not the window — these are small embedded
 * avatars, not full-page apps, so this uses a ResizeObserver where each source mockup used a
 * `window.addEventListener("resize", ...)`), a single requestAnimationFrame loop, a generic
 * smooth transition whenever the mood changes (interpolating every *numeric* field in that
 * design's own mood-config object, plus every registered material's color — replacing each
 * mockup's own copy-pasted `setInterval(..., 16)` color-lerp block), and full disposal on
 * unmount. Each component supplies only what makes it visually distinct: its own geometry,
 * materials, per-mood config values, and per-frame update logic.
 */

export interface ThreeMoodSceneBuildContext<TConfig> {
  THREE: typeof THREE;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  initialConfig: TConfig;
}

export interface ThreeMoodSceneBuildResult<TConfig> {
  /** Called once per rendered frame. `speedFactor` is 1 normally, <1 while `thinking` — each
   *  component multiplies it into whichever of its own config fields represent a rate/speed
   *  (e.g. `config.ringSpeed1 * speedFactor`); fields that are target *values* rather than
   *  rates (opacity, tilt angle, eye scale, camera distance) are used as-is. */
  onFrame: (elapsedSeconds: number, config: TConfig, speedFactor: number) => void;
  /** Every material whose `.color` should smoothly transition on a mood change — this is what
   *  replaces each mockup's own named list of materials inside its `setMood()`. */
  colorTargets: { color: THREE.Color }[];
  /** Anything build() created that isn't reachable by scene.traverse() and so wouldn't get
   *  disposed by the hook's own generic cleanup below (rare — most things are add()ed to the
   *  scene and get swept automatically). */
  dispose?: () => void;
}

export interface UseThreeMoodSceneOptions<TConfig extends Record<string, unknown>> {
  containerRef: React.RefObject<HTMLDivElement>;
  configs: Record<SourceMoodKey, TConfig>;
  activeKey: SourceMoodKey;
  /** The resolved 0xRRGGBB color for the current mood — see moodMapping.ts's resolveMoodColor
   *  (handles the "attack" violet override, since that mood shares "danger"'s numeric config
   *  but shouldn't share its color). */
  moodColor: number;
  speedFactor: number;
  build: (ctx: ThreeMoodSceneBuildContext<TConfig>) => ThreeMoodSceneBuildResult<TConfig>;
}

const TRANSITION_SECONDS = 0.5;

function lerpNumericFields<T extends Record<string, unknown>>(from: T, to: T, t: number): T {
  const out: Record<string, unknown> = { ...to };
  for (const key of Object.keys(to)) {
    const a = from[key];
    const b = to[key];
    if (typeof a === "number" && typeof b === "number") out[key] = a + (b - a) * t;
  }
  return out as T;
}

function disposeObject3D(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh | THREE.Points;
    if ("geometry" in mesh && mesh.geometry) mesh.geometry.dispose();
    const material = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}

export function useThreeMoodScene<TConfig extends Record<string, unknown>>({
  containerRef,
  configs,
  activeKey,
  moodColor,
  speedFactor,
  build,
}: UseThreeMoodSceneOptions<TConfig>) {
  // Failures inside effects/rAF callbacks are invisible to React error boundaries unless re-thrown during render.
  const [fatal, setFatal] = useState<Error | null>(null);
  if (fatal) throw fatal;
  const buildRef = useRef(build);
  buildRef.current = build;
  // Read live inside the RAF loop via refs rather than restarting the whole scene (which would
  // dispose and rebuild every geometry/material) on every mood/thinking/listening change —
  // those change often (a mood swap mid-conversation, thinking toggling every request), while
  // the underlying Three.js scene only needs to exist once per mount.
  const activeKeyRef = useRef(activeKey);
  const moodColorRef = useRef(moodColor);
  const speedFactorRef = useRef(speedFactor);
  activeKeyRef.current = activeKey;
  moodColorRef.current = moodColor;
  speedFactorRef.current = speedFactor;

  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const initialConfig = configs[activeKeyRef.current];
    camera.position.set(0, 0, (initialConfig.cameraDist as number | undefined) ?? 5.5);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (e) {   // no WebGL / blocklisted GPU / context limit reached
      setFatal(e instanceof Error ? e : new Error("WebGL is unavailable"));
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.display = "block";
    containerEl.appendChild(renderer.domElement);

    function resize() {
      const w = containerEl!.clientWidth || 1;
      const h = containerEl!.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(containerEl);

    let built: ThreeMoodSceneBuildResult<TConfig>;
    try {
      built = buildRef.current({ THREE, scene, camera, initialConfig });
    } catch (e) {
      ro.disconnect(); renderer.dispose();
      if (renderer.domElement.parentNode === containerEl) containerEl.removeChild(renderer.domElement);
      setFatal(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const { onFrame, colorTargets, dispose: disposeExtra } = built;

    let colorFrom = new THREE.Color(moodColorRef.current);
    let colorTo = new THREE.Color(moodColorRef.current);
    let configFrom = initialConfig;
    let configTo = initialConfig;
    let transitionStart = 0;
    let lastKey = activeKeyRef.current;
    let lastColor = moodColorRef.current;

    const clock = new THREE.Clock();
    let raf = 0;

    let stopped = false;
    function frame() {
      if (stopped) return;
      try {
        step();
      } catch (e) {          // a throw inside rAF would silently kill the loop; surface it to the boundary instead
        stopped = true;
        setFatal(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      raf = requestAnimationFrame(frame);
    }
    function step() {
      const now = clock.getElapsedTime();

      if (activeKeyRef.current !== lastKey || moodColorRef.current !== lastColor) {
        configFrom = lerpNumericFields(configFrom, configTo, Math.min(1, (now - transitionStart) / TRANSITION_SECONDS));
        configTo = configs[activeKeyRef.current];
        colorFrom = colorTo.clone();
        colorTo = new THREE.Color(moodColorRef.current);
        transitionStart = now;
        lastKey = activeKeyRef.current;
        lastColor = moodColorRef.current;
      }

      const t = Math.min(1, (now - transitionStart) / TRANSITION_SECONDS);
      const liveConfig = lerpNumericFields(configFrom, configTo, t);
      for (const target of colorTargets) target.color.lerpColors(colorFrom, colorTo, t);

      onFrame(now, liveConfig, speedFactorRef.current);
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);

    // GPU context loss (tab backgrounded on mobile, driver reset): pause instead of rendering into a dead context.
    const canvas = renderer.domElement;
    const onLost = (ev: Event) => { ev.preventDefault(); stopped = true; cancelAnimationFrame(raf); };
    const onRestored = () => { if (stopped) { stopped = false; raf = requestAnimationFrame(frame); } };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    return () => {
      stopped = true;
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      cancelAnimationFrame(raf);
      ro.disconnect();
      disposeExtra?.();
      disposeObject3D(scene);
      renderer.dispose();
      renderer.forceContextLoss();   // browsers cap live WebGL contexts (~16); free this one now, not at GC
      if (renderer.domElement.parentNode === containerEl) containerEl.removeChild(renderer.domElement);
    };
    // Mount-once: activeKey/moodColor/speedFactor are read live via the refs above every frame
    // instead of tearing down and rebuilding the whole scene when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, configs]);
}
