import { useRef } from "react";
import type { MeshBasicMaterial, Mesh } from "three";
import { HalogramShell } from "./HalogramShell";
import { useThreeMoodScene } from "./useThreeMoodScene";
import { MOOD_TO_SOURCE_KEY, resolveMoodColor, type SourceMoodKey } from "./moodMapping";
import type { HologramProps } from "./types";

/**
 * A small solar system (sun + eight orbiting, wireframe planets, Saturn included with a ring)
 * with mood controlling orbit speed and overall color tint — ported from a source mockup
 * titled "J.A.R.V.I.S. — Planetary Tactical Interface" (that name dropped; see
 * HalogramTactical.tsx's header comment for the same reasoning). The source only defined 5 of
 * our 6 mood keys (no "melancholy"), so one is synthesized below to fill that gap — a slow,
 * dim entry consistent with what "melancholy" means in every sibling component.
 */

const PLANET_DATA = [
  { name: "Mercury", size: 0.18, dist: 2.2, speed: 0.03 },
  { name: "Venus", size: 0.28, dist: 3.2, speed: 0.022 },
  { name: "Earth", size: 0.32, dist: 4.4, speed: 0.016 },
  { name: "Mars", size: 0.22, dist: 5.6, speed: 0.012 },
  { name: "Jupiter", size: 0.55, dist: 7.0, speed: 0.007 },
  { name: "Saturn", size: 0.46, dist: 8.6, speed: 0.005, ring: true },
  { name: "Uranus", size: 0.36, dist: 10.0, speed: 0.003 },
  { name: "Neptune", size: 0.34, dist: 11.3, speed: 0.002 },
];

type OrbitalConfig = {
  name: string;
  color: number;
  speedFactor: number;
}

const CONFIGS: Record<SourceMoodKey, OrbitalConfig> = {
  ready: { name: "Orbital monitoring", color: 0x00f0ff, speedFactor: 1.0 },
  thinking: { name: "Computing trajectories", color: 0x8a7bff, speedFactor: 2.5 },
  synthesis: { name: "Hyper-speed simulation", color: 0xffb454, speedFactor: 5.0 },
  danger: { name: "Collision course detected", color: 0xff3b5c, speedFactor: 0.5 },
  melancholy: { name: "Drifting, low priority", color: 0x4a75a0, speedFactor: 0.3 },
  prostrated: { name: "System standby", color: 0x1c4a54, speedFactor: 0.1 },
};

export function HalogramOrbital(props: HologramProps) {
  const { mood, thinking = false } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceKey = MOOD_TO_SOURCE_KEY[mood];
  const activeConfig = CONFIGS[sourceKey];

  useThreeMoodScene<OrbitalConfig>({
    containerRef,
    configs: CONFIGS,
    activeKey: sourceKey,
    moodColor: resolveMoodColor(mood, activeConfig.color),
    speedFactor: thinking ? 2 : 1,
    build: ({ THREE, scene, camera, initialConfig }) => {
      camera.position.set(0, 7, 13);
      camera.lookAt(0, 0, 0);
      const initialColor = resolveMoodColor(mood, initialConfig.color);

      const wireMat = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: 0.45 });
      const orbitMat = new THREE.MeshBasicMaterial({ color: initialColor, transparent: true, opacity: 0.25 });
      const sunMat = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: 0.85 });

      const group = new THREE.Group();
      scene.add(group);

      const sunMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 2), sunMat);
      group.add(sunMesh);

      const planetMats: MeshBasicMaterial[] = [];
      const planets: { mesh: Mesh; dist: number; speed: number; angle: number }[] = [];

      for (const data of PLANET_DATA) {
        const orbitMesh = new THREE.Mesh(new THREE.RingGeometry(data.dist - 0.015, data.dist + 0.015, 128), orbitMat);
        orbitMesh.rotation.x = Math.PI / 2;
        group.add(orbitMesh);

        const planetMat = new THREE.MeshBasicMaterial({ color: initialColor, wireframe: true, transparent: true, opacity: 0.8 });
        planetMats.push(planetMat);
        const planetMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(data.size, 2), planetMat);
        planetMesh.position.x = data.dist;

        if (data.ring) {
          const saturnRing = new THREE.Mesh(new THREE.RingGeometry(data.size + 0.12, data.size + 0.32, 32), wireMat);
          saturnRing.rotation.x = Math.PI / 3;
          planetMesh.add(saturnRing);
        }

        group.add(planetMesh);
        planets.push({ mesh: planetMesh, dist: data.dist, speed: data.speed, angle: Math.random() * Math.PI * 2 });
      }

      const particleCount = 500;
      const particleGeo = new THREE.BufferGeometry();
      const particlePos = new Float32Array(particleCount * 3);
      for (let i = 0; i < particleCount * 3; i += 3) {
        particlePos[i] = (Math.random() - 0.5) * 30;
        particlePos[i + 1] = (Math.random() - 0.5) * 30;
        particlePos[i + 2] = (Math.random() - 0.5) * 30;
      }
      particleGeo.setAttribute("position", new THREE.BufferAttribute(particlePos, 3));
      const particleMat = new THREE.PointsMaterial({ color: initialColor, size: 0.05, transparent: true, opacity: 0.5 });
      const particleSystem = new THREE.Points(particleGeo, particleMat);
      scene.add(particleSystem);

      return {
        colorTargets: [wireMat, orbitMat, sunMat, particleMat, ...planetMats],
        onFrame(elapsed, config, speedFactor) {
          sunMesh.rotation.y = elapsed * 0.2;
          for (const p of planets) {
            p.angle += p.speed * config.speedFactor * speedFactor;
            p.mesh.position.x = Math.cos(p.angle) * p.dist;
            p.mesh.position.z = Math.sin(p.angle) * p.dist;
            p.mesh.rotation.y += 0.02;
          }
          particleSystem.rotation.y = elapsed * 0.02;
        },
      };
    },
  });

  return <HalogramShell {...props} containerRef={containerRef} defaultLabel={activeConfig.name} />;
}
