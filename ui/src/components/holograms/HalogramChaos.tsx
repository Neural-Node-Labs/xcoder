import { useRef } from "react";
import { HalogramShell } from "./HalogramShell";
import { useThreeMoodScene } from "./useThreeMoodScene";
import { MOOD_TO_SOURCE_KEY, resolveMoodColor, type SourceMoodKey } from "./moodMapping";
import type { HologramProps } from "./types";

/**
 * An organic, noise-distorted wireframe core (GLSL simplex noise deforming an icosahedron in
 * the vertex shader, Fresnel edge glow in the fragment shader) with a rising particle field —
 * ported from a source mockup titled "AI Neural State Monitor". No trademark concerns in this
 * one (unlike several of its siblings), so nothing needed neutralizing here.
 */

type ChaosConfig = {
  name: string;
  color: number;
  speed: number;
  distortion: number;
  noiseFrequency: number;
  particleSpeed: number;
  cameraDist: number;
  pulseFreq: number;
}

const CONFIGS: Record<SourceMoodKey, ChaosConfig> = {
  ready: { name: "Synapse idle", color: 0x00f0ff, speed: 0.008, distortion: 0.25, noiseFrequency: 1.2, particleSpeed: 0.02, cameraDist: 6.5, pulseFreq: 1.5 },
  thinking: { name: "Processing prompt", color: 0x8a7bff, speed: 0.025, distortion: 0.6, noiseFrequency: 2.5, particleSpeed: 0.06, cameraDist: 5.8, pulseFreq: 4.0 },
  synthesis: { name: "Creative synthesis", color: 0xffb454, speed: 0.015, distortion: 0.4, noiseFrequency: 1.8, particleSpeed: 0.08, cameraDist: 6.0, pulseFreq: 2.0 },
  danger: { name: "Critical overload", color: 0xff3b5c, speed: 0.045, distortion: 1.2, noiseFrequency: 4.0, particleSpeed: 0.12, cameraDist: 5.2, pulseFreq: 8.0 },
  melancholy: { name: "Entropy decay", color: 0x4a75a0, speed: 0.003, distortion: 0.15, noiseFrequency: 0.8, particleSpeed: 0.005, cameraDist: 7.2, pulseFreq: 0.8 },
  prostrated: { name: "Dormant core", color: 0x1c4a54, speed: 0.001, distortion: 0.05, noiseFrequency: 0.4, particleSpeed: 0.001, cameraDist: 8.0, pulseFreq: 0.3 },
};

// Simplex-noise vertex displacement + Fresnel-glow fragment shader, unchanged from the source.
const VERTEX_SHADER = `
  uniform float uTime;
  uniform float uDistortion;
  uniform float uFrequency;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vNoise;
  vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy) );
    vec3 x0 = v - i + dot(i, C.xxx) ;
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min( g.xyz, l.zxy );
    vec3 i2 = max( g.xyz, l.zxy );
    vec3 x1 = x0 - i1 + 1.0 * C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
    i = mod(i, 289.0 );
    vec4 p = permute( permute( permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));
    float n_ = 0.142857142857;
    vec3  ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_ );
    vec4 x = x_ *ns.x + vec4(ns.yyyy);
    vec4 y = y_ *ns.x + vec4(ns.yyyy);
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4( x.xy, y.xy );
    vec4 b1 = vec4( x.zw, y.zw );
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;
    vec3 p0 = vec3(a0.xy,h.x);
    vec3 p1 = vec3(a0.zw,h.y);
    vec3 p2 = vec3(a1.xy,h.z);
    vec3 p3 = vec3(a1.zw,h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
  }
  void main() {
    vNormal = normal;
    vPosition = position;
    float noise = snoise(position * uFrequency + vec3(uTime * 0.5));
    vNoise = noise;
    vec3 newPosition = position + normal * (noise * uDistortion);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  uniform float uTime;
  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vNoise;
  void main() {
    vec3 viewDir = normalize(-vPosition);
    float fresnel = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 2.5);
    float scanline = sin(vPosition.y * 40.0 + uTime * 6.0) * 0.1 + 0.9;
    vec3 finalColor = uColor + vec3(vNoise * 0.25);
    float alpha = (fresnel + 0.15) * scanline;
    gl_FragColor = vec4(finalColor, alpha * 0.85);
  }
`;

