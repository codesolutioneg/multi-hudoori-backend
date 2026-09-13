import { describe, it, expect } from 'vitest';
import { isPayrollExcelSourceLocked } from '../../src/services/payroll.service';

describe('isPayrollExcelSourceLocked', () => {
  it('is false when excelImportedAt is null/undefined', () => {
    expect(isPayrollExcelSourceLocked({})).toBe(false);
    expect(isPayrollExcelSourceLocked({ excelImportedAt: null })).toBe(false);
  });

  it('is true after a payroll Excel import timestamp', () => {
    expect(isPayrollExcelSourceLocked({ excelImportedAt: new Date('2026-09-06T10:00:00Z') })).toBe(
      true,
    );
  });
});
