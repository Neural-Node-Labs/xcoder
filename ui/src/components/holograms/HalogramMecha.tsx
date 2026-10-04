import { useRef } from "react";
import { HalogramShell } from "./HalogramShell";
import { useThreeMoodScene } from "./useThreeMoodScene";
import { MOOD_TO_SOURCE_KEY, resolveMoodColor, type SourceMoodKey } from "./moodMapping";
import type { HologramProps } from "./types";

/**
 * A wireframe mecha/robot head — angular helmet, a V-shaped crest antenna (a generic mecha
 * design trope, not any one franchise's protected trade dress), angled visor "eyes", and an
 * internal reactor core — ported from a source mockup titled "AI Mecha Interface". Its mood
 * labels were already generic; nothing there needed neutralizing.
 */

type MechaConfig = {
  name: string;
  color: number;
  tiltX: number;
  tiltZ: number;
  eyeScaleY: number;
  pulseSpeed: number;
  wireOpacity: number;
  cameraDist: number;
}

const CONFIGS: Record<SourceMoodKey, MechaConfig> = {
  ready: { name: "System ready", color: 0x00f0ff, tiltX: 0, tiltZ: 0, eyeScaleY: 1.0, pulseSpeed: 2.0, wireOpacity: 0.5, cameraDist: 5.5 },
  thinking: { name: "Targeting computation", color: 0x8a7bff, tiltX: 0.15, tiltZ: -0.05, eyeScaleY: 0.85, pulseSpeed: 5.0, wireOpacity: 0.7, cameraDist: 4.8 },
  synthesis: { name: "Overdrive", color: 0xffb454, tiltX: -0.08, tiltZ: 0.04, eyeScaleY: 1.25, pulseSpeed: 4.0, wireOpacity: 0.8, cameraDist: 5.0 },
  danger: { name: "Critical alert", color: 0xff3b5c, tiltX: 0.2, tiltZ: 0.0, eyeScaleY: 0.4, pulseSpeed: 10.0, wireOpacity: 0.9, cameraDist: 4.5 },
  melancholy: { name: "Low energy", color: 0x4a75a0, tiltX: 0.25, tiltZ: 0.08, eyeScaleY: 0.4, pulseSpeed: 0.8, wireOpacity: 0.35, cameraDist: 6.0 },
  prostrated: { name: "Core offline", color: 0x1c4a54, tiltX: 0.5, tiltZ: 0.0, eyeScaleY: 0.05, pulseSpeed: 0.3, wireOpacity: 0.2, cameraDist: 6.5 },
};

