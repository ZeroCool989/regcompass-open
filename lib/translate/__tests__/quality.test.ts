import { describe, it, expect } from 'vitest';
import { reviewTranslation } from '../quality';

describe('reviewTranslation — obligation strength', () => {
  it('flags a weakening of obligations (shall/must → may/should)', () => {
    const source = 'La entidad deberá implementar controles. La entidad deberá notificar. El proveedor deberá cumplir.';
    const translated = 'The entity may implement controls. The entity should notify. The provider should comply.';
    const w = reviewTranslation(source, translated, 'ES', 'EN');
    expect(w.some((x) => x.type === 'obligation_strength')).toBe(true);
  });

  it('produces no obligation warning when strength is preserved', () => {
    const source = 'The entity must implement controls. The entity must notify. The provider must comply.';
    const translated = 'Das Unternehmen muss Kontrollen umsetzen. Das Unternehmen muss melden. Der Anbieter muss erfüllen.';
    const w = reviewTranslation(source, translated, 'EN', 'DE');
    expect(w.some((x) => x.type === 'obligation_strength')).toBe(false);
  });

  it('skips the obligation check for an unknown source language (no throw)', () => {
    expect(() => reviewTranslation('foo', 'The provider must comply.', 'JA', 'EN')).not.toThrow();
  });
});

describe('reviewTranslation — term consistency', () => {
  it('flags one concept rendered inconsistently', () => {
    const translated =
      'The third party must report incidents. An external provider must also report. The third party remains liable.';
    const w = reviewTranslation('', translated, null, 'EN');
    expect(w.some((x) => x.type === 'term_consistency')).toBe(true);
  });

  it('does not flag a consistently-rendered term', () => {
    const translated = 'The third party must report incidents. The third party remains liable for the third party services.';
    const w = reviewTranslation('', translated, null, 'EN');
    expect(w.some((x) => x.type === 'term_consistency')).toBe(false);
  });
});

describe('reviewTranslation — contract', () => {
  it('never mutates the inputs and always returns an array', () => {
    const source = 'deberá';
    const translated = 'must';
    const out = reviewTranslation(source, translated, 'ES', 'EN');
    expect(Array.isArray(out)).toBe(true);
    expect(source).toBe('deberá');
    expect(translated).toBe('must');
  });
});
