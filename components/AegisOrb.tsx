import AegisParticleOrb from './AegisParticleOrb';

export type AegisOrbState = 'idle' | 'thinking' | 'speaking';
export type AegisOrbSize = 'sm' | 'lg';

const SIZE_MAP: Record<AegisOrbSize, string> = {
  sm: 'w-9 h-9',
  lg: 'w-56 h-56',
};

// ─────────────────────────── Particle-shell geometry ───────────────────────────
// A dense shell of points on a sphere (Fibonacci spiral) projected flat. The
// silhouette is pushed in/out by a few low-frequency sine waves so the rim
// ripples like the reference instead of being a perfect circle. Orthographic
// projection naturally clusters points toward the limb, which — together with
// rim-weighted brightness — gives the glowing cyan edge over a dark interior.
//
// Computed once, deterministically (no Math.random) → identical on server and
// client, no hydration drift, SSR-safe.

const R = 40; // base sphere radius within the 100×100 viewBox
const C = 50; // centre

type Particle = {
  sx: number; // screen x
  sy: number; // screen y
  rim: number; // 0 (centre) … 1 (edge) — drives brightness + size
  back: boolean; // far hemisphere?
};

function buildShell(count: number): Particle[] {
  const out: Particle[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2; // 1 → -1
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const x = Math.cos(theta) * ring;
    const z = Math.sin(theta) * ring;

    // Wavy silhouette: displace radially by angle so the rim bulges in lobes.
    const ang = Math.atan2(y, x);
    const wobble =
      1 +
      0.075 * Math.sin(3 * ang + 0.4) +
      0.05 * Math.sin(5 * ang + 2.1) +
      0.03 * Math.sin(8 * ang);

    const px = x * wobble;
    const py = y * wobble;
    const rim = Math.min(1, Math.sqrt(px * px + py * py));

    out.push({
      sx: C + px * R,
      sy: C - py * R,
      rim,
      back: z < 0,
    });
  }
  return out;
}

const PARTICLES = buildShell(150);

/** Rim-weighted cyan: dim deep-blue at the centre → bright cyan at the edge. */
function particleFill(rim: number, back: boolean): string {
  const b = Math.pow(rim, 2.6); // bias hard toward the rim
  const r = Math.round(20 + 100 * b);
  const g = Math.round(120 + 125 * b);
  const bl = Math.round(180 + 75 * b);
  const a = (0.1 + 0.85 * b) * (back ? 0.78 : 1);
  return `rgba(${r},${g},${bl},${a.toFixed(3)})`;
}

/**
 * AEGIS particle-shell sphere — a dark orb wrapped in a glowing cyan particle
 * shell with a rippling rim.
 *
 *  - idle     → slow spin, gentle breathing wobble
 *  - thinking → faster spin, stronger wobble
 *  - speaking → wrap glow-pulse, fast wobble, expanding ripples + mist
 *
 * Pure SVG + CSS animations. No canvas, no WebGL, no deps. SSR-safe.
 *
 * Multiple instances share the same `<defs>` IDs, which is harmless: the defs
 * are identical so `url(#id)` resolves consistently.
 */
export function AegisOrb({
  state,
  size = 'sm',
}: {
  state: AegisOrbState;
  size?: AegisOrbSize;
}) {
  // The large orb is the real WebGL particle sphere; small inline icons stay
  // on the lightweight SVG below (one GL context per message would be too much).
  if (size === 'lg') {
    return (
      <AegisParticleOrb
        state={state}
        className={`aegis-orb-wrap aegis-orb-wrap-${state} ${SIZE_MAP.lg} rounded-full`}
      />
    );
  }

  const particles = (
    <>
      {PARTICLES.map((p, i) => (
        <circle
          key={i}
          cx={p.sx}
          cy={p.sy}
          r={(0.45 + 1.35 * Math.pow(p.rim, 2)).toFixed(2)}
          fill={particleFill(p.rim, p.back)}
        />
      ))}
    </>
  );

  return (
    <span
      className={`aegis-orb-wrap aegis-orb-wrap-${state} ${SIZE_MAP[size]} relative inline-flex items-center justify-center shrink-0 rounded-full`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" className="w-full h-full overflow-visible">
        <defs>
          <radialGradient id="aegis-body" cx="50%" cy="50%">
            <stop offset="0%" stopColor="rgba(2,8,16,0.95)" />
            <stop offset="55%" stopColor="rgba(2,12,28,0.85)" />
            <stop offset="100%" stopColor="rgba(0,40,70,0)" />
          </radialGradient>
          <radialGradient id="aegis-glow" cx="50%" cy="50%">
            <stop offset="0%" stopColor="rgba(0,200,255,0)" />
            <stop offset="70%" stopColor="rgba(0,200,255,0.06)" />
            <stop offset="100%" stopColor="rgba(0,225,255,0.18)" />
          </radialGradient>
          <filter id="aegis-blur" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="1.6" />
          </filter>
        </defs>

        {/* Dark sphere interior */}
        <circle cx={C} cy={C} r={R} fill="url(#aegis-body)" />
        {/* Faint volumetric rim glow */}
        <circle
          cx={C}
          cy={C}
          r={R + 4}
          fill="url(#aegis-glow)"
          className={`aegis-glow aegis-glow-${state}`}
        />

        {/* While speaking: drifting mist + expanding ripples */}
        {state === 'speaking' && (
          <g>
            <circle
              cx={C}
              cy={C}
              r="44"
              fill="url(#aegis-glow)"
              filter="url(#aegis-blur)"
              className="aegis-mist"
            />
            {[0, 1, 2].map((i) => (
              <circle
                key={i}
                cx={C}
                cy={C}
                r={R}
                fill="none"
                stroke="rgba(80,220,255,0.6)"
                strokeWidth="1"
                className="aegis-wave"
                style={{ animationDelay: `${(i * 0.7).toFixed(1)}s` }}
              />
            ))}
          </g>
        )}

        {/* Spinning shell with a breathing wobble */}
        <g
          className={`aegis-spin aegis-spin-${state}`}
          style={{ transformOrigin: '50% 50%' }}
        >
          <g
            className={`aegis-wobble aegis-wobble-${state}`}
            style={{ transformOrigin: '50% 50%' }}
          >
            {particles}
          </g>
        </g>
      </svg>
    </span>
  );
}
