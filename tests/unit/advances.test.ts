import { describe, it, expect } from 'vitest';
import {
  advancePeriodStart,
  isPayrollEligibleForDeductionStart,
  shortAdvanceDateInPayrollPeriod,
} from '../../src/services/advances.service';

describe('advances.service Odoo parity', () => {
  it('advancePeriodStart returns first day of month UTC', () => {
    const start = advancePeriodStart(new Date('2026-05-15T12:00:00Z'));
    expect(start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('shortAdvanceDateInPayrollPeriod accepts dates within payroll month', () => {
    const dateTo = new Date('2026-05-31T00:00:00Z');
    expect(shortAdvanceDateInPayrollPeriod(new Date('2026-05-01T00:00:00Z'), dateTo)).toBe(true);
    expect(shortAdvanceDateInPayrollPeriod(new Date('2026-05-31T00:00:00Z'), dateTo)).toBe(true);
    expect(shortAdvanceDateInPayrollPeriod(new Date('2026-04-30T00:00:00Z'), dateTo)).toBe(false);
    expect(shortAdvanceDateInPayrollPeriod(new Date('2026-06-01T00:00:00Z'), dateTo)).toBe(false);
  });

  it('isPayrollEligibleForDeductionStart compares months not deductionStartDate day gate for linking', () => {
    const payrollTo = new Date('2026-05-31T00:00:00Z');
    expect(isPayrollEligibleForDeductionStart(payrollTo, new Date('2026-05-20T00:00:00Z'))).toBe(true);
    expect(isPayrollEligibleForDeductionStart(payrollTo, new Date('2026-06-01T00:00:00Z'))).toBe(false);
  });
});
