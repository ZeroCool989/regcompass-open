import { describe, expect, it } from 'vitest';
import {
  extractRegulationTags,
  renderPriorKnowledgeBlock,
  type MemoryFactLike,
} from '../aegis/cross-memory';

// ───────────────────────── extractRegulationTags ─────────────────────────

describe('extractRegulationTags', () => {
  it('extracts DORA from plain text', () => {
    expect(extractRegulationTags('DORA requires ICT risk management')).toContain('DORA');
  });

  it('extracts MaRisk from German text', () => {
    expect(extractRegulationTags('MaRisk AT 4.3.4 ist relevant')).toContain('MARISK');
  });

  it('extracts multiple regulations', () => {
    const tags = extractRegulationTags('DORA und MaRisk überschneiden sich bei BAIT');
    expect(tags).toContain('DORA');
    expect(tags).toContain('MARISK');
    expect(tags).toContain('BAIT');
  });

  it('extracts from citation IDs', () => {
    const tags = extractRegulationTags('Gemäss [R-DORA-001] ist dies erforderlich');
    expect(tags).toContain('DORA');
  });

  it('extracts EU AI Act variants', () => {
    const tags = extractRegulationTags('EU AI Act Artikel 6');
    expect(tags.some((t) => t.includes('EU'))).toBe(true);
  });

  it('extracts GDPR/DSGVO', () => {
    expect(extractRegulationTags('DSGVO Art. 5')).toContain('DSGVO');
    expect(extractRegulationTags('GDPR Article 5')).toContain('GDPR');
  });

  it('returns empty array for text without regulation mentions', () => {
    expect(extractRegulationTags('Today is a nice day')).toEqual([]);
  });

  it('returns sorted deduplicated tags', () => {
    const tags = extractRegulationTags('DORA DORA MaRisk');
    expect(tags).toEqual([...tags].sort());
    // No duplicates
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('extracts ISO references', () => {
    const tags = extractRegulationTags('ISO 27001 compliance');
    expect(tags.some((t) => t.startsWith('ISO'))).toBe(true);
  });

  it('extracts KWG, WpHG, CRR', () => {
    const tags = extractRegulationTags('KWG §25a und CRR Art. 286');
    expect(tags).toContain('KWG');
    expect(tags).toContain('CRR');
  });
});

// ───────────────────────── renderPriorKnowledgeBlock ─────────────────────────

function makeFact(overrides: Partial<MemoryFactLike> = {}): MemoryFactLike {
  return {
    id: 'fact-1',
    content: 'Test fact content',
    tags: ['DORA'],
    category: 'decision',
    status: 'active',
    importance: 3,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('renderPriorKnowledgeBlock', () => {
  it('returns null for empty facts', () => {
    expect(renderPriorKnowledgeBlock([])).toBeNull();
  });

  it('groups facts by category with German labels', () => {
    const block = renderPriorKnowledgeBlock([
      makeFact({ category: 'decision', content: 'Decision A' }),
      makeFact({ category: 'conclusion', content: 'Conclusion B', id: 'fact-2' }),
      makeFact({ category: 'open_task', content: 'Task C', id: 'fact-3' }),
    ]);
    expect(block).toContain('Frühere Entscheidungen');
    expect(block).toContain('Frühere Schlussfolgerungen');
    expect(block).toContain('Offene Aufgaben');
    expect(block).toContain('- Decision A');
    expect(block).toContain('- Conclusion B');
    expect(block).toContain('- Task C');
  });

  it('contains the subordination clause', () => {
    const block = renderPriorKnowledgeBlock([makeFact()]);
    expect(block).toContain('NACHRANGIG');
    expect(block).toContain('Wissensbasis (KB)');
    expect(block).toContain('Zitiere NIEMALS');
  });

  it('wraps in prior-knowledge tags', () => {
    const block = renderPriorKnowledgeBlock([makeFact()]);
    expect(block).toContain('<prior-knowledge scope="subordinate-to-kb">');
    expect(block).toContain('</prior-knowledge>');
  });

  it('only includes categories that have facts', () => {
    const block = renderPriorKnowledgeBlock([makeFact({ category: 'general', content: 'Only general' })]);
    expect(block).toContain('Weitere Fakten');
    expect(block).not.toContain('Frühere Entscheidungen');
    expect(block).not.toContain('Offene Aufgaben');
  });
});
