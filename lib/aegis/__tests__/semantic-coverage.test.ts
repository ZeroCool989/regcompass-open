import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KB } from '@/lib/kb';
import { chunkText, quoteOccursIn, runSemanticPass } from '../semantic-coverage';
import { callStructured } from '../client';
import type { Coverage } from '../coverage';

vi.mock('../client', () => ({
  callStructured: vi.fn(),
}));

const mockCall = vi.mocked(callStructured);

const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function det(status: Coverage['status'], confidence: number): Coverage {
  return { status, confidence, reason: 'det' };
}

const REQS = KB.requirements.filter((r) => r.regulation === 'DORA').slice(0, 3);

describe('semantic coverage pass', () => {
  beforeEach(() => {
    mockCall.mockReset();
    delete process.env.AEGIS_SEMANTIC_PASS;
    delete process.env.AEGIS_SEMANTIC_MAX_REQS;
  });

  it('chunkText covers the whole text with overlap', () => {
    const text = 'x'.repeat(30_000);
    const chunks = chunkText(text, 12_000, 600);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBeGreaterThanOrEqual(text.length);
  });

  it('quote firewall: verbatim quotes pass, fabricated ones fail', () => {
    const policy = 'Die Meldung  an die Behörde erfolgt spätestens nach   72 Stunden.';
    expect(quoteOccursIn('Meldung an die Behörde erfolgt spätestens nach 72 Stunden', policy)).toBe(true);
    expect(quoteOccursIn('Die Meldung erfolgt innerhalb von 24 Stunden', policy)).toBe(false);
    expect(quoteOccursIn('kurz', policy)).toBe(false); // too short to count as evidence
  });

  it('void verdicts whose quote is not in the policy; keep verified ones', async () => {
    const policy = `Richtlinie. ${REQS[0].titleDe ?? REQS[0].title} wird quartalsweise geprüft und dokumentiert im Kontrollrahmen.`;
    mockCall.mockResolvedValueOnce({
      value: {
        verdicts: [
          {
            requirementId: REQS[0].id,
            verdict: 'partial',
            quote: 'wird quartalsweise geprüft und dokumentiert im Kontrollrahmen',
            note: 'Nur Prüfturnus geregelt.',
          },
          {
            requirementId: REQS[1].id,
            verdict: 'covered',
            quote: 'Dieser Satz steht nicht im Dokument, Ehrenwort.',
            note: 'Erfundenes Zitat.',
          },
        ],
      },
      usage: USAGE,
    } as never);

    const res = await runSemanticPass({
      policyText: policy,
      candidates: REQS.map((req) => ({ req, det: det('missing', 0.5) })),
    });

    expect(res.verdicts.get(REQS[0].id)?.verdict).toBe('partial');
    expect(res.verdicts.has(REQS[1].id)).toBe(false); // fabricated quote voided
    expect(res.quotesRejected).toBe(1);
    expect(res.calls).toBe(1);
  });

  it('drops verdicts for requirements that were never asked', async () => {
    mockCall.mockResolvedValueOnce({
      value: {
        verdicts: [
          { requirementId: 'R-GDPR-001', verdict: 'missing', quote: '', note: 'nicht gefragt' },
          { requirementId: REQS[0].id, verdict: 'missing', quote: '', note: 'ok' },
        ],
      },
      usage: USAGE,
    } as never);

    const res = await runSemanticPass({
      policyText: 'Kurzes Dokument ohne Substanz, aber lang genug für die Analyse.',
      candidates: [{ req: REQS[0], det: det('missing', 0.5) }],
    });
    expect(res.verdicts.has('R-GDPR-001')).toBe(false);
    expect(res.verdicts.get(REQS[0].id)?.verdict).toBe('missing');
  });

  it('a model failure never fails the pass — deterministic results stand', async () => {
    mockCall.mockRejectedValueOnce(new Error('upstream broke'));
    const res = await runSemanticPass({
      policyText: 'Text.',
      candidates: [{ req: REQS[0], det: det('missing', 0.5) }],
    });
    expect(res.verdicts.size).toBe(0);
    expect(res.calls).toBe(0);
  });

  it('is disabled via env and respects the candidate cap', async () => {
    process.env.AEGIS_SEMANTIC_PASS = '0';
    const off = await runSemanticPass({
      policyText: 'Text.',
      candidates: [{ req: REQS[0], det: det('missing', 0.5) }],
    });
    expect(off.candidates).toBe(0);
    expect(mockCall).not.toHaveBeenCalled();

    delete process.env.AEGIS_SEMANTIC_PASS;
    process.env.AEGIS_SEMANTIC_MAX_REQS = '1';
    mockCall.mockResolvedValueOnce({ value: { verdicts: [] }, usage: USAGE } as never);
    const capped = await runSemanticPass({
      policyText: 'Text.',
      candidates: REQS.map((req) => ({ req, det: det('missing', 0.5) })),
    });
    expect(capped.candidates).toBe(1);
  });

  it('confident deterministic verdicts are not re-examined (cost bound)', async () => {
    const res = await runSemanticPass({
      policyText: 'Text.',
      candidates: [{ req: REQS[0], det: det('missing', 0.95) }],
    });
    expect(res.candidates).toBe(0);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('reports usage to the cost hook', async () => {
    const onUsage = vi.fn();
    mockCall.mockResolvedValueOnce({ value: { verdicts: [] }, usage: USAGE } as never);
    await runSemanticPass({
      policyText: 'Text.',
      candidates: [{ req: REQS[0], det: det('missing', 0.5) }],
      onUsage,
    });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][1]).toEqual(USAGE);
  });
});
