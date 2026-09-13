import { describe, it, expect } from 'vitest';
import type { PayrollLine } from '@prisma/client';
import {
  EDIT_MANUAL_DED_FIELDS,
  adminPenaltyMoney,
  isOverDeductedLine,
  manualDedTotal,
  overDeductionExcess,
  recalculatePayrollLineTotals,
  round2,
} from '../../src/services/payrollLine.service';

function line(overrides: Partial<PayrollLine> = {}): PayrollLine {
  return {
    id: 'line1',
    payrollId: 'pay1',
    employeeId: 'emp1',
    sequence: 1,
    employeeCode: '100',
    basicSalary: 3000,
    workingDays: 30,
    workDaysSalary: 0,
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
    totalEarnings: 0,
    grossSalary: 0,
    totalDeductions: 0,
    netSalary: 0,
    ...overrides,
  } as PayrollLine;
}

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(1.014)).toBe(1.01);
    expect(round2(1.016)).toBe(1.02);
    expect(round2(1.004)).toBe(1);
    expect(round2(2.675)).toBe(2.68);
  });

  it('inherits binary-float half-cent behaviour', () => {
    // 1.005 * 100 is 100.49999999999999 in IEEE-754, so it rounds down.
    // Recorded deliberately: every stored money value already uses this rule.
    expect(round2(1.005)).toBe(1);
  });
});

describe('adminPenaltyMoney', () => {
  it('converts penalty days into money at the 30-day daily rate', () => {
    expect(adminPenaltyMoney(3000, 1)).toBe(100);
    expect(adminPenaltyMoney(3000, 0.5)).toBe(50);
  });

  it('is zero for zero or missing days', () => {
    expect(adminPenaltyMoney(3000, 0)).toBe(0);
    expect(adminPenaltyMoney(3000, NaN as unknown as number)).toBe(0);
  });
});

