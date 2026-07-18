'use client';

import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AegisOrbState } from './AegisOrb';

// Per-state targets for the ring's displacement + motion. It lerps toward these
// so idle → speaking transitions glide instead of snapping.
const TUNING: Record<AegisOrbState, { amp: number; speed: number; spin: number; bright: number }> = {
  idle: { amp: 0.10, speed: 0.14, spin: 0.16, bright: 0.55 },
  thinking: { amp: 0.16, speed: 0.4, spin: 0.4, bright: 0.65 },
  speaking: { amp: 0.24, speed: 0.7, spin: 0.28, bright: 0.85 },
};

const RING_COUNT = 13000;

// Ashima 3D simplex noise (public domain) — drives the rippling displacement.
const SNOISE = /* glsl */ `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x,289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+1.0*C.xxx; vec3 x2=x0-i2+2.0*C.xxx; vec3 x3=x0-1.0+3.0*C.xxx;
  i=mod(i,289.0);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=1.0/7.0; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

// Sphere of particles brightness-gated by the LIMB (Fresnel): only the
// silhouette lights up, so it reads as a glowing ring (the outer border) with
// an empty inside — and stays a ring as it spins. Nothing wraps around it.
const RING_VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uSpeak;
uniform float uBright;
uniform float uSize;
attribute float aScale;
varying float vGlow;
${SNOISE}
void main(){
  vec3 nrm = normalize(position);
  float n  = snoise(nrm * 1.7 + uTime * 0.7);
  float n2 = snoise(nrm * 3.6 - uTime * 1.1);
  float disp = n * 0.72 + n2 * 0.28;
  float pulse = uSpeak * 0.10 * sin(uTime * 6.0 + nrm.y * 4.0);
  float d = disp * (uAmp + uSpeak * 0.16) + pulse;
  vec3 pos = nrm * (1.0 + d);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vec3 viewDir = normalize(-mv.xyz);
  vec3 viewNrm = normalize(normalMatrix * nrm);
  float rim = 1.0 - abs(dot(viewNrm, viewDir));
  rim = pow(clamp(rim, 0.0, 1.0), 2.3);

  float shimmer = 0.65 + 0.35 * (disp * 0.5 + 0.5);
  vGlow = rim * shimmer * (uBright + uSpeak * 0.4);

  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * aScale * (1.0 / -mv.z) * (0.5 + rim);
}
`;

const RING_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uColorLow;
uniform vec3 uColorHigh;
varying float vGlow;
void main(){
  if (vGlow < 0.02) discard;                 // keep the inside empty
  float dist = length(gl_PointCoord - 0.5);
  float alpha = pow(smoothstep(0.5, 0.0, dist), 1.7);
  vec3 col = mix(uColorLow, uColorHigh, clamp(vGlow, 0.0, 1.0));
  col += vGlow * 0.12;
  gl_FragColor = vec4(col, alpha * clamp(vGlow, 0.0, 1.0) * 0.5);
}
`;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * Math.min(1, t);
}

function RingShell({ state }: { state: AegisOrbState }) {
  const ring = useRef<THREE.Points>(null);

  const geom = useMemo(() => {
    const positions = new Float32Array(RING_COUNT * 3);
    const scales = new Float32Array(RING_COUNT);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < RING_COUNT; i++) {
      const y = 1 - (i / (RING_COUNT - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const t = golden * i;
      positions[i * 3] = Math.cos(t) * r;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(t) * r;
      scales[i] = 0.6 + Math.random() * 1.9;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    return g;
  }, []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmp: { value: TUNING.idle.amp },
      uSpeak: { value: 0 },
      uBright: { value: TUNING.idle.bright },
      uSize: { value: 16 },
      uColorLow: { value: new THREE.Color(0.02, 0.4, 0.78) },
      uColorHigh: { value: new THREE.Color(0.6, 0.96, 1.0) },
    }),
    [],
  );

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const tune = TUNING[state];
    uniforms.uTime.value += dt * tune.speed;
    uniforms.uAmp.value = lerp(uniforms.uAmp.value, tune.amp, dt * 3);
    uniforms.uBright.value = lerp(uniforms.uBright.value, tune.bright, dt * 3);
    uniforms.uSpeak.value = lerp(uniforms.uSpeak.value, state === 'speaking' ? 1 : 0, dt * 2.5);
    if (ring.current) {
      ring.current.rotation.y += dt * tune.spin;
      ring.current.rotation.z = Math.sin(uniforms.uTime.value * 0.15) * 0.18;
    }
  });

  return (
    <points ref={ring} geometry={geom}>
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={RING_VERT}
        fragmentShader={RING_FRAG}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

export default function AegisParticleOrbScene({ state }: { state: AegisOrbState }) {
  return (
    <Canvas
      gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
      camera={{ position: [0, 0, 3.6], fov: 45 }}
      dpr={[1, 2]}
      style={{ background: 'transparent' }}
    >
      <RingShell state={state} />
    </Canvas>
  );
}
