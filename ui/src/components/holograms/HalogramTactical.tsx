import { useRef } from "react";
import { HalogramShell } from "./HalogramShell";
import { useThreeMoodScene } from "./useThreeMoodScene";
import { MOOD_TO_SOURCE_KEY, resolveMoodColor, type SourceMoodKey } from "./moodMapping";
import type { HologramProps } from "./types";

/**
 * Concentric tilted gyroscopic rings around a wireframe core, with a 4-point reticle and a
 * rising particle field — ported from a source mockup titled "J.A.R.V.I.S. — Tactical
 * Holographic Core". That name, its "ARC OVERDRIVE"/"REPULSOR_CHARGE" mood label, and its
 * "GYRO_STABILITY"/HUD-log text are Iron Man-specific references this project has no rights to
 * (see assistantName.ts's header comment for the same reasoning already applied to
 * Hologram.tsx's theme names) — every mood label below is renamed to something generic
 * instead; the ring/reticle *shape* itself isn't anyone's trademark, so that's kept as-is.
 */

type TacticalConfig = {
  name: string;
  color: number;
  ringSpeed1: number;
  ringSpeed2: number;
  ringSpeed3: number;
  pulseSpeed: number;
  cameraDist: number;
}

const CONFIGS: Record<SourceMoodKey, TacticalConfig> = {
  ready: { name: "Online, idle", color: 0x00f0ff, ringSpeed1: 0.015, ringSpeed2: -0.02, ringSpeed3: 0.008, pulseSpeed: 2.0, cameraDist: 5.5 },
  thinking: { name: "Computing", color: 0x8a7bff, ringSpeed1: 0.045, ringSpeed2: -0.06, ringSpeed3: 0.03, pulseSpeed: 5.0, cameraDist: 4.8 },
  synthesis: { name: "Peak output", color: 0xffb454, ringSpeed1: 0.08, ringSpeed2: -0.09, ringSpeed3: 0.05, pulseSpeed: 4.0, cameraDist: 5.0 },
  danger: { name: "Threat detected", color: 0xff3b5c, ringSpeed1: 0.12, ringSpeed2: -0.14, ringSpeed3: 0.08, pulseSpeed: 10.0, cameraDist: 4.4 },
  melancholy: { name: "Low power mode", color: 0x4a75a0, ringSpeed1: 0.005, ringSpeed2: -0.007, ringSpeed3: 0.003, pulseSpeed: 0.8, cameraDist: 6.0 },
  prostrated: { name: "Core standby", color: 0x1c4a54, ringSpeed1: 0.001, ringSpeed2: -0.002, ringSpeed3: 0.001, pulseSpeed: 0.3, cameraDist: 6.5 },
};

