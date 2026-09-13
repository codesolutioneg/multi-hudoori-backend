import { describe, it, expect } from 'vitest';
import type { PayrollLine } from '@prisma/client';
import { recalculatePayrollLineTotals } from '../../src/services/payrollLine.service';

function line(overrides: Partial<PayrollLine> = {}): PayrollLine {
  return {
    id: 'line1',
    payrollId: 'pay1',
    employeeId: 'emp1',
    sequence: 1,
    employeeCode: '100',
    basicSalary: 3000,
    workingDays: 30,
    workDaysSalary: 3000,
    overtimeHours: 0,
    overtimeAmount: 0,
    lateDeduction: 0,
    lateCheckoutDeduction: 0,
    earlyDeduction: 0,
    punchDeductionCheckin: 0,
    punchDeductionCheckout: 0,
    absentDeduction: 0,
    sickDeduction: 0,
    adminDeduction: 0,
    socialInsurance: 0,
    medicalInsurance: 0,
    penaltyDeductionValue: 0,
    leaveAbsenceDeductionValue: 0,
    manualDebit: 0,
    fines: 0,
    deductionChecks: 0,
    groupedChecks: 0,
    healthCertificatesDeduction: 0,
    fractionDeduction: 0,
    documentsDeduction: 0,
    previousSettlements: 0,
    previousInsurance: 0,
    advanceShortTotal: 0,
    advanceLongTotal: 0,
    totalEarnings: 3000,
    grossSalary: 3000,
    totalDeductions: 0,
    netSalary: 3000,
    ...overrides,
  } as PayrollLine;
}

describe('payroll line money with advances and deductions', () => {
  it('reduces net by a short advance and a fine', () => {
    const totals = recalculatePayrollLineTotals(
      line({ fines: 150, advanceShortTotal: 500 }),
    );
    expect(totals.totalDeductions).toBeGreaterThanOrEqual(650);
    expect(totals.netSalary).toBeLessThan(totals.grossSalary);
    expect(totals.netSalary).toBe(
      Math.round((totals.grossSalary - totals.totalDeductions) * 100) / 100,
    );
  });

  it('stacks short and long advances into deductions', () => {
    const totals = recalculatePayrollLineTotals(
      line({ advanceShortTotal: 200, advanceLongTotal: 300 }),
    );
    expect(totals.totalDeductions).toBeGreaterThanOrEqual(500);
  });
});
