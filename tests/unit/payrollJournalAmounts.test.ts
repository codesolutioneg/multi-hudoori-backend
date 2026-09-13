import { describe, expect, it } from 'vitest';
import {
  computePayrollJournalAmounts,
  penaltyTotal,
  buildPayrollJournalMoveLines,
  computePayrollCashFawrySummary,
} from '../../src/services/odoo/payrollJournalAmounts';

describe('payrollJournalAmounts', () => {
  it('matches Odoo penalty formula (days × daily + money fields)', () => {
    const line = {
      basicSalary: 3000,
      lateDeduction: 10,
      punchDeductionCheckin: 20,
      lateCheckoutDeduction: 5,
      sickDeduction: 15,
      absentCount: 2,
      adminDeduction: 1,
      penaltyDeductionValue: 50,
      fractionDeduction: 3,
      fines: 7,
    };
    // daily = 100; absent 200; admin 100
    expect(penaltyTotal(line)).toBe(10 + 20 + 5 + 15 + 200 + 100 + 50 + 3 + 7);
  });

  it('uses employee insurance salary for company social (11% → 18.75%)', () => {
    const amounts = computePayrollJournalAmounts([
      {
        totalEarnings: 1000,
        employee: { insuranceSalary: 110, medicalInsuranceSalary: 40 },
      },
    ]);
    expect(amounts.employeeSocial).toBe(110);
    expect(amounts.companySocial).toBe(187.5);
    expect(amounts.totalDebit).toBe(1187.5);
    expect(amounts.totalSocialLib).toBe(297.5);
    expect(amounts.totalMedicalLib).toBe(40);
    expect(amounts.netSalary).toBe(850);
    expect(amounts.totalCredit).toBe(amounts.totalDebit);
  });

  it('builds debit/credit lines and skips zeros', () => {
    const amounts = computePayrollJournalAmounts([
      {
        totalEarnings: 500,
        advanceShortTotal: 50,
        employee: { insuranceSalary: 0, medicalInsuranceSalary: 0 },
      },
    ]);
    const lines = buildPayrollJournalMoveLines(amounts, 'حـ/ حساب مرتبات');
    expect(lines.find((l) => l.code === '613004200')?.debit).toBe(500);
    expect(lines.find((l) => l.code === '150480380')?.credit).toBe(50);
    expect(lines.find((l) => l.code === '221541086')?.credit).toBe(450);
    expect(lines.some((l) => l.code === '613134340')).toBe(false);
  });

  it('splits cash / fawry with 0.15% commission like the Odoo journal preview', () => {
    const summary = computePayrollCashFawrySummary([
      { netSalary: 1000, employee: { hasFawryAccount: true, active: true } },
      { netSalary: 400, employee: { hasFawryAccount: false, active: true } },
      {
        netSalary: 200,
        employee: { hasFawryAccount: true, active: false },
      },
    ]);
    expect(summary.cashTotal).toBe(600);
    expect(summary.fawryNet).toBe(1000);
    expect(summary.fawryCommission).toBe(1.5);
    expect(summary.fawryGrandTotal).toBe(1001.5);
  });
});
