import { useRef } from "react";
import type { Mesh } from "three";
import { HalogramShell } from "./HalogramShell";
import { useThreeMoodScene } from "./useThreeMoodScene";
import { MOOD_TO_SOURCE_KEY, resolveMoodColor, type SourceMoodKey } from "./moodMapping";
import type { HologramProps } from "./types";

/**
 * A denser variant of HalogramTactical.tsx — four concentric tilted rings, a central
 * "reactor"-style chest unit, and small nodes orbiting the whole assembly. Ported from a source
 * mockup titled "STARK INDUSTRIES — J.A.R.V.I.S. Tactical Hologram", whose mood label was
 * literally "ARC OVERDRIVE" and whose idle status text read "WAITING FOR SIR" — all Iron
 * Man-specific references (see HalogramTactical.tsx's header comment for the same reasoning
 * already applied there). Every user-visible string below is generic instead; the concentric-
 * ring "reactor" *shape* is a common sci-fi tech design generally, not anyone's protected
 * character or brand, so the visual design itself is kept.
 */

type ReactorConfig = {
  name: string;
  color: number;
  ringSpeed1: number;
  ringSpeed2: number;
  ringSpeed3: number;
  ringSpeed4: number;
  pulseSpeed: number;
  nodeOrbitSpeed: number;
  cameraDist: number;
}

const CONFIGS: Record<SourceMoodKey, ReactorConfig> = {
  ready: { name: "Standing by", color: 0x00d4ff, ringSpeed1: 0.012, ringSpeed2: -0.018, ringSpeed3: 0.007, ringSpeed4: -0.005, pulseSpeed: 2.0, nodeOrbitSpeed: 0.01, cameraDist: 5.8 },
  thinking: { name: "Computing", color: 0x8a7bff, ringSpeed1: 0.04, ringSpeed2: -0.055, ringSpeed3: 0.03, ringSpeed4: -0.022, pulseSpeed: 5.0, nodeOrbitSpeed: 0.03, cameraDist: 5.0 },
  synthesis: { name: "Overdrive", color: 0xffb454, ringSpeed1: 0.075, ringSpeed2: -0.09, ringSpeed3: 0.05, ringSpeed4: -0.04, pulseSpeed: 4.0, nodeOrbitSpeed: 0.045, cameraDist: 5.2 },
  danger: { name: "Threat imminent", color: 0xff3b5c, ringSpeed1: 0.13, ringSpeed2: -0.15, ringSpeed3: 0.09, ringSpeed4: -0.07, pulseSpeed: 11.0, nodeOrbitSpeed: 0.08, cameraDist: 4.5 },
  melancholy: { name: "Reduced output", color: 0x4a75a0, ringSpeed1: 0.004, ringSpeed2: -0.006, ringSpeed3: 0.002, ringSpeed4: -0.002, pulseSpeed: 0.8, nodeOrbitSpeed: 0.004, cameraDist: 6.4 },
  prostrated: { name: "Core dormant", color: 0x1c4a54, ringSpeed1: 0.001, ringSpeed2: -0.001, ringSpeed3: 0.0005, ringSpeed4: -0.0005, pulseSpeed: 0.3, nodeOrbitSpeed: 0.001, cameraDist: 7.0 },
};

