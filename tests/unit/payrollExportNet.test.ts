import { describe, it, expect } from 'vitest';
import type { PayrollLine } from '@prisma/client';
import {
  buildPayrollXlsxFilename,
  buildPayslipsXlsxFilename,
  computePayrollLineExcelTotals,
  excelNetSalaryLine,
  getPayslipValues,
  sanitizePayrollFilenamePart,
  writePayslipsSheet,
} from '../../src/services/payrollExport.service';

function line(partial: Partial<PayrollLine>): PayrollLine {
  return {
    id: 'l1',
    payrollId: 'p1',
    employeeId: 'e1',
    employeeCode: '7210',
    sequence: 1,
    basicSalary: 8000,
    workingDays: 2,
    workDaysSalary: 266.67,
    overtimeHours: 0,
    overtimeAmount: 0,
    totalEarnings: 266.67,
    grossSalary: 266.67,
    totalDeductions: 1600,
    netSalary: 0,
    advanceShortTotal: 0,
    advanceLongTotal: 0,
    ...partial,
  } as PayrollLine;
}

describe('excelNetSalaryLine', () => {
  it('returns negative net when deductions exceed earnings', () => {
    expect(excelNetSalaryLine(line({}))).toBe(-1333.33);
  });

  it('matches stored net when earnings cover deductions', () => {
    expect(excelNetSalaryLine(line({ totalEarnings: 3000, totalDeductions: 500, netSalary: 2500 }))).toBe(
      2500,
    );
  });
});

describe('getPayslipValues excelNet', () => {
  it('matches Payroll Excel totals, not stale stored totalDeductions', () => {
    const row = {
      ...line({
        totalEarnings: 7733.33,
        totalDeductions: 3466, // stale DB value (wrong)
        netSalary: 4267.33,
        socialInsurance: 0,
        medicalInsurance: 0,
        advanceShortTotal: 2000,
        deductionChecks: 380,
      }),
      employee: {
        name: 'Test',
        code: '341',
        jobTitle: 'X',
        insuranceSalary: 0,
        medicalInsuranceSalary: 0,
      } as never,
    };
    const v = getPayslipValues(
      row,
      {
        id: 'p1',
        name: 'Payroll',
        dateFrom: new Date('2026-07-26'),
        dateTo: new Date('2026-08-25'),
        shiftGridId: null,
        shiftGrid: null,
        lines: [],
      },
      1,
    );
    const excel = computePayrollLineExcelTotals(row);
    expect(v.excelTotalDeductions).toBe(2380);
    expect(v.excelTotalDeductions).toBe(excel.totalDeductions);
    expect(v.excelNet).toBe(excel.net);
    expect(v.excelNet).toBe(5353.33);
    expect(v.excelNet).not.toBe(excelNetSalaryLine(row));
  });
});

describe('buildPayrollXlsxFilename', () => {
  it('includes branch and pay period in download name', () => {
    expect(
      buildPayrollXlsxFilename({
        name: 'Strip payroll',
        dateFrom: new Date('2026-07-26'),
        dateTo: new Date('2026-08-25'),
        shiftGrid: { location: { name: 'Strip' } },
      }),
    ).toBe('Payroll_Strip_2026-07-26_2026-08-25.xlsx');
  });

  it('sanitizes branch tokens', () => {
    expect(sanitizePayrollFilenamePart('  Strip / Mall  ')).toBe('Strip_Mall');
  });
});

describe('writePayslipsSheet A4 print', () => {
  it('puts a page break after each employee except the last', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const emp = (code: string, name: string) =>
      ({
        ...line({ employeeCode: code, sequence: Number(code) }),
        employee: { name, code, jobTitle: 'X' } as never,
      });
    writePayslipsSheet(wb, {
      id: 'p1',
      name: 'Payroll',
      dateFrom: new Date('2026-07-26'),
      dateTo: new Date('2026-08-25'),
      shiftGridId: null,
      shiftGrid: { location: { name: 'Balkans' } },
      lines: [emp('9002', 'First Emp'), emp('9003', 'Second Emp')],
    });
    const sheet = wb.getWorksheet('Payslip');
    expect(sheet).toBeTruthy();
    expect(sheet!.pageSetup.paperSize).toBe(9);
    expect(sheet!.pageSetup.orientation).toBe('portrait');
    expect(sheet!.pageSetup.fitToWidth).toBe(1);
    expect(sheet!.pageSetup.fitToHeight).toBe(0);
    expect(sheet!.rowBreaks.length).toBe(1);
    const flat = JSON.stringify(sheet!.getSheetValues());
    expect(flat).toContain('First Emp');
    expect(flat).toContain('Second Emp');
    expect(flat).toContain('إجمالي الراتب');
  });

  it('names the payslips-only file from the payroll export name', () => {
    expect(
      buildPayslipsXlsxFilename({
        name: 'Balkans payroll',
        dateFrom: new Date('2026-07-26'),
        dateTo: new Date('2026-08-25'),
        shiftGrid: { location: { name: 'Balkans' } },
      }),
    ).toBe('Payslips_Balkans_2026-07-26_2026-08-25.xlsx');
  });
});
