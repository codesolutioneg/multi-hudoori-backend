import { describe, it, expect } from 'vitest';
import { PayrollLine } from '@prisma/client';
import {
  buildPeriodPayrollSummaryRow,
  sumPeriodPayrollSummaryRows,
} from '../../src/services/payrollPeriodExports.service';
import { computePayrollJournalAmounts } from '../../src/services/odoo/payrollJournalAmounts';
import {
  computePayrollExcelSummary,
  isResigned,
} from '../../src/services/payrollExport.service';

function stubEmp(partial: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    name: 'Emp',
    code: '100',
    basicSalary: 3000,
    hasFawryAccount: false,
    active: true,
    departureDate: null,
    archivedAt: null,
    archiveReason: null,
    insuranceSalary: 0,
    medicalInsuranceSalary: 0,
    workPhone: null,
    fawryAccount: null,
    jobTitle: 'Waiter',
    ...partial,
  } as never;
}

function stubLine(partial: Partial<PayrollLine> & { employee?: ReturnType<typeof stubEmp> } = {}) {
  const employee = partial.employee ?? stubEmp();
  return {
    id: 'l1',
    payrollId: 'p1',
    employeeId: 'e1',
    sequence: 1,
    employeeCode: '100',
    basicSalary: 3000,
    workingDays: 26,
    actualWorkingDays: 26,
    workDaysSalary: 2600,
    grossSalary: 2600,
    totalEarnings: 2600,
    overtimeHours: 0,
    overtimeAmount: 0,
    totalDeductions: 100,
    netSalary: 2500,
    absentDays: 0,
    absentCount: 0,
    sickDayCount: 0,
    leaveAbsenceDeductionValue: 0,
    lateDeduction: 0,
    earlyDeduction: 0,
    absentDeduction: 0,
    sickDeduction: 0,
    manualDebit: 50,
    penaltyDeductionValue: 20,
    adminDeduction: 0,
    fines: 0,
    deductionChecks: 30,
    groupedChecks: 0,
    healthCertificatesDeduction: 0,
    fractionDeduction: 0,
    documentsDeduction: 0,
    socialInsurance: 110,
    medicalInsurance: 40,
    advanceShortTotal: 200,
    advanceLongTotal: 100,
    previousSettlements: 0,
    previousInsurance: 0,
    punchDeductionCheckin: 0,
    punchDeductionCheckout: 0,
    lateCheckoutDeduction: 0,
    lateDeductibleDays: 0,
    singlePunchCount: 0,
    isManual: false,
    employee,
    ...partial,
  } as never;
}

describe('period payroll summary totals', () => {
  it('matches journal + excel sheet totals and resigned split', () => {
    const active = stubLine({
      employee: stubEmp({ id: 'a', hasFawryAccount: true, active: true }),
      totalEarnings: 5000,
      netSalary: 4000,
      advanceShortTotal: 300,
      advanceLongTotal: 0,
      manualDebit: 10,
      deductionChecks: 20,
      penaltyDeductionValue: 15,
      socialInsurance: 110,
      medicalInsurance: 50,
    });
    const resigned = stubLine({
      id: 'l2',
      employeeId: 'e2',
      employeeCode: '200',
      employee: stubEmp({
        id: 'b',
        code: '200',
        hasFawryAccount: true,
        active: false,
        archiveReason: 'استقالة',
        archivedAt: new Date('2026-08-01'),
      }),
      totalEarnings: 2000,
      netSalary: 1500,
      advanceShortTotal: 100,
      advanceLongTotal: 50,
      manualDebit: 5,
      deductionChecks: 10,
      penaltyDeductionValue: 0,
      socialInsurance: 0,
      medicalInsurance: 0,
    });

    expect(isResigned(active.employee)).toBe(false);
    expect(isResigned(resigned.employee)).toBe(true);

    const lines = [active, resigned];
    const row = buildPeriodPayrollSummaryRow({
      journalDate: '2026-08-25',
      branchName: 'Test Branch',
      payrollName: 'PAY',
      payrollId: 'p1',
      lines,
    });

    const journal = computePayrollJournalAmounts(lines);
    const excel = computePayrollExcelSummary(lines);

    expect(row.salaries).toBe(excel.grandTotal);
    expect(row.companySocial).toBe(journal.companySocial);
    expect(row.penalties).toBe(journal.penalties);
    expect(row.longAdvance).toBe(journal.longTermAdvance);
    expect(row.shortAdvance).toBe(journal.salaryAdvance);
    expect(row.checks).toBe(journal.deductionChecks);
    expect(row.manualDebit).toBe(journal.manualDebit);
    expect(row.socialLib).toBe(journal.totalSocialLib);
    expect(row.medicalLib).toBe(journal.totalMedicalLib);
    expect(row.netSalaries).toBe(
      Math.round((excel.cashTotal + excel.fawryTotal) * 100) / 100,
    );
    expect(row.cashTotal).toBe(excel.cashTotal);
    expect(row.fawryGrandTotal).toBe(excel.fawryGrandTotal);
    expect(row.fawryCommission).toBe(excel.fawryCommission);
    expect(row.activeEmployeeCount).toBe(1);
    expect(row.resignedEmployeeCount).toBe(1);
    expect(row.lineCount).toBe(2);

    // Resigned always cash; active with fawry → fawry bucket
    expect(row.cashTotal).toBeGreaterThan(0);
    expect(row.fawryGrandTotal).toBeGreaterThan(0);
    expect(row.salaries).toBe(row.cashTotal + row.fawryGrandTotal);
    expect(row.cashTotal + row.fawryGrandTotal).toBe(excel.grandTotal);
  });

  it('sums multiple branch rows like the footer الإجمالي', () => {
    const a = buildPeriodPayrollSummaryRow({
      journalDate: '2026-08-25',
      branchName: 'A',
      payrollName: 'A',
      payrollId: '1',
      lines: [
        stubLine({
          totalEarnings: 1000,
          employee: stubEmp({ hasFawryAccount: false }),
        }),
      ],
    });
    const b = buildPeriodPayrollSummaryRow({
      journalDate: '2026-08-25',
      branchName: 'B',
      payrollName: 'B',
      payrollId: '2',
      lines: [
        stubLine({
          id: 'l2',
          employeeId: 'e2',
          totalEarnings: 2500,
          employee: stubEmp({ id: 'e2', hasFawryAccount: true }),
        }),
      ],
    });
    const totals = sumPeriodPayrollSummaryRows([a, b]);
    expect(totals.salaries).toBe(
      Math.round((a.salaries + b.salaries) * 100) / 100,
    );
    expect(totals.cashTotal).toBe(
      Math.round((a.cashTotal + b.cashTotal) * 100) / 100,
    );
    expect(totals.fawryGrandTotal).toBe(
      Math.round((a.fawryGrandTotal + b.fawryGrandTotal) * 100) / 100,
    );
    expect(totals.activeEmployeeCount).toBe(2);
    expect(totals.lineCount).toBe(2);
  });
});