export function HalogramReactorCore(props: HologramProps) {
  const { mood, thinking = false } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceKey = MOOD_TO_SOURCE_KEY[mood];
  const activeConfig = CONFIGS[sourceKey];

  useThreeMoodScene<ReactorConfig>({
    containerRef,
    configs: CONFIGS,
    activeKey: sourceKey,
    moodColor: resolveMoodColor(mood, activeConfig.color),
    speedFactor: thinking ? 2 : 1,
    build: ({ THREE, scene, camera, initialConfig }) => {
      camera.position.set(0, 0.15, initialConfig.cameraDist);
      const initialColor = resolveMoodColor(mood, initialConfig.color);

      const wireMat = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: 0.55 });
      const glowMat = new THREE.MeshBasicMaterial({ color: initialColor, transparent: true, opacity: 0.1 });
      const coreMat = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: 0.9 });
      const nodeMat = new THREE.MeshBasicMaterial({ color: initialColor, transparent: true, opacity: 0.85 });

      const group = new THREE.Group();
      scene.add(group);

      const coreGeo = new THREE.IcosahedronGeometry(0.7, 3);
      group.add(new THREE.Mesh(coreGeo, coreMat));
      group.add(new THREE.Mesh(coreGeo, glowMat));

      const innerUnit = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), coreMat);
      group.add(innerUnit);

      // "Reactor unit" — a small dense torus at the core, distinct from the four larger
      // surrounding rings below.
      const reactorUnit = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 12, 32), wireMat);
      group.add(reactorUnit);

      const ringGroup1 = new THREE.Group();
      ringGroup1.add(new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.016, 16, 64), wireMat));
      group.add(ringGroup1);

      const ringGroup2 = new THREE.Group();
      ringGroup2.add(new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.02, 16, 64), wireMat));
      ringGroup2.rotation.x = Math.PI / 4;
      ringGroup2.rotation.y = Math.PI / 6;
      group.add(ringGroup2);

      const ringGroup3 = new THREE.Group();
      ringGroup3.add(new THREE.Mesh(new THREE.TorusGeometry(1.85, 0.014, 16, 64), wireMat));
      ringGroup3.rotation.x = -Math.PI / 3;
      group.add(ringGroup3);

      const ringGroup4 = new THREE.Group();
      ringGroup4.add(new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.012, 16, 64), wireMat));
      ringGroup4.rotation.x = Math.PI / 5;
      ringGroup4.rotation.z = Math.PI / 8;
      group.add(ringGroup4);

      const nodeCount = 8;
      const nodeGroup = new THREE.Group();
      const nodeMeshes: Mesh[] = [];
      for (let i = 0; i < nodeCount; i++) {
        const node = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), nodeMat);
        const angle = (i / nodeCount) * Math.PI * 2;
        node.position.set(Math.cos(angle) * 2.6, Math.sin(angle * 2) * 0.4, Math.sin(angle) * 2.6);
        nodeGroup.add(node);
        nodeMeshes.push(node);
      }
      group.add(nodeGroup);

      const particleCount = 850;
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
      const baseRing = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.06, 64), baseRingMat);
      baseRing.rotation.x = Math.PI / 2;
      baseRing.position.y = -1.7;
      scene.add(baseRing);

      return {
        colorTargets: [wireMat, glowMat, coreMat, nodeMat, particleMat, baseRingMat],
        onFrame(elapsed, config, speedFactor) {
          ringGroup1.rotation.y += config.ringSpeed1 * speedFactor;
          ringGroup1.rotation.x += config.ringSpeed1 * speedFactor * 0.5;
          ringGroup2.rotation.y += config.ringSpeed2 * speedFactor;
          ringGroup2.rotation.z += config.ringSpeed2 * speedFactor * 0.3;
          ringGroup3.rotation.z += config.ringSpeed3 * speedFactor;
          ringGroup3.rotation.x += config.ringSpeed3 * speedFactor * 0.5;
          ringGroup4.rotation.y += config.ringSpeed4 * speedFactor;
          ringGroup4.rotation.z += config.ringSpeed4 * speedFactor * 0.4;

          innerUnit.rotation.y = elapsed * config.pulseSpeed * 0.4;
          innerUnit.rotation.z = elapsed * config.pulseSpeed * 0.3;
          reactorUnit.rotation.z = elapsed * config.pulseSpeed * 0.6;

          const pulse = 1.0 + Math.sin(elapsed * config.pulseSpeed * speedFactor) * 0.09;
          innerUnit.scale.set(pulse, pulse, pulse);
          reactorUnit.scale.set(pulse, pulse, pulse);

          nodeGroup.rotation.y += config.nodeOrbitSpeed * speedFactor;
          for (let i = 0; i < nodeMeshes.length; i++) {
            const bob = Math.sin(elapsed * config.pulseSpeed * 0.5 + i) * 0.15;
            nodeMeshes[i].position.y = Math.sin(((i / nodeCount) * Math.PI * 2) * 2) * 0.4 + bob;
          }

          const positions = particleSystem.geometry.attributes.position.array as Float32Array;
          for (let i = 0; i < particleCount; i++) {
            const idx = i * 3;
            positions[idx + 1] += 0.013 * speedFactor;
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
