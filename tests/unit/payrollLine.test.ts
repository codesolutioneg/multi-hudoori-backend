import { describe, it, expect } from 'vitest';
import { PayrollLine } from '@prisma/client';
import { recalculatePayrollLineTotals } from '../../src/services/payrollLine.service';

function baseLine(overrides: Partial<PayrollLine> = {}): PayrollLine {
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
    lateDeductibleDays: 0,
    singlePunchCount: 0,
    absentDays: 0,
    absentCount: 0,
    sickDayCount: 0,
    editSnapshotSet: false,
    editNetBefore: 0,
    editManualDedBefore: 0,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PayrollLine;
}

describe('payrollLine.service totals', () => {
  it('does not charge leaveAbsenceDeductionValue in total deductions', () => {
    const line = baseLine({ leaveAbsenceDeductionValue: 150 });
    const totals = recalculatePayrollLineTotals(line);
    expect(totals.totalDeductions).toBe(0);
    expect(totals.netSalary).toBe(3000);
  });

  it('includes lateCheckoutDeduction in attendance bucket', () => {
    const line = baseLine({ lateCheckoutDeduction: 100, leaveAbsenceDeductionValue: 50 });
    const totals = recalculatePayrollLineTotals(line);
    expect(totals.totalDeductions).toBe(100);
  });

  it('recomputes earnings from workingDays + overtimeHours like line edit save', () => {
    const basic = 9000;
    const workingDays = 28;
    const overtimeHours = 4;
    const workDaysSalary = Math.round((basic / 30) * workingDays * 100) / 100;
    const overtimeAmount = Math.round((basic / 30) * overtimeHours * 100) / 100;
    const line = baseLine({
      basicSalary: basic,
      workingDays,
      overtimeHours,
      workDaysSalary,
      overtimeAmount,
      lateDeduction: 150,
      absentDeduction: 300,
      advanceShortTotal: 1000,
      manualDebit: 50,
      deductionChecks: 25,
      penaltyDeductionValue: 40,
    });
    const totals = recalculatePayrollLineTotals(line);
    expect(totals.workDaysSalary).toBe(workDaysSalary);
    expect(totals.overtimeAmount).toBe(overtimeAmount);
    expect(totals.totalEarnings).toBe(
      Math.round((workDaysSalary + overtimeAmount) * 100) / 100,
    );
    // attendance 450 + manual (50+25+40) + advance 1000 = 1565
    expect(totals.totalDeductions).toBe(1565);
    expect(totals.netSalary).toBe(
      Math.round((totals.totalEarnings - 1565) * 100) / 100,
    );
  });

  it('counts adminDeduction as days × daily rate (edit dialog admin field)', () => {
    const line = baseLine({
      basicSalary: 3000,
      workDaysSalary: 3000,
      adminDeduction: 2,
    });
    const totals = recalculatePayrollLineTotals(line);
    // 2 * (3000/30) = 200
    expect(totals.totalDeductions).toBe(200);
    expect(totals.netSalary).toBe(2800);
  });

  it('includes short + long advances in deductions (editable totals)', () => {
    const line = baseLine({
      advanceShortTotal: 1500,
      advanceLongTotal: 500,
    });
    const totals = recalculatePayrollLineTotals(line);
    expect(totals.totalDeductions).toBe(2000);
    expect(totals.netSalary).toBe(1000);
  });
});