export function HalogramChaos(props: HologramProps) {
  const { mood, thinking = false } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceKey = MOOD_TO_SOURCE_KEY[mood];
  const activeConfig = CONFIGS[sourceKey];

  useThreeMoodScene<ChaosConfig>({
    containerRef,
    configs: CONFIGS,
    activeKey: sourceKey,
    moodColor: resolveMoodColor(mood, activeConfig.color),
    speedFactor: thinking ? 2.2 : 1,
    build: ({ THREE, scene, camera, initialConfig }) => {
      const coreUniforms = {
        uTime: { value: 0 },
        uDistortion: { value: initialConfig.distortion },
        uFrequency: { value: initialConfig.noiseFrequency },
        uColor: { value: new THREE.Color(resolveMoodColor(mood, initialConfig.color)) },
      };
      const coreMaterial = new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms: coreUniforms,
        transparent: true,
        wireframe: true,
        blending: THREE.AdditiveBlending,
      });
      const hologramCore = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4, 30), coreMaterial);
      scene.add(hologramCore);

      const innerMat = new THREE.MeshBasicMaterial({ color: resolveMoodColor(mood, initialConfig.color), wireframe: true, transparent: true, opacity: 0.6 });
      const innerCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 4), innerMat);
      hologramCore.add(innerCore);

      const particleCount = 900;
      const particleGeo = new THREE.BufferGeometry();
      const particlePos = new Float32Array(particleCount * 3);
      for (let i = 0; i < particleCount * 3; i += 3) {
        particlePos[i] = (Math.random() - 0.5) * 8;
        particlePos[i + 1] = (Math.random() - 0.5) * 8;
        particlePos[i + 2] = (Math.random() - 0.5) * 8;
      }
      particleGeo.setAttribute("position", new THREE.BufferAttribute(particlePos, 3));
      const particleMat = new THREE.PointsMaterial({ color: resolveMoodColor(mood, initialConfig.color), size: 0.045, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending });
      const particleSystem = new THREE.Points(particleGeo, particleMat);
      scene.add(particleSystem);

      const ringMat = new THREE.MeshBasicMaterial({ color: resolveMoodColor(mood, initialConfig.color), side: THREE.DoubleSide, transparent: true, opacity: 0.4 });
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.8, 1.85, 64), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -2.2;
      scene.add(ring);

      return {
        colorTargets: [innerMat, particleMat, ringMat],
        onFrame(elapsed, config, speedFactor) {
          coreUniforms.uTime.value = elapsed;
          coreUniforms.uDistortion.value = config.distortion;
          coreUniforms.uFrequency.value = config.noiseFrequency;
          coreUniforms.uColor.value.lerpColors(coreUniforms.uColor.value, new THREE.Color(resolveMoodColor(mood, config.color)), 0.1);

          hologramCore.rotation.y = elapsed * config.speed * speedFactor * 10;
          hologramCore.rotation.x = Math.sin(elapsed * 0.5) * 0.2;
          innerCore.rotation.y = -elapsed * config.speed * speedFactor * 15;

          const pulse = Math.sin(elapsed * config.pulseFreq * speedFactor) * 0.05 + 1.0;
          hologramCore.scale.set(pulse, pulse, pulse);

          const positions = particleSystem.geometry.attributes.position.array as Float32Array;
          for (let i = 0; i < particleCount; i++) {
            const idx = i * 3;
            positions[idx + 1] += config.particleSpeed * speedFactor;
            if (positions[idx + 1] > 4) {
              positions[idx + 1] = -3;
              positions[idx] = (Math.random() - 0.5) * 6;
              positions[idx + 2] = (Math.random() - 0.5) * 6;
            }
          }
          particleSystem.geometry.attributes.position.needsUpdate = true;
          particleSystem.rotation.y = elapsed * 0.05;
          ring.rotation.z = elapsed * 0.2;
          camera.position.z += (config.cameraDist - camera.position.z) * 0.05;
        },
      };
    },
  });

  return <HalogramShell {...props} containerRef={containerRef} defaultLabel={activeConfig.name} />;
}
