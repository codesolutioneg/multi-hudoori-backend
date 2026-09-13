import { describe, it, expect } from 'vitest';
import { PayrollLine } from '@prisma/client';
import {
  normalizeHeader,
  resolveDirectImportCols,
  resolveMoneyImportCols,
  correctImportedPenalty,
  applyPayrollImportRowUpdates,
  shouldMarkManualLine,
} from '../../src/services/payrollImport.service';

function stubLine(partial: Partial<PayrollLine> = {}): PayrollLine {
  return {
    id: 'line1',
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
    totalDeductions: 0,
    netSalary: 2600,
    absentDays: 0,
    absentCount: 0,
    sickDayCount: 0,
    leaveAbsenceDeductionValue: 0,
    editSnapshotSet: false,
    editNetBefore: 0,
    editManualDedBefore: 0,
    lateDeductibleDays: 0,
    lateDeductibleMinutes: 0,
    earnedLeave: 0,
    permissionCount: 0,
    lateDeduction: 0,
    earlyDeduction: 0,
    absentDeduction: 0,
    sickDeduction: 0,
    manualDebit: 0,
    penaltyDeductionValue: 0,
    adminDeduction: 0,
    fines: 0,
    deductionChecks: 0,
    groupedChecks: 0,
    healthCertificatesDeduction: 0,
    fractionDeduction: 0,
    documentsDeduction: 0,
    socialInsurance: 0,
    medicalInsurance: 0,
    previousSettlements: 0,
    previousInsurance: 0,
    advanceShortTotal: 0,
    advanceLongTotal: 0,
    lateCheckoutDeduction: 0,
    punchDeductionCheckin: 0,
    punchDeductionCheckout: 0,
    earlyLeaveMinutes: 0,
    lateCheckoutMinutes: 0,
    fawryCommission: 0,
    positionName: '',
    departmentName: '',
    employeeLocation: '',
    notes: null,
    isManual: false,
    ...partial,
  } as PayrollLine;
}

describe('payrollImport.service', () => {
  it('normalizes Excel header keys', () => {
    expect(normalizeHeader('Employee Code')).toBe('employee_code');
    expect(normalizeHeader('leave_absence_deduction_value')).toBe('leave_absence_deduction_value');
    expect(normalizeHeader('  Salary Advance ')).toBe('salary_advance');
  });

  it('maps exported snake_case keys to line fields (working_days → workingDays)', () => {
    const header = [
      'employee_code',
      'employee_name',
      'department',
      'position',
      'hiring_date',
      'placeholder',
      'basic_salary',
      'working_days',
      'overtime_hours',
      'work_days_salary',
      'long_term_advance',
      'salary_advance',
    ].map(normalizeHeader);

    const cols = resolveDirectImportCols(header);
    expect(cols.workingDays).toBe(7);
    expect(cols.workDaysSalary).toBeUndefined();
    expect(cols.advanceLongTotal).toBe(10);
    expect(cols.advanceShortTotal).toBe(11);
  });

  it('does not map camelCase workingDays (export uses working_days)', () => {
    const header = ['employee_code', 'workingDays'].map((h) => normalizeHeader(h));
    const cols = resolveDirectImportCols(header);
    expect(cols.workingDays).toBeUndefined();
  });

  it('corrects imported penalty cell by subtracting admin-days money (Odoo)', () => {
    // basic 3000 → daily 100; admin 2 days → 200; cell shows 250 → pure 50
    expect(correctImportedPenalty(250, 3000, 2)).toBe(50);
    expect(correctImportedPenalty(100, 3000, 2)).toBe(0);
  });

  it('resolves money formula columns for import', () => {
    const header = [
      'employee_code',
      'late_deductible_days',
      'late_value',
      'absent_count',
      'absent_deduction',
      'sick_value',
      'manual_debit',
    ].map(normalizeHeader);
    const money = resolveMoneyImportCols(header);
    expect(money.map((m) => m.field).sort()).toEqual(
      ['absentDeduction', 'lateDeduction', 'sickDeduction'].sort(),
    );
  });

  it('applies literal money overrides and marks line manual', () => {
    const header = [
      'employee_code',
      'late_deductible_days',
      'late_value',
      'absent_count',
      'absent_deduction',
      'manual_debit',
    ].map(normalizeHeader);
    const line = stubLine({ lateDeduction: 50, lateDeductibleDays: 0.5, absentCount: 1, absentDeduction: 100 });
    const countCols: Record<string, number> = {
      late_deductible_days: 1,
      absent_count: 3,
    };
    const directCols = resolveDirectImportCols(header);
    const moneyCols = resolveMoneyImportCols(header);
    // code, late days 0.5, late money 250 (literal override), absent days 1, absent money 80, manual 40
    const row = ['100', 0.5, 250, 1, 80, 40];
    const updates = applyPayrollImportRowUpdates({
      line,
      row,
      countCols,
      directCols,
      moneyCols,
      excelBasic: 3000,
      importedPenalty: false,
    });
    expect(updates.lateDeduction).toBe(250);
    expect(updates.lateDeductibleDays).toBe(2.5); // 250 / (3000/30)
    expect(updates.absentDeduction).toBe(80);
    expect(updates.absentCount).toBe(1);
    expect(updates.absentDays).toBe(1);
    expect(updates.manualDebit).toBe(40);
    expect(shouldMarkManualLine(line, updates, false)).toBe(true);
  });

  it('ignores untouched formula cells for money columns (keeps days×rate)', () => {
    const header = ['employee_code', 'late_deductible_days', 'late_value'].map(normalizeHeader);
    const line = stubLine({ lateDeduction: 100, lateDeductibleDays: 1 });
    const countCols: Record<string, number> = { late_deductible_days: 1 };
    const moneyCols = resolveMoneyImportCols(header);
    const row = [
      '100',
      2,
      { formula: 'ROUND(G6/30*O6,2)', result: 999 }, // stale cached formula result must not win
    ];
    const updates = applyPayrollImportRowUpdates({
      line,
      row,
      countCols,
      directCols: {},
      moneyCols,
      excelBasic: 3000,
      importedPenalty: false,
    });
    // days=2 → money 200 from count specs; formula cell ignored
    expect(updates.lateDeduction).toBe(200);
  });
});
