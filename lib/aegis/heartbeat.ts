/**
 * A minimal keep-alive ticker for the AEGIS SSE stream. `onTick` runs every
 * `intervalMs` until `stop()` is called. Extracted (and injectable timers) so
 * the lifecycle is unit-testable: it emits while running and emits nothing
 * after `stop()`.
 */
export type Heartbeat = { stop: () => void };

export function createHeartbeat(
  onTick: () => void,
  intervalMs: number,
  timers: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } = {
    setInterval,
    clearInterval,
  },
): Heartbeat {
  const id = timers.setInterval(onTick, intervalMs);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(id);
    },
  };
}
