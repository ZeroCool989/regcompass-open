import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../prompts/mode_conversational';

describe('CONVERSATIONAL length policy', () => {
  const prompt = buildPrompt({ language: 'de' });

  it('keeps the concise default for ordinary questions', () => {
    expect(prompt.toLowerCase()).toContain('concis'); // "concisely"
    expect(prompt).toMatch(/4 short paragraphs/);
  });

  it('allows complete long structured deliverables for report-type requests', () => {
    expect(prompt).toMatch(/report, catalogue, framework/i);
    expect(prompt).toMatch(/management summary/i);
    expect(prompt).toMatch(/do NOT apply the paragraph cap/i);
  });

  it('still requires citations + explicit not-covered marking (grounding unchanged)', () => {
    expect(prompt).toContain('[R-...]');
    expect(prompt).toMatch(/nicht durch die Wissensbasis abgedeckt/);
  });

  it('encodes the structured-overview citation discipline (search_kb first, cite per paragraph, no bare article numbers, no-match fallback)', () => {
    expect(prompt).toMatch(/STRUCTURED REGULATORY OVERVIEWS/);
    expect(prompt).toMatch(/FIRST gather the IDs/i);
    expect(prompt).toMatch(/Only IDs returned by tool calls in THIS turn may be cited/i);
    expect(prompt).toMatch(/CITE PER PARAGRAPH/);
    expect(prompt).toMatch(/must NOT contain bare article numbers/i);
    expect(prompt).toMatch(/NEVER invent or guess an \[R-\.\.\.\] ID/);
    // general, not DORA-only
    expect(prompt).toMatch(/applies generally, not to one regulation/);
  });
});