export function HalogramMecha(props: HologramProps) {
  const { mood, thinking = false } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceKey = MOOD_TO_SOURCE_KEY[mood];
  const activeConfig = CONFIGS[sourceKey];

  useThreeMoodScene<MechaConfig>({
    containerRef,
    configs: CONFIGS,
    activeKey: sourceKey,
    moodColor: resolveMoodColor(mood, activeConfig.color),
    speedFactor: thinking ? 2 : 1,
    build: ({ THREE, scene, camera, initialConfig }) => {
      camera.position.set(0, 0.2, initialConfig.cameraDist);
      const initialColor = resolveMoodColor(mood, initialConfig.color);

      const wireMat = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: initialConfig.wireOpacity });
      const solidMat = new THREE.MeshBasicMaterial({ color: initialColor, transparent: true, opacity: 0.08 });
      const eyeMat = new THREE.MeshBasicMaterial({ color: initialColor, transparent: true, opacity: 0.95 });
      const coreMat = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: 0.8 });

      const mechaGroup = new THREE.Group();
      scene.add(mechaGroup);

      const helmetGeo = new THREE.BoxGeometry(0.8, 0.7, 0.9);
      mechaGroup.add(new THREE.Mesh(helmetGeo, wireMat));
      mechaGroup.add(new THREE.Mesh(helmetGeo, solidMat));

      const gemGeo = new THREE.OctahedronGeometry(0.12, 0);
      gemGeo.scale(1.0, 1.4, 0.6);
      const gemMesh = new THREE.Mesh(gemGeo, eyeMat);
      gemMesh.position.set(0, 0.32, 0.46);
      mechaGroup.add(gemMesh);

      const vFinLeftGeo = new THREE.ConeGeometry(0.08, 1.3, 4);
      vFinLeftGeo.rotateZ(-Math.PI / 3);
      vFinLeftGeo.scale(0.3, 1.0, 0.3);
      const vFinLeft = new THREE.Mesh(vFinLeftGeo, wireMat);
      vFinLeft.position.set(-0.5, 0.65, 0.4);
      mechaGroup.add(vFinLeft);

      const vFinRightGeo = new THREE.ConeGeometry(0.08, 1.3, 4);
      vFinRightGeo.rotateZ(Math.PI / 3);
      vFinRightGeo.scale(0.3, 1.0, 0.3);
      const vFinRight = new THREE.Mesh(vFinRightGeo, wireMat);
      vFinRight.position.set(0.5, 0.65, 0.4);
      mechaGroup.add(vFinRight);

      const cheekGeo = new THREE.BoxGeometry(0.25, 0.5, 0.6);
      cheekGeo.rotateY(0.3);
      const cheekLeft = new THREE.Mesh(cheekGeo, wireMat);
      cheekLeft.position.set(-0.48, -0.05, 0.2);
      mechaGroup.add(cheekLeft);
      const cheekRight = new THREE.Mesh(cheekGeo, wireMat);
      cheekRight.position.set(0.48, -0.05, 0.2);
      cheekRight.rotation.y = -0.3;
      mechaGroup.add(cheekRight);

      const leftEyeGeo = new THREE.BoxGeometry(0.28, 0.07, 0.15);
      leftEyeGeo.rotateZ(-0.1);
      const leftEye = new THREE.Mesh(leftEyeGeo, eyeMat);
      leftEye.position.set(-0.2, 0.08, 0.46);
      mechaGroup.add(leftEye);

      const rightEyeGeo = new THREE.BoxGeometry(0.28, 0.07, 0.15);
      rightEyeGeo.rotateZ(0.1);
      const rightEye = new THREE.Mesh(rightEyeGeo, eyeMat);
      rightEye.position.set(0.2, 0.08, 0.46);
      mechaGroup.add(rightEye);

      const faceplateGeo = new THREE.ConeGeometry(0.35, 0.45, 4);
      faceplateGeo.rotateX(Math.PI);
      const faceplate = new THREE.Mesh(faceplateGeo, wireMat);
      faceplate.position.set(0, -0.25, 0.42);
      mechaGroup.add(faceplate);

      const chinGuard = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.22), eyeMat);
      chinGuard.position.set(0, -0.42, 0.45);
      mechaGroup.add(chinGuard);

      const coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.25, 2), coreMat);
      mechaGroup.add(coreMesh);
      mechaGroup.position.y = 0.1;

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
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.56, 64), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -1.2;
      scene.add(ring);

      return {
        colorTargets: [wireMat, solidMat, eyeMat, coreMat, particleMat, ringMat],
        onFrame(elapsed, config, speedFactor) {
          mechaGroup.rotation.x += (config.tiltX - mechaGroup.rotation.x) * 0.05;
          mechaGroup.rotation.z += (config.tiltZ - mechaGroup.rotation.z) * 0.05;

          const hoverY = Math.sin(elapsed * 1.2) * 0.04;
          mechaGroup.position.y = 0.1 + hoverY;
          mechaGroup.rotation.y = Math.cos(elapsed * 0.8) * 0.03;

          coreMesh.rotation.y = elapsed * config.pulseSpeed * 0.4;
          coreMesh.rotation.x = elapsed * config.pulseSpeed * 0.2;
          const pulse = 1.0 + Math.sin(elapsed * config.pulseSpeed * speedFactor) * 0.1;
          coreMesh.scale.set(pulse, pulse, pulse);

          leftEye.scale.y += (config.eyeScaleY - leftEye.scale.y) * 0.2;
          rightEye.scale.y += (config.eyeScaleY - rightEye.scale.y) * 0.2;
          wireMat.opacity += (config.wireOpacity - wireMat.opacity) * 0.1;

          const positions = particleSystem.geometry.attributes.position.array as Float32Array;
          for (let i = 0; i < particleCount; i++) {
            const idx = i * 3;
            positions[idx + 1] += 0.012 * speedFactor;
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
