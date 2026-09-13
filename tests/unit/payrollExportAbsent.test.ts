import { describe, it, expect } from 'vitest';
import {
  exportedAbsentCount,
  exportedAbsentDeduction,
} from '../../src/services/payrollExport.service';

describe('payroll export absent fields', () => {
  it('prefers absentCount including zero over stale absentDays', () => {
    expect(exportedAbsentCount({ absentCount: 0, absentDays: 2 })).toBe(0);
    expect(exportedAbsentCount({ absentCount: 3, absentDays: 1 })).toBe(3);
    expect(exportedAbsentCount({ absentCount: null as unknown as number, absentDays: 2 })).toBe(2);
  });

  it('uses stored absentDeduction for manual lines', () => {
    expect(
      exportedAbsentDeduction(
        { absentDeduction: 250, absentCount: 3, absentDays: 1, isManual: true },
        100,
      ),
    ).toBe(250);
  });

  it('derives absent deduction from count when not manual', () => {
    expect(
      exportedAbsentDeduction(
        { absentDeduction: 0, absentCount: 2, absentDays: 1, isManual: false },
        100,
      ),
    ).toBe(200);
  });
});
