import { describe, expect, it, afterEach, vi } from 'vitest';
import ExcelJS from 'exceljs';

// The semantic pass (Haiku) is unit-tested in isolation with a mocked client
// (semantic-coverage.test.ts). Here it must not fire real model calls — the
// deterministic engine is what these tests exercise.
process.env.AEGIS_SEMANTIC_PASS = '0';
import { createToolRegistry } from '../tools';
import { executeSearchKb } from '../tools/search_kb';
import { executeGetRequirements } from '../tools/get_requirements';
import { executeGetCrosswalk } from '../tools/get_crosswalk';
import { executeReadSource } from '../tools/read_source';
import { executeAnalyzeDocument, type GapFinding } from '../tools/analyze_document';
import { executeFillTemplate } from '../tools/fill_template';
import { saveFindings, getSavedFindings } from '../findings-store';
import { assessApplicability } from '../coverage';
import { KB } from '@/lib/kb';

vi.mock('@/lib/db', async () => {
  const { fakeDb } = await import('./helpers/fake-db');
  return { db: fakeDb };
});

import { fakeDb } from './helpers/fake-db';
import { storeDocument } from '../document-store';

const SESSION = 'test-session';
const CTX = { sessionId: SESSION };

async function makeTestExcel(
  sheets: Record<string, Record<string, string>[]>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    if (rows.length > 0) {
      const headers = Object.keys(rows[0]);
      ws.addRow(headers);
      for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? ''));
    }
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

// ───────────────────────── search_kb ─────────────────────────

