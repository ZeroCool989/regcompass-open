import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { KB } from '@/lib/kb';
import {
  buildGapFinding,
  NO_POLICY_EXCERPT,
  NO_POLICY_EVIDENCE,
  type GapFinding,
} from '../gap-finding';
import { selectExportFindings, isCoreDora, MIN_EXPORT, MAX_EXPORT } from '../export-selection';
import { fillExcelTemplate, REGISTER_SHEET_NAME } from '../parsers/excel-writer';
import { parseExcelToSheets } from '../parsers';

const CORE = [5, 6, 8, 11, 12, 13, 17, 18, 19, 28, 29, 30];
const artNum = (a: string) => {
  const m = a.match(/(\d+)/);
  return m ? Number(m[1]) : null;
};

const doraReqs = KB.requirements.filter((r) => r.regulation === 'DORA');
const coreByArticle = new Map<number, (typeof doraReqs)[number]>();
for (const r of doraReqs) {
  const n = artNum(r.article);
  if (n != null && CORE.includes(n) && !coreByArticle.has(n)) coreByArticle.set(n, r);
}
const coreReqs = [...coreByArticle.values()];
const nonCoreReq = doraReqs.find((r) => {
  const n = artNum(r.article);
  return n != null && !CORE.includes(n);
})!;

const mkReview = (req: (typeof doraReqs)[number]): GapFinding =>
  buildGapFinding({
    req,
    status: 'missing',
    confidence: 0.45,
    reason: 'Kein hinreichender Nachweis gefunden.',
    negativeEvidence: 'No relevant evidence found.',
    manualReview: true,
    id: `REVIEW-${req.id}`,
  });

const mkAuto = (req: (typeof doraReqs)[number]): GapFinding =>
  buildGapFinding({
    req,
    status: 'partial',
    confidence: 0.8,
    reason: 'Teilweise abgedeckt.',
    policyExcerpt: 'Die Policy erwähnt dieses Thema, ohne es vollständig zu regeln.',
    id: `AUTO-${req.id}`,
  });

describe('export selection (MVP tuning)', () => {
  it('has at least 8 distinct core DORA articles available in the KB', () => {
    expect(coreReqs.length).toBeGreaterThanOrEqual(8);
  });

  it('drops non-core DORA auto-export findings (demo noise like Art. 3/7/27/31)', () => {
    const sel = selectExportFindings([mkAuto(nonCoreReq)], []);
    expect(sel.exported).toHaveLength(0);
  });

  it('keeps core-DORA auto-export findings', () => {
    const sel = selectExportFindings([mkAuto(coreReqs[0])], []);
    expect(sel.exported).toHaveLength(1);
    expect(isCoreDora(sel.exported[0])).toBe(true);
  });

  it('every exported finding is a core DORA article', () => {
    const sel = selectExportFindings(coreReqs.map(mkAuto).concat(mkAuto(nonCoreReq)), coreReqs.map(mkReview));
    expect(sel.exported.length).toBeGreaterThan(0);
    for (const f of sel.exported) expect(isCoreDora(f)).toBe(true);
  });

  it('does NOT promote non-core (meta / authority) manual-review findings', () => {
    const sel = selectExportFindings([], [mkReview(nonCoreReq)]);
    expect(sel.exported).toHaveLength(0);
    expect(sel.remainingReview.some((f) => f.requirementId === nonCoreReq.id)).toBe(true);
    expect(isCoreDora(mkReview(nonCoreReq))).toBe(false);
  });

  it('promotes a core-DORA missing finding from manual review with absence-as-evidence', () => {
    const sel = selectExportFindings([], [mkReview(coreReqs[0])]);
    expect(sel.exported).toHaveLength(1);
    const f = sel.exported[0];
    expect(f.promoted).toBe(true);
    expect(f.manualReview).toBe(false);
    expect(f.policyExcerpt).toBe(NO_POLICY_EXCERPT);
    expect(f.evidence).toBe(NO_POLICY_EVIDENCE);
    expect(f.reason).toMatch(/Fehlen dieses Kontrollbereichs ist wesentlich/i);
  });

  it('lands the export count between 8 and 12 for a seeded-style policy', () => {
    // A few real partials + many absent core areas held for review.
    const auto = [mkAuto(nonCoreReq)];
    const review = coreReqs.map(mkReview);
    const sel = selectExportFindings(auto, review);
    expect(sel.exported.length).toBeGreaterThanOrEqual(MIN_EXPORT);
    expect(sel.exported.length).toBeLessThanOrEqual(MAX_EXPORT);
  });

  it('exports no duplicate topics (one slot per core article)', () => {
    // Same requirement twice → one export.
    const sel = selectExportFindings([], [mkReview(coreReqs[0]), mkReview(coreReqs[0])]);
    expect(sel.exported).toHaveLength(1);

    // Full set has unique topic keys.
    const full = selectExportFindings([], coreReqs.map(mkReview));
    const articles = full.exported.map((f) => f.article);
    expect(new Set(articles).size).toBe(articles.length);
  });

  it('never exceeds the cap even with many candidates', () => {
    const many = doraReqs.slice(0, 40).map(mkAuto);
    const sel = selectExportFindings(many, coreReqs.map(mkReview));
    expect(sel.exported.length).toBeLessThanOrEqual(MAX_EXPORT);
  });

  it('a promoted finding still populates the required Excel columns', async () => {
    const sel = selectExportFindings([], [mkReview(coreReqs[0])]);
    const finding = { ...sel.exported[0], id: 'GAP-001' };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Regulation', 'Article', 'Status']);
    ws.addRow(['X', 'Y', '']);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await fillExcelTemplate(buf, 'Sheet1', [finding]);
    const reg = (await parseExcelToSheets(result)).sheets.find((s) => s.name === REGISTER_SHEET_NAME)!;
    const row = reg.rows.find((r) => r['Befund-ID'] === 'GAP-001')!;
    expect(row).toBeDefined();
    expect(row['Policy-Auszug']).toBe(NO_POLICY_EXCERPT);
    expect(row['Nachweis / Quelle']).toContain(NO_POLICY_EVIDENCE);
    expect(row['Schweregrad'].length).toBeGreaterThan(0);
    expect(row['Empfehlung']).not.toMatch(/^implement controls?/i);
    expect(row['Empfehlung'].length).toBeGreaterThanOrEqual(25);
  });
});
