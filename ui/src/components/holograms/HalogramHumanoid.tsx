import { useRef } from "react";
import { HalogramShell } from "./HalogramShell";
import { useThreeMoodScene } from "./useThreeMoodScene";
import { MOOD_TO_SOURCE_KEY, resolveMoodColor, type SourceMoodKey } from "./moodMapping";
import type { HologramProps } from "./types";

/**
 * A wireframe humanoid bust — head, jaw, eyes, a "brain" core, neck, chest, shoulders, and a
 * chest core — with idle sway, breathing, and a blink cycle. Ported from a source mockup
 * titled "AI Humanoid State Monitor"; no trademark concerns.
 */

type HumanoidConfig = {
  name: string;
  color: number;
  headTiltZ: number;
  headTiltX: number;
  eyeScaleY: number;
  breathSpeed: number;
  pulseSpeed: number;
  wireOpacity: number;
  cameraDist: number;
}

const CONFIGS: Record<SourceMoodKey, HumanoidConfig> = {
  ready: { name: "Synapse idle", color: 0x00f0ff, headTiltZ: 0, headTiltX: 0, eyeScaleY: 1.0, breathSpeed: 1.5, pulseSpeed: 2.0, wireOpacity: 0.45, cameraDist: 5.5 },
  thinking: { name: "Processing prompt", color: 0x8a7bff, headTiltZ: -0.08, headTiltX: 0.12, eyeScaleY: 0.85, breathSpeed: 3.5, pulseSpeed: 6.0, wireOpacity: 0.65, cameraDist: 4.8 },
  synthesis: { name: "Creative synthesis", color: 0xffb454, headTiltZ: 0.05, headTiltX: -0.08, eyeScaleY: 1.2, breathSpeed: 2.2, pulseSpeed: 3.5, wireOpacity: 0.75, cameraDist: 5.2 },
  danger: { name: "Critical overload", color: 0xff3b5c, headTiltZ: 0.0, headTiltX: 0.22, eyeScaleY: 0.4, breathSpeed: 8.0, pulseSpeed: 12.0, wireOpacity: 0.9, cameraDist: 4.5 },
  melancholy: { name: "Entropy decay", color: 0x4a75a0, headTiltZ: 0.1, headTiltX: 0.25, eyeScaleY: 0.5, breathSpeed: 0.8, pulseSpeed: 1.0, wireOpacity: 0.35, cameraDist: 6.0 },
  prostrated: { name: "Dormant core", color: 0x1c4a54, headTiltZ: 0.0, headTiltX: 0.55, eyeScaleY: 0.1, breathSpeed: 0.4, pulseSpeed: 0.5, wireOpacity: 0.2, cameraDist: 6.5 },
};