describe('executeSearchKb', () => {
  it('returns at least one result for an exact ID query', () => {
    const out = executeSearchKb({ query: 'R-AIACT-005', limit: 5 });
    expect(out.length).toBeGreaterThan(0);
    // ID-match should be ranked first.
    expect(out[0].id).toBe('R-AIACT-005');
  });

  it('strips the verbose `body` field from results', () => {
    const out = executeSearchKb({ query: 'R-AIACT-005', limit: 5 });
    expect(out.length).toBeGreaterThan(0);
    // `body` exists on the source Requirement type but must be omitted in tool results.
    expect((out[0] as { body?: string }).body).toBeUndefined();
  });

  it('respects the `regulation` filter', () => {
    const out = executeSearchKb({ query: 'risk', regulation: 'DORA', limit: 10 });
    for (const r of out) expect(r.regulation).toBe('DORA');
  });

  it('respects the `jurisdiction` filter', () => {
    const out = executeSearchKb({ query: 'risk', jurisdiction: 'CH', limit: 10 });
    for (const r of out) expect(r.jurisdiction).toContain('CH');
  });

  it('respects the `bindingLevel` filter', () => {
    const out = executeSearchKb({
      query: 'data',
      bindingLevel: 'mandatory',
      limit: 10,
    });
    for (const r of out) expect(r.bindingLevel).toBe('mandatory');
  });

  it('caps the result at `limit`', () => {
    const out = executeSearchKb({ query: 'a', limit: 3 });
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('caps limit at 10 even if a higher value is passed', () => {
    const out = executeSearchKb({ query: 'a', limit: 100 });
    expect(out.length).toBeLessThanOrEqual(10);
  });

  it('returns an empty array when no requirement matches', () => {
    const out = executeSearchKb({
      query: 'this-query-string-does-not-exist-in-kb-zzzz',
    });
    expect(out).toEqual([]);
  });

  // ── Cross-language retrieval (DE↔EN synonyms) ──

  it('finds R-GDPR-005 for "Art. 5 DSGVO" via synonym mapping', () => {
    const out = executeSearchKb({ query: 'Art. 5 DSGVO', limit: 5 });
    const ids = out.map((r) => r.id);
    expect(ids[0]).toBe('R-GDPR-005');
  });

  it('finds GDPR entries for the German term "DSGVO"', () => {
    const out = executeSearchKb({ query: 'DSGVO', limit: 5 });
    const gdprIds = out.filter((r) => r.regulation === 'GDPR');
    expect(gdprIds.length).toBeGreaterThanOrEqual(3);
  });

  it('finds R-GDPR-005 for the German term "Grundsätze" via synonym', () => {
    const out = executeSearchKb({ query: 'Grundsätze', limit: 5 });
    const ids = out.map((r) => r.id);
    expect(ids).toContain('R-GDPR-005');
  });

  it('finds R-GDPR-022 for "automatisierte Entscheidung"', () => {
    const out = executeSearchKb({
      query: 'automatisierte Entscheidung',
      limit: 5,
    });
    const ids = out.map((r) => r.id);
    expect(ids[0]).toBe('R-GDPR-022');
  });

  it('finds FINMA entries for "FINMA KI Governance"', () => {
    const out = executeSearchKb({
      query: 'FINMA KI Governance',
      limit: 5,
    });
    const finmaCount = out.filter((r) => r.regulation.startsWith('FINMA')).length;
    expect(finmaCount).toBeGreaterThanOrEqual(2);
  });

  it('finds EU AI Act entries for "KI-Verordnung"', () => {
    const out = executeSearchKb({ query: 'KI-Verordnung', limit: 5 });
    const aiActCount = out.filter((r) => r.regulation === 'EU_AI_ACT').length;
    expect(aiActCount).toBeGreaterThanOrEqual(3);
  });

  it('matches the regulation field when underscored (FINMA in FINMA_08_2024)', () => {
    const out = executeSearchKb({ query: 'FINMA', limit: 5 });
    const finmaCount = out.filter((r) => r.regulation.startsWith('FINMA')).length;
    expect(finmaCount).toBeGreaterThanOrEqual(3);
  });
});

// ───────────────────────── get_crosswalk ─────────────────────────

describe('executeGetRequirements', () => {
  it('returns FULL records (with body) for known IDs in one call', () => {
    const out = executeGetRequirements({ ids: ['R-AIACT-001'] });
    expect(out.requirements).toHaveLength(1);
    expect(out.requirements[0].id).toBe('R-AIACT-001');
    expect(typeof out.requirements[0].body).toBe('string');
    expect(out.requirements[0].body.length).toBeGreaterThan(0);
    expect(out.notFound).toEqual([]);
  });

  it('reports unknown IDs in notFound without failing', () => {
    const out = executeGetRequirements({ ids: ['R-AIACT-001', 'R-NOPE-999'] });
    expect(out.requirements.map((r) => r.id)).toEqual(['R-AIACT-001']);
    expect(out.notFound).toEqual(['R-NOPE-999']);
  });

  it('dedupes repeated IDs (one record each)', () => {
    const out = executeGetRequirements({ ids: ['R-AIACT-001', 'R-AIACT-001'] });
    expect(out.requirements).toHaveLength(1);
  });

  it('caps at 20 IDs', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `R-FAKE-${i}`);
    const out = executeGetRequirements({ ids });
    expect(out.requirements.length + out.notFound.length).toBe(20);
  });

  it('tolerates a missing/!array ids field', () => {
    expect(executeGetRequirements({}).requirements).toEqual([]);
    expect(executeGetRequirements({ ids: 'R-AIACT-001' }).requirements).toEqual([]);
  });

  it('is reachable through the registry as a non-error JSON payload', async () => {
    const reg = createToolRegistry();
    const result = await reg.execute({
      id: 'call_gr',
      name: 'get_requirements',
      input: { ids: ['R-AIACT-001'] },
    });
    expect(result.is_error).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.requirements[0].id).toBe('R-AIACT-001');
  });
});

describe('executeGetCrosswalk', () => {
  it('returns all entries when no filter is given', () => {
    const out = executeGetCrosswalk({});
    expect(out.length).toBe(KB.crosswalk.length);
  });

  it('filters by topic substring (case-insensitive)', () => {
    const out = executeGetCrosswalk({ topic: 'risk' });
    expect(out.length).toBeGreaterThan(0);
    for (const e of out) {
      expect(e.topic.toLowerCase()).toContain('risk');
    }
  });

  it('filters by requirementId', () => {
    const out = executeGetCrosswalk({ requirementId: 'R-AIACT-009' });
    expect(out.length).toBeGreaterThan(0);
    for (const e of out) expect(e.requirements).toContain('R-AIACT-009');
  });

  it('returns empty array for unmatched topic', () => {
    expect(executeGetCrosswalk({ topic: 'no-such-topic-zzzz' })).toEqual([]);
  });
});

// ───────────────────────── read_source ─────────────────────────

