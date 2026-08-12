import { describe, expect, it } from 'vitest';
import { formatUsd, formatLatency } from '@/components/dashboard/format';

describe('formatUsd — an unpriced run never reads as a $0 spend', () => {
  it('renders a null (unpriced: subscription/unknown) cost as an explicit marker', () => {
    expect(formatUsd(null)).toBe('—');
  });

  it('still renders a genuine zero as $0.00 — distinct from unpriced', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('formats normal, tiny, and large costs unchanged', () => {
    expect(formatUsd(60)).toBe('$0.60');
    expect(formatUsd(1250)).toBe('$12.50');
    expect(formatUsd(0.3)).toBe('<$0.01');
    expect(formatUsd(12345)).toBe('$123');
  });
});

describe('formatLatency', () => {
  it('uses ms under a second and seconds above', () => {
    expect(formatLatency(850)).toBe('850 ms');
    expect(formatLatency(1500)).toBe('1.5 s');
  });
});