export function HalogramTactical(props: HologramProps) {
  const { mood, thinking = false } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceKey = MOOD_TO_SOURCE_KEY[mood];
  const activeConfig = CONFIGS[sourceKey];

  useThreeMoodScene<TacticalConfig>({
    containerRef,
    configs: CONFIGS,
    activeKey: sourceKey,
    moodColor: resolveMoodColor(mood, activeConfig.color),
    speedFactor: thinking ? 2 : 1,
    build: ({ THREE, scene, camera, initialConfig }) => {
      camera.position.set(0, 0.2, initialConfig.cameraDist);
      const initialColor = resolveMoodColor(mood, initialConfig.color);

      const wireMat = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: 0.55 });
      const solidGlowMat = new THREE.MeshBasicMaterial({ color: initialColor, transparent: true, opacity: 0.12 });
      const coreMat = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: 0.85 });

      const group = new THREE.Group();
      scene.add(group);

      const coreGeo = new THREE.IcosahedronGeometry(0.85, 3);
      group.add(new THREE.Mesh(coreGeo, coreMat));
      group.add(new THREE.Mesh(coreGeo, solidGlowMat));

      const innerNode = new THREE.Mesh(new THREE.OctahedronGeometry(0.35, 0), coreMat);
      group.add(innerNode);

      const ringGroup1 = new THREE.Group();
      ringGroup1.add(new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.018, 16, 64), wireMat));
      group.add(ringGroup1);

      const ringGroup2 = new THREE.Group();
      ringGroup2.add(new THREE.Mesh(new THREE.TorusGeometry(1.65, 0.022, 16, 64), wireMat));
      ringGroup2.rotation.x = Math.PI / 4;
      ringGroup2.rotation.y = Math.PI / 6;
      group.add(ringGroup2);

      const ringGroup3 = new THREE.Group();
      ringGroup3.add(new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.015, 16, 64), wireMat));
      ringGroup3.rotation.x = -Math.PI / 3;
      group.add(ringGroup3);

      const reticleGroup = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const marker = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.25, 0.02), wireMat);
        const angle = (i * Math.PI) / 2;
        marker.position.set(Math.cos(angle) * 2.3, Math.sin(angle) * 2.3, 0);
        marker.rotation.z = angle + Math.PI / 2;
        reticleGroup.add(marker);
      }
      group.add(reticleGroup);

      const particleCount = 800;
      const particleGeo = new THREE.BufferGeometry();
      const particlePos = new Float32Array(particleCount * 3);
      for (let i = 0; i < particleCount * 3; i += 3) {
        particlePos[i] = (Math.random() - 0.5) * 8;
        particlePos[i + 1] = (Math.random() - 0.5) * 8;
        particlePos[i + 2] = (Math.random() - 0.5) * 8;
      }
      particleGeo.setAttribute("position", new THREE.BufferAttribute(particlePos, 3));
      const particleMat = new THREE.PointsMaterial({ color: initialColor, size: 0.04, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending });
      const particleSystem = new THREE.Points(particleGeo, particleMat);
      scene.add(particleSystem);

      const baseRingMat = new THREE.MeshBasicMaterial({ color: initialColor, side: THREE.DoubleSide, transparent: true, opacity: 0.4 });
      const baseRing = new THREE.Mesh(new THREE.RingGeometry(1.8, 1.86, 64), baseRingMat);
      baseRing.rotation.x = Math.PI / 2;
      baseRing.position.y = -1.6;
      scene.add(baseRing);

      return {
        colorTargets: [wireMat, solidGlowMat, coreMat, particleMat, baseRingMat],
        onFrame(elapsed, config, speedFactor) {
          ringGroup1.rotation.y += config.ringSpeed1 * speedFactor;
          ringGroup1.rotation.x += config.ringSpeed1 * speedFactor * 0.5;
          ringGroup2.rotation.y += config.ringSpeed2 * speedFactor;
          ringGroup2.rotation.z += config.ringSpeed2 * speedFactor * 0.3;
          ringGroup3.rotation.z += config.ringSpeed3 * speedFactor;
          ringGroup3.rotation.x += config.ringSpeed3 * speedFactor * 0.5;
          reticleGroup.rotation.z -= config.ringSpeed1 * speedFactor * 0.5;

          innerNode.rotation.y = elapsed * config.pulseSpeed * 0.4;
          innerNode.rotation.z = elapsed * config.pulseSpeed * 0.3;
          const pulse = 1.0 + Math.sin(elapsed * config.pulseSpeed * speedFactor) * 0.08;
          innerNode.scale.set(pulse, pulse, pulse);
          group.children[0].scale.set(pulse, pulse, pulse); // core wireframe mesh

          const positions = particleSystem.geometry.attributes.position.array as Float32Array;
          for (let i = 0; i < particleCount; i++) {
            const idx = i * 3;
            positions[idx + 1] += 0.012 * speedFactor;
            if (positions[idx + 1] > 4) {
              positions[idx + 1] = -4;
              positions[idx] = (Math.random() - 0.5) * 8;
              positions[idx + 2] = (Math.random() - 0.5) * 8;
            }
          }
          particleSystem.geometry.attributes.position.needsUpdate = true;
          particleSystem.rotation.y = elapsed * 0.03;
          baseRing.rotation.z = elapsed * 0.2;
          camera.position.z += (config.cameraDist - camera.position.z) * 0.05;
        },
      };
    },
  });

  return <HalogramShell {...props} containerRef={containerRef} defaultLabel={activeConfig.name} />;
}
