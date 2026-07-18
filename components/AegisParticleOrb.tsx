'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import type { AegisOrbState } from './AegisOrb';

// WebGL is client-only and must not run during SSR — same pattern as Compass3D.
const Scene = dynamic(() => import('./AegisParticleOrbScene'), {
  ssr: false,
  loading: () => <span className="block w-full h-full" aria-hidden="true" />,
});

const EQ_BARS = [0, 1, 2, 3, 4];

/** Mic-style volume equalizer shown inside the ring (idle = calm, speaking = active). */
function OrbEqualizer({ active }: { active: boolean }) {
  return (
    <span className={`aegis-eq ${active ? 'aegis-eq-speaking' : 'aegis-eq-idle'}`}>
      {EQ_BARS.map((i) => (
        <span
          key={i}
          className="aegis-eq-bar"
          style={{ animationDelay: `${(i * 0.1).toFixed(2)}s` }}
        />
      ))}
    </span>
  );
}

// Mini neural-network graph that mimics the homepage law graph (in blue, no
// labels): nodes ORBIT the hub at their own radius/speed and the edges follow
// them every frame, so the connections flex and stretch just like the homepage.
const NET_RADIUS = [2.0, 1.7, 1.5, 1.7, 1.5, 1.7, 1.5, 1.3, 1.3]; // node sizes
const NET_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8],
  [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 1], [7, 6], [8, 3],
];
// Per-node orbit: [orbitRadius, phase, speed]. Hub (index 0) stays centred.
const NET_ORBIT: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [16, 0.0, 0.22],
  [24, 2.4, -0.16],
  [20, 4.8, 0.19],
  [30, 1.2, -0.13],
  [22, 3.6, 0.17],
  [27, 6.0, -0.2],
  [13, 0.8, 0.28],
  [17, 5.2, -0.24],
];

/** Orbiting neural-network shown inside the ring while thinking. */
function OrbNetwork() {
  const lines = useRef<Array<SVGLineElement | null>>([]);
  const nodes = useRef<Array<SVGCircleElement | null>>([]);

  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const px = new Array(NET_ORBIT.length).fill(50);
    const py = new Array(NET_ORBIT.length).fill(50);

    const loop = (now: number) => {
      const t = (now - start) / 1000;
      for (let i = 0; i < NET_ORBIT.length; i++) {
        const [rad, phase, speed] = NET_ORBIT[i];
        const ang = phase + speed * t;
        px[i] = 50 + rad * Math.cos(ang);
        py[i] = 50 + rad * Math.sin(ang);
        const c = nodes.current[i];
        if (c) {
          c.setAttribute('cx', px[i].toFixed(2));
          c.setAttribute('cy', py[i].toFixed(2));
        }
      }
      for (let e = 0; e < NET_EDGES.length; e++) {
        const [a, b] = NET_EDGES[e];
        const l = lines.current[e];
        if (l) {
          l.setAttribute('x1', px[a].toFixed(2));
          l.setAttribute('y1', py[a].toFixed(2));
          l.setAttribute('x2', px[b].toFixed(2));
          l.setAttribute('y2', py[b].toFixed(2));
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg className="aegis-tnet-svg" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      {NET_EDGES.map((_, i) => (
        <line
          key={`e${i}`}
          ref={(el) => {
            lines.current[i] = el;
          }}
          x1="50"
          y1="50"
          x2="50"
          y2="50"
          stroke="rgba(90,200,255,0.28)"
          strokeWidth={0.6}
        />
      ))}
      {NET_RADIUS.map((r, i) => (
        <circle
          key={`n${i}`}
          ref={(el) => {
            nodes.current[i] = el;
          }}
          className="aegis-tnet-node"
          cx="50"
          cy="50"
          r={r}
          fill={i === 0 ? 'rgba(200,240,255,0.98)' : 'rgba(80,200,255,0.9)'}
          style={{ animationDelay: `${(i * 0.22).toFixed(2)}s` }}
        />
      ))}
    </svg>
  );
}

/**
 * Large AEGIS orb — a WebGL particle ring (the outer border) with a styled
 * overlay inside: a mic-style volume equalizer (idle/speaking) or a drifting
 * cloud (thinking). Used only for the `lg` size; small inline icons stay on the
 * cheap SVG renderer so we don't spawn a GL context per message.
 */
export default function AegisParticleOrb({
  state,
  className = '',
}: {
  state: AegisOrbState;
  className?: string;
}) {
  return (
    <span className={`relative inline-block ${className}`} aria-hidden="true">
      <Scene state={state} />
      <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
        {/* idle = just the ring; thinking = orbiting network; speaking = bars */}
        {state === 'thinking' ? (
          <OrbNetwork />
        ) : state === 'speaking' ? (
          <OrbEqualizer active />
        ) : null}
      </span>
    </span>
  );
}
