/**
 * Format a USD cost (in cents) for display in dashboard tiles.
 *
 *   0           → "$0.00"
 *   0.3¢ (USD)  → "<$0.01"   (rounds to zero — show explicit "tiny" marker)
 *   60¢ (USD)   → "$0.60"
 *   $12.50      → "$12.50"
 *   $1,234      → "$1234"    (≥ $100: drop decimals)
 *
 * Always max 2 decimal places. The previous 3-decimal form ("$0.600") was
 * confusing: ambiguous whether it meant 60¢ or 6/10ths-of-a-cent.
 */
export function formatUsd(cents: number): string {
  if (cents === 0) return '$0.00';
  const usd = cents / 100;
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 0.005) return `$${usd.toFixed(2)}`;
  return '<$0.01';
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
