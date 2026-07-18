import { describe, expect, it } from 'vitest';
import { chunkText, extractSpeechChunks, SPEECH_CHUNK_MAX } from '../speech-chunk';

describe('chunkText — speech units from complete text', () => {
  it('passes short plain sentences through unchanged (no regression)', () => {
    expect(chunkText('Was ist DORA?')).toEqual(['Was ist DORA?']);
    expect(chunkText('Hallo Almir.')).toEqual(['Hallo Almir.']);
  });

  it('splits at a colon, keeping the colon on the left', () => {
    expect(chunkText('Hier die drei Punkte: Banken, Versicherer, Fonds.')).toEqual([
      'Hier die drei Punkte:',
      'Banken, Versicherer, Fonds.',
    ]);
  });

  it('splits at a semicolon', () => {
    expect(chunkText('Das gilt für Banken; Versicherer sind ausgenommen.')).toEqual([
      'Das gilt für Banken;',
      'Versicherer sind ausgenommen.',
    ]);
  });

  it('does not split a time/ratio like 14:30 (no space after colon)', () => {
    expect(chunkText('Der Termin ist 14:30 Uhr.')).toEqual(['Der Termin ist 14:30 Uhr.']);
  });

  it('treats newlines and blank lines as separators (lists)', () => {
    const out = chunkText('Punkte:\n- Banken\n\n- Fonds\n');
    expect(out).toEqual(['Punkte:', '- Banken', '- Fonds']);
  });

  it('splits before German ordinals', () => {
    expect(chunkText('Erstens prüfen wir das. Zweitens dokumentieren wir.')[0]).toBe(
      'Erstens prüfen wir das.',
    );
    const inline = chunkText('Wir machen Folgendes Erstens dies Zweitens das');
    expect(inline).toEqual(['Wir machen Folgendes', 'Erstens dies', 'Zweitens das']);
  });

  it('splits before English ordinals that carry a comma', () => {
    expect(chunkText('We do this First, we scan Second, we verify')).toEqual([
      'We do this',
      'First, we scan',
      'Second, we verify',
    ]);
  });

  it('breaks an over-long unit at the nearest comma', () => {
    const long =
      'Das ist ein recht langer einleitender Satz der zunaechst viele Aspekte ausfuehrlich beschreibt, ' +
      'und der danach immer weiter geht und weiter laeuft bis er hier hinten endlich ankommt.';
    expect(long.length).toBeGreaterThan(SPEECH_CHUNK_MAX);
    const out = chunkText(long);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toContain('beschreibt,');
    for (const c of out) expect(c.length).toBeLessThanOrEqual(SPEECH_CHUNK_MAX);
  });

  it('hard-splits an over-long unit with no natural pause', () => {
    const long = 'x'.repeat(400);
    const out = chunkText(long);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(SPEECH_CHUNK_MAX);
  });

  it('does not break inside a citation', () => {
    const out = chunkText('DORA ist ein Regelwerk [R-DORA-003]: das gilt EU-weit.');
    expect(out).toEqual(['DORA ist ein Regelwerk [R-DORA-003]:', 'das gilt EU-weit.']);
  });

  it('breaks an over-long unit at a space-surrounded dash (keeps the dash left)', () => {
    const long =
      'Das ist nach unserer fachlichen Einschaetzung der wirklich entscheidende Punkt — ' +
      'und danach folgt noch ein erklaerender Zusatz der alles klar ueber das Limit treibt.';
    expect(long.length).toBeGreaterThan(SPEECH_CHUNK_MAX);
    const out = chunkText(long);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].endsWith('—')).toBe(true);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(SPEECH_CHUNK_MAX);
  });

  it('breaks an over-long pauseless unit before a conjunction', () => {
    const long =
      'Die Bank muss zahlreiche technische Schutzmassnahmen vollstaendig umsetzen ' +
      'und sie anschliessend regelmaessig sorgfaeltig auf ihre tatsaechliche Wirksamkeit hin ueberpruefen lassen.';
    expect(long.length).toBeGreaterThan(SPEECH_CHUNK_MAX);
    const out = chunkText(long);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].endsWith('umsetzen')).toBe(true); // cut BEFORE "und"
    expect(out[1].startsWith('und')).toBe(true);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(SPEECH_CHUNK_MAX);
  });

  it('prefers a comma over a conjunction when both are available', () => {
    const long =
      'Die Bank erfasst zunaechst alle ihre kritischen IT-Systeme und Anwendungen vollstaendig, ' +
      'und danach bewertet und schliesst sie die gefundenen Sicherheitsluecken zuegig und nachhaltig.';
    expect(long.length).toBeGreaterThan(SPEECH_CHUNK_MAX);
    const out = chunkText(long);
    expect(out[0].endsWith(',')).toBe(true);
    expect(out[0]).toContain('vollstaendig,');
  });

  it('hard-splits only when no natural pause exists at all', () => {
    const out = chunkText('y'.repeat(500));
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(SPEECH_CHUNK_MAX);
  });
});

