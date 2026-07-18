/**
 * Tiny env-override helper for AEGIS runtime tuning knobs (output limits,
 * iteration ceilings, continuation passes, heartbeat interval). Kept separate
 * so output/runtime config has one shared reader without touching the memory
 * configuration module. Returns `fallback` for unset/invalid/non-positive values.
 */
export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
