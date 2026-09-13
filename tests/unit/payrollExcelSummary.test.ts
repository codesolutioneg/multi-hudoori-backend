import { describe, it, expect } from 'vitest';
import type { EmployeeProfile, PayrollLine } from '@prisma/client';
import {
  computePayrollExcelSummary,
  computePayrollLineExcelTotals,
} from '../../src/services/payrollExport.service';

function emp(partial: Partial<EmployeeProfile>): EmployeeProfile {
  return {
    id: 'e1',
    active: true,
    hasFawryAccount: false,
    basicSalary: 9000,
    insuranceSalary: 100,
    medicalInsuranceSalary: 320.5,
    departureDate: null,
    archivedAt: null,
    archiveReason: null,
    ...partial,
  } as EmployeeProfile;
}

function line(
  partial: Partial<PayrollLine>,
  employee: EmployeeProfile | null,
): PayrollLine & { employee: EmployeeProfile | null } {
  return {
    basicSalary: 9000,
    workingDays: 30,
    totalEarnings: 9000,
    totalDeductions: 420.5,
    netSalary: 8579.5,
    socialInsurance: 100,
    medicalInsurance: 320.5,
    isManual: false,
    ...partial,
    employee,
  } as PayrollLine & { employee: EmployeeProfile | null };
}

describe('computePayrollExcelSummary', () => {
  it('matches export row math (net + grand) without stored netSalary', () => {
    const rows = [
      line({}, emp({ hasFawryAccount: false })),
      line(
        {
          basicSalary: 10000,
          totalEarnings: 10000,
          netSalary: 5000,
          totalDeductions: 9999,
        },
        emp({ hasFawryAccount: true, basicSalary: 10000 }),
      ),
    ];
    const summary = computePayrollExcelSummary(rows);
    const t0 = computePayrollLineExcelTotals(rows[0]);
    const t1 = computePayrollLineExcelTotals(rows[1]);
    expect(summary.totalNet).toBe(Math.round((t0.net + t1.net) * 100) / 100);
    expect(summary.grandTotal).toBe(Math.round((t0.grandTotal + t1.grandTotal) * 100) / 100);
    expect(summary.cashTotal).toBe(t0.grandTotal);
    expect(summary.fawryGrandTotal).toBe(t1.grandTotal);
    expect(t1.net).toBeGreaterThan(5000);
  });
});