describe('extractSpeechChunks — streaming', () => {
  it('matches Phase-1 sentence behaviour: closed sentences emit, the open tail waits', () => {
    // Like extractSentences, the final sentence has no trailing space yet, so it
    // stays in `rest` until more arrives or the `done` flush speaks it.
    const r = extractSpeechChunks('Hallo Almir. Wie geht es dir?');
    expect(r.chunks).toEqual(['Hallo Almir.']);
    expect(r.rest).toBe('Wie geht es dir?');

    // With a trailing space the second sentence is confidently closed.
    const r2 = extractSpeechChunks('Hallo Almir. Wie geht es dir? ');
    expect(r2.chunks).toEqual(['Hallo Almir.', 'Wie geht es dir?']);
  });

  it('emits a colon intro EARLY, before the sentence is grammatically complete', () => {
    const r = extractSpeechChunks('Hier sind die wichtigsten Punkte: ');
    expect(r.chunks).toEqual(['Hier sind die wichtigsten Punkte:']);
    expect(r.rest).toBe('');
  });

  it('emits an over-long streaming clause at a confident comma (tail held back)', () => {
    // > SPEECH_CHUNK_MAX overall, with the comma inside the split window.
    const long =
      'Das ist ein wirklich sehr langer einleitender Gedanke der noch lange nicht zu Ende ist, ' +
      'und der danach noch deutlich weiter laeuft ohne aufzuhoeren bis ganz hier hinten';
    expect(long.length).toBeGreaterThan(SPEECH_CHUNK_MAX);
    const r = extractSpeechChunks(long);
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.chunks[0]).toContain('zu Ende ist,');
    expect(r.rest).toContain('danach noch deutlich weiter');
  });

  it('keeps numbered list markers attached to their item (no standalone "1.")', () => {
    const r = extractSpeechChunks(
      'Hier die Schritte:\n1. Erstelle ein Inventar [R-DORA-005].\n2. Richte einen Prozess ein.\n',
    );
    expect(r.chunks).toEqual([
      'Hier die Schritte:',
      '1. Erstelle ein Inventar [R-DORA-005].',
      '2. Richte einen Prozess ein.',
    ]);
    // No chunk is a bare marker like "1." / "2.".
    for (const c of r.chunks) expect(c).not.toMatch(/^\d+\.$/);
  });

  it('keeps bullet list markers attached (unchanged)', () => {
    const r = extractSpeechChunks('Punkte:\n- Banken\n- Fonds\n');
    expect(r.chunks).toEqual(['Punkte:', '- Banken', '- Fonds']);
  });

  it('waits when no confident boundary exists yet', () => {
    const r = extractSpeechChunks('Ein kurzer unvollständiger Anfang');
    expect(r.chunks).toEqual([]);
    expect(r.rest).toBe('Ein kurzer unvollständiger Anfang');
  });

  it('does NOT early-flush a clause that resolves under the target length', () => {
    // ~100 chars, still incomplete: should wait, exactly like before.
    const r = extractSpeechChunks(
      'Der EU AI Act reguliert KI nach Risikoklassen und betrifft Banken nur teilweise',
    );
    expect(r.chunks).toEqual([]);
  });

  it('adaptively early-flushes a long boundary-less tail before a conjunction', () => {
    const tail =
      'Die Bank muss zunaechst alle ihre kritischen IT-Systeme vollstaendig erfassen ' +
      'und danach die gefundenen Sicherheitsluecken sorgfaeltig bewerten ';
    expect(tail.length).toBeGreaterThan(130);
    const r = extractSpeechChunks(tail);
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.chunks[0].endsWith('erfassen')).toBe(true);
    expect(r.rest.startsWith('und')).toBe(true); // tail held back for more tokens
  });
});