describe('executeReadSource', () => {
  it('returns ranked passages for a known regulation and query', () => {
    const out = executeReadSource({
      regulation: 'GDPR',
      query: 'Rechtmäßigkeit der Verarbeitung',
      maxPassages: 5,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].source).toBe('raw_legislation');
    expect(out[0].verified).toBe(false);
    expect(out[0].file).toBe('eu_GDPR_act_DE.txt');
    expect(out[0].regulation).toBe('GDPR');
    expect(out[0].score).toBeGreaterThan(0);
  });

  it('passages are sorted by descending score', () => {
    const out = executeReadSource({
      regulation: 'GDPR',
      query: 'personenbezogene Daten Einwilligung',
      maxPassages: 5,
    });
    for (let i = 1; i < out.length; i++) {
      expect(out[i].score).toBeLessThanOrEqual(out[i - 1].score);
    }
  });

  it('caps results at maxPassages', () => {
    const out = executeReadSource({
      regulation: 'GDPR',
      query: 'Daten',
      maxPassages: 2,
    });
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it('caps results at the hard limit of 5 even when maxPassages is higher', () => {
    const out = executeReadSource({
      regulation: 'GDPR',
      query: 'Daten',
      maxPassages: 100,
    });
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('no passage exceeds ~2000 characters (≈500 tokens)', () => {
    const out = executeReadSource({
      regulation: 'GDPR',
      query: 'Daten',
      maxPassages: 5,
    });
    for (const p of out) {
      // 2001 is the truncation length (2000 + ellipsis char).
      expect(p.passage.length).toBeLessThanOrEqual(2001);
    }
  });

  it('returns empty array when the query has no useful tokens', () => {
    const out = executeReadSource({
      regulation: 'GDPR',
      query: '...',
    });
    expect(out).toEqual([]);
  });

  it('throws source_access_denied for a regulation with no source file', () => {
    // ISO_23894 has no source text in the bundled KB, so it does not resolve.
    expect(() =>
      executeReadSource({
        regulation: 'ISO_23894',
        query: 'risk',
      }),
    ).toThrow(/source_access_denied/);
  });

  it('throws source_access_denied for path traversal attempts', () => {
    // A regulation the loaded KB does not map to a source file is rejected
    // before any path resolution — no unmapped filename can reach the fs.
    expect(() =>
      executeReadSource({
        regulation: '../../../etc/passwd',
        query: 'anything',
      }),
    ).toThrow(/source_access_denied/);
  });

  it('finds AT 4.3.5 / model risk passages in MaRisk source', () => {
    const out = executeReadSource({
      regulation: 'MARISK',
      query: 'Verwendung von Modellen künstliche Intelligenz',
      maxPassages: 3,
    });
    expect(out.length).toBeGreaterThan(0);
    // At least one passage should mention models or AI explicitly.
    expect(
      out.some(
        (p) =>
          p.passage.toLowerCase().includes('modell') ||
          p.passage.toLowerCase().includes('künstlich'),
      ),
    ).toBe(true);
  });
});

// ───────────────────────── Registry + stub tools ─────────────────────────

describe('createToolRegistry', () => {
  it('exposes all 12 tools by default', () => {
    const reg = createToolRegistry();
    const names = reg.schemas.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_kb',
        'get_requirements',
        'get_crosswalk',
        'generate_report',
        'analyze_document',
        'fill_template',
        'read_source',
        'search_ingested_documents',
        'generate_assessment_deck',
        'export_assessment',
        'improve_uploaded_deck',
        'improve_document',
      ]),
    );
    expect(reg.schemas).toHaveLength(12);
  });

  it('subset only exposes the requested tools', () => {
    const reg = createToolRegistry(['search_kb', 'get_crosswalk']);
    expect(reg.schemas).toHaveLength(2);
    expect(reg.schemas.map((s) => s.name).sort()).toEqual([
      'get_crosswalk',
      'search_kb',
    ]);
  });

  it('executes search_kb and returns a JSON string payload', async () => {
    const reg = createToolRegistry();
    const result = await reg.execute({
      id: 'call_1',
      name: 'search_kb',
      input: { query: 'R-AIACT-005' },
    });
    expect(result.tool_use_id).toBe('call_1');
    expect(result.is_error).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('generate_report returns is_error: true (Phase 4 placeholder)', async () => {
    const reg = createToolRegistry();
    const result = await reg.execute({
      id: 'call_x',
      name: 'generate_report',
      input: {},
    });
    expect(result.is_error).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe('not_implemented');
    expect(parsed.phase).toBe(4);
  });

  it('analyze_document returns is_error: true when documentId is missing', async () => {
    const reg = createToolRegistry();
    const result = await reg.execute({
      id: 'call_y',
      name: 'analyze_document',
      input: {},
    });
    expect(result.is_error).toBe(true);
  });

  it('wraps a thrown executor error as a tool_result with is_error: true', async () => {
    const reg = createToolRegistry();
    const result = await reg.execute({
      id: 'call_z',
      name: 'analyze_document',
      input: { documentId: 'nonexistent-id' },
    });
    expect(result.is_error).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe('error');
    expect(parsed.tool).toBe('analyze_document');
  });
});

// ───────────────────────── analyze_document ─────────────────────────

describe('executeAnalyzeDocument', () => {
  afterEach(() => fakeDb.reset());

  it('analyses a mock policy and returns only exportable (partial/missing) findings', async () => {
    const docId = await storeDocument(
      {
        filename: 'policy.txt',
        type: 'policy',
        textContent:
          'This policy covers ICT risk management framework in accordance with DORA Art. 5. ' +
          'We implement data governance measures per GDPR Art. 5 principles. ' +
          'Automated decision-making is subject to human oversight.',
      },
      SESSION,
    );

    const result = await executeAnalyzeDocument({ documentId: docId }, CTX);
    expect(result.documentId).toBe(docId);
    // Exported findings are never covered/not_applicable and carry a reason;
    // they are either above-threshold or promoted core-DORA absences.
    expect(result.summary.exported).toBe(result.findings.length);
    for (const f of result.findings) {
      expect(['partial', 'missing']).toContain(f.status);
      expect(f.reason.length).toBeGreaterThan(0);
      expect(f.confidence >= 0.7 || f.promoted === true).toBe(true);
    }
    // Capped, and far fewer than the total requirements scanned (no flood).
    expect(result.findings.length).toBeLessThanOrEqual(12);
    expect(result.findings.length).toBeLessThan(result.totalRequirementsChecked / 2);
  });

  it('filters by targetRegulation when provided', async () => {
    const docId = await storeDocument(
      {
        filename: 'dora-policy.txt',
        type: 'policy',
        textContent: 'DORA compliance: ICT risk management, incident reporting, resilience testing.',
      },
      SESSION,
    );

    const result = await executeAnalyzeDocument(
      { documentId: docId, targetRegulation: 'DORA' },
      CTX,
    );
    for (const f of [...result.findings, ...result.reviewFindings]) {
      expect(f.regulation).toBe('DORA');
    }
  });

  it('suppresses covered requirements from the export', async () => {
    // Choose an applicable DORA requirement and write a policy that fully covers
    // it (title + all concept tags present ⇒ high ratio ⇒ covered).
    const req = KB.requirements.find(
      (r) =>
        r.regulation === 'DORA' &&
        assessApplicability(r).applicable &&
        r.tags.length >= 3 &&
        (r.titleDe ?? r.title).length > 0,
    )!;
    const title = req.titleDe ?? req.title;
    const text = `Abschnitt 1.\n${title}. ${req.tags.join('. ')}.\n`.repeat(3);

    const docId = await storeDocument({ filename: 'covered.txt', type: 'policy', textContent: text }, SESSION);
    const result = await executeAnalyzeDocument({ documentId: docId, targetRegulation: 'DORA' }, CTX);

    expect(result.findings.find((f) => f.requirementId === req.id)).toBeUndefined();
    expect(result.reviewFindings.find((f) => f.requirementId === req.id)).toBeUndefined();
    expect(result.summary.covered).toBeGreaterThanOrEqual(1);
  });

  it('rejects documents without analyzable text instead of fabricating findings (DOC-1)', async () => {
    // A scanned/image-only PDF parses without error but yields (near-)zero
    // text. Analysis must fail fast with a German message — never produce a
    // gap report about a document it could not read.
    const docId = await storeDocument(
      { filename: 'scan.pdf', type: 'policy', textContent: '  \n \t  ' },
      SESSION,
    );
    await expect(executeAnalyzeDocument({ documentId: docId }, CTX)).rejects.toThrow(
      /keinen auswertbaren Text.*gescanntes/,
    );
  });

  it('produces far fewer findings than requirements — no per-article flood', async () => {
    // A short, focused DORA policy mentioning a few topics. The old engine added
    // up to 50 "missing" rows here; the new one suppresses non-evidenced ones.
    const text =
      'Abschnitt 3. Das Unternehmen betreibt ein ICT-Risikomanagement und überwacht seine Systeme. ' +
      'Vorfälle werden erfasst. Backups werden regelmässig erstellt.';
    const docId = await storeDocument({ filename: 'short.txt', type: 'policy', textContent: text }, SESSION);
    const result = await executeAnalyzeDocument({ documentId: docId, targetRegulation: 'DORA' }, CTX);

    const doraCount = KB.requirements.filter((r) => r.regulation === 'DORA').length;
    expect(result.findings.length).toBeLessThan(doraCount / 2);
    expect(result.findings.length).toBeLessThanOrEqual(12); // capped
    for (const f of result.findings) {
      expect(['partial', 'missing']).toContain(f.status);
      expect(f.reason.length).toBeGreaterThan(0);
      expect(f.confidence >= 0.7 || f.promoted === true).toBe(true);
    }
  });

  it('with a very high threshold, exported findings are only promoted core-DORA absences', async () => {
    vi.stubEnv('AEGIS_GAP_CONFIDENCE_THRESHOLD', '0.99');
    const text =
      'Abschnitt 2. Das Unternehmen betreibt ein ICT-Risikomanagement und führt Backups durch.';
    const docId = await storeDocument({ filename: 'review.txt', type: 'policy', textContent: text }, SESSION);
    const result = await executeAnalyzeDocument({ documentId: docId, targetRegulation: 'DORA' }, CTX);

    // Nothing can clear 0.99 on merit → any export is a promoted core finding.
    for (const f of result.findings) expect(f.promoted).toBe(true);
    for (const f of result.reviewFindings) expect(f.manualReview).toBe(true);
    expect(result.findings.length).toBeLessThanOrEqual(12);
    vi.unstubAllEnvs();
  });

  it('throws for missing document ID', async () => {
    await expect(
      executeAnalyzeDocument({ documentId: 'nonexistent' }, CTX),
    ).rejects.toThrow('not found');
  });

  it('cannot read documents from another session', async () => {
    const docId = await storeDocument(
      { filename: 'p.txt', type: 'policy', textContent: 'DORA ICT risk.' },
      SESSION,
    );
    await expect(
      executeAnalyzeDocument({ documentId: docId }, { sessionId: 'other-session' }),
    ).rejects.toThrow('not found');
  });
});

// ───────────────────────── fill_template ─────────────────────────

describe('executeFillTemplate', () => {
  afterEach(() => fakeDb.reset());

  it('fills an Excel template with analysis results', async () => {
    const policyId = await storeDocument(
      {
        filename: 'policy.txt',
        type: 'policy',
        textContent:
          'Our organization implements comprehensive ICT risk management per DORA requirements. ' +
          'Data governance follows GDPR Art. 5 principles including purpose limitation.',
      },
      SESSION,
    );

    const excelBuffer = await makeTestExcel({
      Assessment: [
        { Regulation: 'DORA', Artikel: 'Art. 5', Anforderung: 'ICT Risk', Status: '', Priorität: '' },
      ],
    });

    const templateId = await storeDocument(
      {
        filename: 'template.xlsx',
        type: 'template',
        textContent: 'Assessment sheet',
        excelBuffer,
      },
      SESSION,
    );

    const result = await executeFillTemplate(
      {
        policyDocumentId: policyId,
        templateDocumentId: templateId,
        targetSheet: 'Assessment',
      },
      CTX,
    );

    expect(result.downloadId).toBeDefined();
    expect(result.summary.total).toBeGreaterThan(0);
  });

  it('throws when policy document is not found', async () => {
    const templateId = await storeDocument(
      {
        filename: 'template.xlsx',
        type: 'template',
        textContent: '',
        excelBuffer: await makeTestExcel({ Sheet1: [{ A: '1' }] }),
      },
      SESSION,
    );
    await expect(
      executeFillTemplate(
        {
          policyDocumentId: 'missing',
          templateDocumentId: templateId,
          targetSheet: 'Sheet1',
        },
        CTX,
      ),
    ).rejects.toThrow('not found');
  });

  it('throws without a session', async () => {
    await expect(
      executeFillTemplate(
        {
          policyDocumentId: 'a',
          templateDocumentId: 'b',
          targetSheet: 'Sheet1',
        },
        { sessionId: null },
      ),
    ).rejects.toThrow('session');
  });
});

// ──────────────── two-step split: findings cache + reuse ────────────────

describe('findings-store (GAP_ANALYZE → fill_template split)', () => {
  afterEach(() => fakeDb.reset());

  const sampleFindings: GapFinding[] = [
    {
      id: 'GAP-001',
      requirementId: 'R-DORA-001',
      regulation: 'DORA',
      article: 'Art. 5',
      requirementTitle: 'ICT risk management',
      requirementArea: 'Risikomanagement',
      policySection: 'Abschnitt 4',
      policyExcerpt: 'Die Bank betreibt ein ICT-Risikomanagement.',
      status: 'missing',
      gapDescription: 'Das Dokument adressiert ein definiertes ICT-Risikomanagement nicht.',
      riskImpact: 'Ohne Rahmenwerk kann operationelle Resilienz nicht nachgewiesen werden.',
      severity: 'High',
      recommendation:
        'ICT-Risikomanagement-Rahmenwerk etablieren, formal verankern und jährlich überprüfen gemäss DORA Art. 5.',
      evidence: 'Kein Nachweis im Dokument für R-DORA-001.',
      citations: ['R-DORA-001', 'DORA Art. 5'],
      confidence: 0.5,
      reason: 'Kein hinreichender Nachweis im Dokument gefunden.',
    },
  ];

  it('saveFindings / getSavedFindings round-trips and is session + document scoped', async () => {
    await saveFindings(SESSION, 'pol-1', sampleFindings);
    expect(await getSavedFindings(SESSION, 'pol-1')).toEqual(sampleFindings);
    // Wrong session or wrong policy id → no leak.
    expect(await getSavedFindings('other-session', 'pol-1')).toBeNull();
    expect(await getSavedFindings(SESSION, 'pol-2')).toBeNull();
  });

  it('saveFindings overwrites a prior cache for the same policy (no duplicates)', async () => {
    await saveFindings(SESSION, 'pol-1', sampleFindings);
    await saveFindings(SESSION, 'pol-1', []);
    expect(await getSavedFindings(SESSION, 'pol-1')).toEqual([]);
  });

  it('analyze_document persists its findings for later reuse', async () => {
    const docId = await storeDocument(
      {
        filename: 'policy.txt',
        type: 'policy',
        textContent:
          'ICT risk management framework per DORA Art. 5. Data governance per GDPR Art. 5.',
      },
      SESSION,
    );
    const result = await executeAnalyzeDocument({ documentId: docId }, CTX);
    const saved = await getSavedFindings(SESSION, docId);
    expect(saved).not.toBeNull();
    expect(saved!.length).toBe(result.findings.length);
  });

  it('fill_template reuses saved findings instead of re-analyzing the document', async () => {
    // Policy text is deliberately empty-ish: a fresh analysis would NOT yield the
    // seeded finding, so a matching result proves the saved cache was used.
    const policyId = await storeDocument(
      { filename: 'policy.txt', type: 'policy', textContent: 'irrelevant placeholder text' },
      SESSION,
    );
    await saveFindings(SESSION, policyId, sampleFindings);

    const templateId = await storeDocument(
      {
        filename: 'template.xlsx',
        type: 'template',
        textContent: '',
        excelBuffer: await makeTestExcel({
          Assessment: [{ Regulation: 'DORA', Artikel: 'Art. 5', Status: '', Priorität: '' }],
        }),
      },
      SESSION,
    );

    const result = await executeFillTemplate(
      { policyDocumentId: policyId, templateDocumentId: templateId, targetSheet: 'Assessment' },
      CTX,
    );
    // Exactly the one seeded finding drove the fill — not a fresh KB analysis.
    expect(result.summary.total).toBe(sampleFindings.length);
    expect(result.summary.added).toBe(1); // the single 'missing' finding
  });

  it('fill_template falls back to a fresh analysis when no findings are cached', async () => {
    const policyId = await storeDocument(
      {
        filename: 'policy.txt',
        type: 'policy',
        textContent:
          'Comprehensive ICT risk management per DORA. Data governance follows GDPR Art. 5.',
      },
      SESSION,
    );
    const templateId = await storeDocument(
      {
        filename: 'template.xlsx',
        type: 'template',
        textContent: '',
        excelBuffer: await makeTestExcel({
          Assessment: [{ Regulation: 'DORA', Artikel: 'Art. 5', Status: '', Priorität: '' }],
        }),
      },
      SESSION,
    );

    // No saveFindings beforehand → fill must analyze on the fly.
    const result = await executeFillTemplate(
      { policyDocumentId: policyId, templateDocumentId: templateId, targetSheet: 'Assessment' },
      CTX,
    );
    expect(result.summary.total).toBeGreaterThan(0);
    // The fallback analysis also populated the cache as a side effect.
    expect(await getSavedFindings(SESSION, policyId)).not.toBeNull();
  });
});
