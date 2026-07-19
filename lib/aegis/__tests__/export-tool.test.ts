import { describe, expect, it, vi } from 'vitest';

const { exportImpl } = vi.hoisted(() => ({ exportImpl: vi.fn() }));
vi.mock('../export', () => ({
  exportAssessment: exportImpl,
  EXPORT_FORMATS: ['xlsx', 'docx', 'pdf'],
}));

import { executeExportAssessment, EXPORT_ASSESSMENT_SCHEMA } from '../tools/export_assessment';
import { createToolRegistry, ALL_TOOL_NAMES } from '../tools';
import { getModeSpec } from '../modes';

describe('export_assessment tool', () => {
  it('is registered in the registry, every mode subset, and the schema list', () => {
    expect(ALL_TOOL_NAMES).toContain('export_assessment');
    const registry = createToolRegistry();
    expect(registry.schemas.map((s) => s.name)).toContain('export_assessment');
    for (const mode of ['ASSESS', 'GAP_ANALYZE', 'CONVERSATIONAL'] as const) {
      expect(getModeSpec(mode, 'de').defaultTools, mode).toContain('export_assessment');
    }
    expect(EXPORT_ASSESSMENT_SCHEMA.input_schema.required).toEqual(['format']);
  });

  it('rejects an invalid format with a German error before touching the engine', async () => {
    await expect(executeExportAssessment({ format: 'exe' }, { sessionId: 's' })).rejects.toThrow(
      /Ungültiges Format/,
    );
    expect(exportImpl).not.toHaveBeenCalled();
  });

  it('passes through to the engine with the tool context', async () => {
    exportImpl.mockResolvedValueOnce({ downloadId: 'd1', filename: 'f.xlsx' });
    const ctx = { sessionId: 's1', userId: 'u1', conversationId: 'c1' };
    const result = await executeExportAssessment({ format: 'docx', regulations: ['DORA'] }, ctx);
    expect(result).toEqual({ downloadId: 'd1', filename: 'f.xlsx' });
    expect(exportImpl).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'docx', regulations: ['DORA'] }),
      ctx,
    );
  });
});