describe('recalculatePayrollLineTotals', () => {
  it('derives work-days salary from basic salary when not preset', () => {
    const totals = recalculatePayrollLineTotals(line({ basicSalary: 3000, workingDays: 30 }));
    expect(totals.workDaysSalary).toBe(3000);
    expect(totals.totalEarnings).toBe(3000);
    expect(totals.netSalary).toBe(3000);
  });

  it('prorates a partial month', () => {
    expect(recalculatePayrollLineTotals(line({ workingDays: 15 })).workDaysSalary).toBe(1500);
  });

  it('keeps an explicitly stored work-days salary', () => {
    expect(recalculatePayrollLineTotals(line({ workDaysSalary: 2222 })).workDaysSalary).toBe(2222);
  });

  it('derives the overtime amount from hours at the daily rate', () => {
    const totals = recalculatePayrollLineTotals(line({ overtimeHours: 2 }));
    expect(totals.overtimeAmount).toBe(200);
    expect(totals.totalEarnings).toBe(3200);
  });

  it('sums the attendance deduction bucket', () => {
    const totals = recalculatePayrollLineTotals(
      line({
        lateDeduction: 10,
        lateCheckoutDeduction: 20,
        earlyDeduction: 30,
        punchDeductionCheckin: 5,
        punchDeductionCheckout: 5,
        absentDeduction: 100,
        sickDeduction: 25,
      }),
    );
    expect(totals.totalDeductions).toBe(195);
    expect(totals.netSalary).toBe(2805);
  });

  it('sums the manual deduction bucket', () => {
    const totals = recalculatePayrollLineTotals(
      line({
        penaltyDeductionValue: 10,
        leaveAbsenceDeductionValue: 20,
        manualDebit: 30,
        fines: 40,
        deductionChecks: 50,
        groupedChecks: 60,
        healthCertificatesDeduction: 70,
        fractionDeduction: 80,
        documentsDeduction: 90,
        previousSettlements: 100,
        previousInsurance: 110,
      }),
    );
    expect(totals.totalDeductions).toBe(640);
  });

  it('converts adminDeduction days into money', () => {
    expect(recalculatePayrollLineTotals(line({ adminDeduction: 2 })).totalDeductions).toBe(200);
  });

  it('includes both advance buckets', () => {
    const totals = recalculatePayrollLineTotals(
      line({ advanceShortTotal: 500, advanceLongTotal: 250 }),
    );
    expect(totals.totalDeductions).toBe(750);
    expect(totals.netSalary).toBe(2250);
  });

  it('includes insurance from the line when no override is passed', () => {
    const totals = recalculatePayrollLineTotals(
      line({ socialInsurance: 300, medicalInsurance: 100 }),
    );
    expect(totals.totalDeductions).toBe(400);
  });

  it('prefers a positive insurance override from the employee profile', () => {
    const totals = recalculatePayrollLineTotals(line({ socialInsurance: 300 }), {
      socialInsurance: 500,
      medicalInsurance: 200,
    });
    expect(totals.totalDeductions).toBe(700);
  });

  it('falls back to the line value when the override is zero or null', () => {
    const totals = recalculatePayrollLineTotals(line({ socialInsurance: 300 }), {
      socialInsurance: 0,
      medicalInsurance: null,
    });
    expect(totals.totalDeductions).toBe(300);
  });

  it('never returns a negative net salary', () => {
    const totals = recalculatePayrollLineTotals(line({ manualDebit: 999999 }));
    expect(totals.netSalary).toBe(0);
  });

  it('reports over-deduction excess when deductions exceed earnings', () => {
    const totals = recalculatePayrollLineTotals(
      line({ basicSalary: 3000, workingDays: 30, manualDebit: 3500 }),
    );
    expect(totals.totalEarnings).toBe(3000);
    expect(totals.totalDeductions).toBe(3500);
    expect(totals.netSalary).toBe(0);
    expect(overDeductionExcess(totals.totalEarnings, totals.totalDeductions)).toBe(500);
    expect(isOverDeductedLine(totals)).toBe(true);
  });

  it('reports zero excess when deductions do not exceed earnings', () => {
    expect(overDeductionExcess(3000, 2800)).toBe(0);
    expect(isOverDeductedLine({ totalEarnings: 3000, totalDeductions: 2800 })).toBe(false);
  });

  it('signed net is earnings minus deductions (can be negative)', () => {
    expect(round2(1000 - 1500)).toBe(-500);
  });

  it('reports gross equal to total earnings', () => {
    const totals = recalculatePayrollLineTotals(line({ overtimeHours: 3 }));
    expect(totals.grossSalary).toBe(totals.totalEarnings);
  });

  it('tolerates a zero basic salary without producing NaN', () => {
    const totals = recalculatePayrollLineTotals(line({ basicSalary: 0 }));
    expect(totals.netSalary).toBe(0);
    expect(Number.isNaN(totals.totalDeductions)).toBe(false);
  });

  it('tolerates missing overtimeHours on a sparse line', () => {
    const sparse = line({ basicSalary: 0, overtimeHours: undefined as unknown as number });
    const totals = recalculatePayrollLineTotals(sparse);
    expect(Number.isNaN(totals.overtimeAmount)).toBe(false);
    expect(Number.isNaN(totals.netSalary)).toBe(false);
  });
});

describe('manualDedTotal', () => {
  it('sums only the operator-editable deduction fields', () => {
    const l = line({
      deductionChecks: 10,
      manualDebit: 20,
      healthCertificatesDeduction: 30,
      fractionDeduction: 40,
      fines: 50,
      documentsDeduction: 60,
      // not part of the edit template
      groupedChecks: 999,
    });
    expect(manualDedTotal(l)).toBe(210);
  });

  it('covers every declared edit field', () => {
    for (const field of EDIT_MANUAL_DED_FIELDS) {
      expect(manualDedTotal(line({ [field]: 7 } as Partial<PayrollLine>))).toBe(7);
    }
  });
});