export function HalogramHumanoid(props: HologramProps) {
  const { mood, thinking = false } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceKey = MOOD_TO_SOURCE_KEY[mood];
  const activeConfig = CONFIGS[sourceKey];

  useThreeMoodScene<HumanoidConfig>({
    containerRef,
    configs: CONFIGS,
    activeKey: sourceKey,
    moodColor: resolveMoodColor(mood, activeConfig.color),
    speedFactor: thinking ? 2 : 1,
    build: ({ THREE, scene, camera, initialConfig }) => {
      camera.position.set(0, 0.3, initialConfig.cameraDist);
      const initialColor = resolveMoodColor(mood, initialConfig.color);

      const wireframeMaterial = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: initialConfig.wireOpacity });
      const solidGlowMaterial = new THREE.MeshBasicMaterial({ color: initialColor, transparent: true, opacity: 0.08 });
      const eyeMaterial = new THREE.MeshBasicMaterial({ color: initialColor, transparent: true, opacity: 0.95 });
      const coreMaterial = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: 0.8 });

      const humanoidGroup = new THREE.Group();
      scene.add(humanoidGroup);
      const chestGroup = new THREE.Group();
      humanoidGroup.add(chestGroup);
      const headGroup = new THREE.Group();
      headGroup.position.set(0, 0.95, 0);
      humanoidGroup.add(headGroup);

      const headGeo = new THREE.SphereGeometry(0.55, 18, 14);
      headGeo.scale(1.0, 1.25, 1.1);
      headGroup.add(new THREE.Mesh(headGeo, wireframeMaterial));
      headGroup.add(new THREE.Mesh(headGeo, solidGlowMaterial));

      const jawGeo = new THREE.ConeGeometry(0.48, 0.6, 12);
      jawGeo.rotateX(Math.PI);
      jawGeo.scale(1.0, 1.0, 0.8);
      const jawMesh = new THREE.Mesh(jawGeo, wireframeMaterial);
      jawMesh.position.set(0, -0.3, 0.05);
      headGroup.add(jawMesh);

      const eyeGeo = new THREE.SphereGeometry(0.075, 16, 12);
      eyeGeo.scale(1.5, 0.7, 0.6);
      const eyeLeft = new THREE.Mesh(eyeGeo, eyeMaterial);
      eyeLeft.position.set(-0.18, 0.08, 0.48);
      headGroup.add(eyeLeft);
      const eyeRight = new THREE.Mesh(eyeGeo, eyeMaterial);
      eyeRight.position.set(0.18, 0.08, 0.48);
      headGroup.add(eyeRight);

      const brainCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 2), coreMaterial);
      brainCore.position.set(0, 0.1, 0);
      headGroup.add(brainCore);

      const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.35, 12), wireframeMaterial);
      neckMesh.position.set(0, 0.58, -0.02);
      chestGroup.add(neckMesh);

      const chestGeo = new THREE.CylinderGeometry(0.72, 0.35, 0.95, 14);
      chestGeo.scale(1.1, 1.0, 0.65);
      const chestMesh = new THREE.Mesh(chestGeo, wireframeMaterial);
      const chestFill = new THREE.Mesh(chestGeo, solidGlowMaterial);
      chestMesh.position.set(0, -0.1, 0);
      chestFill.position.set(0, -0.1, 0);
      chestGroup.add(chestMesh);
      chestGroup.add(chestFill);

      const shoulderGeo = new THREE.SphereGeometry(0.22, 12, 10);
      shoulderGeo.scale(1.2, 0.9, 1.0);
      const shoulderL = new THREE.Mesh(shoulderGeo, wireframeMaterial);
      shoulderL.position.set(-0.78, 0.28, 0);
      chestGroup.add(shoulderL);
      const shoulderR = new THREE.Mesh(shoulderGeo, wireframeMaterial);
      shoulderR.position.set(0.78, 0.28, 0);
      chestGroup.add(shoulderR);

      const chestCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), coreMaterial);
      chestCore.position.set(0, 0.05, 0.2);
      chestGroup.add(chestCore);

      humanoidGroup.position.y = -0.3;

      const particleCount = 700;
      const particleGeo = new THREE.BufferGeometry();
      const particlePos = new Float32Array(particleCount * 3);
      for (let i = 0; i < particleCount * 3; i += 3) {
        particlePos[i] = (Math.random() - 0.5) * 7;
        particlePos[i + 1] = (Math.random() - 0.5) * 7;
        particlePos[i + 2] = (Math.random() - 0.5) * 7;
      }
      particleGeo.setAttribute("position", new THREE.BufferAttribute(particlePos, 3));
      const particleMat = new THREE.PointsMaterial({ color: initialColor, size: 0.035, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending });
      const particleSystem = new THREE.Points(particleGeo, particleMat);
      scene.add(particleSystem);

      const ringMat = new THREE.MeshBasicMaterial({ color: initialColor, side: THREE.DoubleSide, transparent: true, opacity: 0.4 });
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 1.66, 64), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -1.2;
      scene.add(ring);

      // Blink cycle — paused while dormant ("prostrated"), same as the source mockup, but that
      // mood is never actually reachable from our six (see moodMapping.ts), so this condition
      // never actually fires here; kept anyway since it's harmless and matches the source.
      let isBlinking = false;
      let blinkTimeout: number | undefined;
      let blinkResetTimeout: number | undefined;
      let stopped = false;
      function scheduleBlink() {
        const delay = 2500 + Math.random() * 3000;
        blinkTimeout = window.setTimeout(() => {
          if (stopped) return;
          isBlinking = true;
          blinkResetTimeout = window.setTimeout(() => {
            isBlinking = false;
          }, 140);
          scheduleBlink();
        }, delay);
      }
      scheduleBlink();

      return {
        colorTargets: [wireframeMaterial, solidGlowMaterial, eyeMaterial, coreMaterial, particleMat, ringMat],
        dispose() {
          stopped = true;
          window.clearTimeout(blinkTimeout);
          window.clearTimeout(blinkResetTimeout);
        },
        onFrame(elapsed, config, speedFactor) {
          headGroup.rotation.z += (config.headTiltZ - headGroup.rotation.z) * 0.05;
          headGroup.rotation.x += (config.headTiltX - headGroup.rotation.x) * 0.05;

          humanoidGroup.rotation.y = Math.sin(elapsed * 0.8) * 0.05;
          humanoidGroup.rotation.x = Math.cos(elapsed * 0.6) * 0.02;

          const breath = Math.sin(elapsed * config.breathSpeed * speedFactor) * 0.03;
          chestGroup.position.y = breath;
          headGroup.position.y = 0.95 + breath * 0.5;

          brainCore.rotation.y = elapsed * config.pulseSpeed * 0.3;
          brainCore.rotation.z = elapsed * config.pulseSpeed * 0.2;
          chestCore.rotation.y = -elapsed * config.pulseSpeed * 0.5;

          const pulseScale = 1.0 + Math.sin(elapsed * config.pulseSpeed * speedFactor) * 0.12;
          chestCore.scale.set(pulseScale, pulseScale, pulseScale);
          brainCore.scale.set(pulseScale, pulseScale, pulseScale);

          const targetEyeY = isBlinking ? 0.05 : config.eyeScaleY;
          eyeLeft.scale.y += (targetEyeY - eyeLeft.scale.y) * 0.3;
          eyeRight.scale.y += (targetEyeY - eyeRight.scale.y) * 0.3;
          wireframeMaterial.opacity += (config.wireOpacity - wireframeMaterial.opacity) * 0.1;

          const positions = particleSystem.geometry.attributes.position.array as Float32Array;
          for (let i = 0; i < particleCount; i++) {
            const idx = i * 3;
            positions[idx + 1] += (0.01 + config.breathSpeed * 0.003) * speedFactor;
            if (positions[idx + 1] > 3.5) {
              positions[idx + 1] = -3.5;
              positions[idx] = (Math.random() - 0.5) * 6;
              positions[idx + 2] = (Math.random() - 0.5) * 6;
            }
          }
          particleSystem.geometry.attributes.position.needsUpdate = true;
          particleSystem.rotation.y = elapsed * 0.03;
          ring.rotation.z = elapsed * 0.25;
          camera.position.z += (config.cameraDist - camera.position.z) * 0.05;
        },
      };
    },
  });

  return <HalogramShell {...props} containerRef={containerRef} defaultLabel={activeConfig.name} />;
}
