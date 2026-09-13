import { describe, it, expect } from 'vitest';
import { capDiffPreview, shallowFieldDiffs } from '../../src/services/auditLog.service';

describe('auditLog helpers', () => {
  it('caps diff preview to 50 rows and truncates long strings', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      entityId: `e$i`,
      field: 'name',
      before: 'a'.repeat(600),
      after: `v$i`,
    }));
    const capped = capDiffPreview(rows);
    expect(capped).toHaveLength(50);
    expect(String(capped[0].before).endsWith('…')).toBe(true);
  });

  it('builds shallow field diffs for changed keys only', () => {
    const diffs = shallowFieldDiffs(
      { name: 'Ali', code: '1', active: true },
      { name: 'Ali Updated', code: '1', active: false },
      { entityId: 'x', entityLabel: 'Ali' },
    );
    expect(diffs.map((d) => d.field).sort()).toEqual(['active', 'name']);
    expect(diffs.find((d) => d.field === 'name')?.after).toBe('Ali Updated');
  });
});
