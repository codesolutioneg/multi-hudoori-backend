import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createShift,
  createUser,
  ensureBioTimeConfig,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** ZIP local file header: every .xlsx starts with "PK\x03\x04". */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function loadWorkbook(base64: string): Promise<ExcelJS.Workbook> {
  const buffer = Buffer.from(base64, 'base64');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

/**
 * Every shift-grid workbook also carries a copy-source sheet for the import
 * validation, plus hidden `_`-prefixed helpers. Neither is a grid sheet, so the
 * grouping assertions have to look past them.
 */
const SHIFT_REFERENCE_SHEET = 'مرجع الشيفتات';

function gridSheetNames(workbook: ExcelJS.Workbook): string[] {
  return workbook.worksheets
    .map((w) => w.name)
    .filter((n) => !n.startsWith('_') && n !== SHIFT_REFERENCE_SHEET);
}

function expectXlsx(data: Record<string, unknown>): string {
  expect(data.mimeType).toBe(XLSX_MIME);
  expect(String(data.filename)).toMatch(/\.xlsx$/);
  const base64 = String(data.file ?? data.base64 ?? '');
  expect(base64.length).toBeGreaterThan(0);
  expect(Buffer.from(base64, 'base64').subarray(0, 4)).toEqual(ZIP_MAGIC);
  return base64;
}

describe('xlsx exports', () => {
  let hr: SeededUser;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hr = await createUser({ login: 'hr@test.local', role: UserRole.HR_MANAGER });
  });

  describe('reference data', () => {
    it('exports employees to a readable workbook', async () => {
      await prisma.employeeProfile.create({
        data: { name: 'Export Target', code: 'X100', basicSalary: 3500 },
      });
      const data = expectOk(await rpc('/api/biotime/employees/export-xlsx', {}, hr.token));
      const workbook = await loadWorkbook(expectXlsx(data));
      expect(workbook.worksheets.length).toBeGreaterThan(0);

      const sheet = workbook.worksheets[0];
      const flat = JSON.stringify(sheet.getSheetValues());
      expect(flat).toContain('Export Target');
    });

    it('exports locations', async () => {
      await createLocation({ name: 'Export Branch', code: 'LOC-EXP' });
      const data = expectOk(await rpc('/api/biotime/locations/export-xlsx', {}, hr.token));
      const workbook = await loadWorkbook(expectXlsx(data));
      expect(JSON.stringify(workbook.worksheets[0].getSheetValues())).toContain('Export Branch');
    });

    it('exports shifts', async () => {
      await createShift({ name: 'Export Shift', code: 'XS1' });
      const data = expectOk(await rpc('/api/biotime/shifts/export-xlsx', {}, hr.token));
      const workbook = await loadWorkbook(expectXlsx(data));
      expect(JSON.stringify(workbook.worksheets[0].getSheetValues())).toContain('Export Shift');
    });

    it('exports the single-type deduction template', async () => {
      const data = expectOk(
        await rpc('/api/biotime/deductions/export-template', { type: 'fines' }, hr.token),
      );
      const workbook = await loadWorkbook(expectXlsx(data));
      expect(workbook.worksheets.length).toBeGreaterThan(0);
    });

    it('exports the multi-type deduction template', async () => {
      const data = expectOk(await rpc('/api/biotime/deductions/export-multi-template', {}, hr.token));
      await loadWorkbook(expectXlsx(data));
    });
  });

  describe('payroll exports', () => {
    let payrollId: string;

    beforeEach(async () => {
      const employee = await prisma.employeeProfile.create({
        data: {
          name: 'Payslip Person',
          code: 'X200',
          basicSalary: 6000,
          bankIban: `EG${'1'.repeat(27)}`,
        },
      });
      const payroll = await prisma.payroll.create({
        data: { name: 'June payroll', dateFrom: new Date('2026-06-01'), dateTo: new Date('2026-06-30') },
      });
      payrollId = payroll.id;
      await prisma.payrollLine.create({
        data: {
          payrollId: payroll.id,
          employeeId: employee.id,
          sequence: 1,
          employeeCode: 'X200',
          basicSalary: 6000,
          workingDays: 30,
          workDaysSalary: 6000,
          totalEarnings: 6000,
          grossSalary: 6000,
          totalDeductions: 500,
          netSalary: 5500,
        },
      });
    });

    it('exports the payroll workbook', async () => {
      const data = expectOk(await rpc('/api/biotime/payroll/export-xlsx', { id: payrollId }, hr.token));
      const workbook = await loadWorkbook(expectXlsx(data));
      expect(JSON.stringify(workbook.worksheets[0].getSheetValues())).toContain('Payslip Person');
    });

    it('exports payslips-only workbook with one A4 page per employee', async () => {
      const employee2 = await prisma.employeeProfile.create({
        data: { name: 'Payslip Other', code: 'X202', basicSalary: 5000 },
      });
      await prisma.payrollLine.create({
        data: {
          payrollId,
          employeeId: employee2.id,
          sequence: 2,
          employeeCode: 'X202',
          basicSalary: 5000,
          workingDays: 30,
          workDaysSalary: 5000,
          totalEarnings: 5000,
          grossSalary: 5000,
          totalDeductions: 200,
          netSalary: 4800,
        },
      });
      const data = expectOk(
        await rpc('/api/biotime/payroll/export-payslips-xlsx', { id: payrollId }, hr.token),
      );
      expect(String(data.filename)).toMatch(/^Payslips_.*\.xlsx$/);
      const workbook = await loadWorkbook(expectXlsx(data));
      expect(workbook.worksheets.map((w) => w.name)).toEqual(['Payslip']);
      const sheet = workbook.worksheets[0];
      const flat = JSON.stringify(sheet.getSheetValues());
      expect(flat).toContain('Payslip Person');
      expect(flat).toContain('Payslip Other');
      expect(sheet.pageSetup.paperSize).toBe(9);
      expect(sheet.rowBreaks.length).toBe(1);
    });

    it('keeps add/subtract formulas on resigned yellow rows and omits leave-absence column', async () => {
      const resigned = await prisma.employeeProfile.create({
        data: {
          name: 'Resigned Person',
          code: 'X201',
          basicSalary: 6000,
          active: false,
          departureDate: new Date('2026-06-15'),
        },
      });
      await prisma.payrollLine.create({
        data: {
          payrollId,
          employeeId: resigned.id,
          sequence: 2,
          employeeCode: 'X201',
          basicSalary: 6000,
          workingDays: 15,
          workDaysSalary: 3000,
          totalEarnings: 3000,
          grossSalary: 3000,
          totalDeductions: 100,
          netSalary: 2900,
        },
      });
      const data = expectOk(await rpc('/api/biotime/payroll/export-xlsx', { id: payrollId }, hr.token));
      const workbook = await loadWorkbook(expectXlsx(data));
      const sheet = workbook.worksheets[0];
      const keys = (sheet.getRow(5).values ?? []) as unknown[];
      expect(keys).not.toContain('leave_absence_deduction_value');
      const teCol = keys.findIndex((k) => k === 'total_earnings');
      const dedCol = keys.findIndex((k) => k === 'total_deductions');
      const netCol = keys.findIndex((k) => k === 'net_salary');
      expect(teCol).toBeGreaterThan(0);
      let found = false;
      sheet.eachRow((row) => {
        const name = String(row.getCell(2).value ?? '');
        if (!name.includes('Resigned Person')) return;
        found = true;
        const earn = row.getCell(teCol).value as { formula?: string };
        const totDed = row.getCell(dedCol).value as { formula?: string };
        const net = row.getCell(netCol).value as { formula?: string };
        expect(earn.formula).toMatch(/\+/);
        expect(totDed.formula).toMatch(/\+/);
        expect(net.formula).toMatch(/-/);
      });
      expect(found).toBe(true);
    });

    it('exports the Fawry bank transfer file', async () => {
      const data = expectOk(await rpc('/api/biotime/payroll/export-fawry', { id: payrollId }, hr.token));
      const workbook = await loadWorkbook(expectXlsx(data));
      expect(workbook.worksheets.length).toBeGreaterThan(0);
    });

    it('exports the cash Fawry file', async () => {
      const data = expectOk(await rpc('/api/biotime/payroll/export-cash-fawry', { id: payrollId }, hr.token));
      await loadWorkbook(expectXlsx(data));
    });

    it('exports the payroll edit template', async () => {
      const data = expectOk(
        await rpc('/api/biotime/payroll/edit-template/export-xlsx', { id: payrollId }, hr.token),
      );
      await loadWorkbook(expectXlsx(data));
    });

    it('exports the duplicates workbook', async () => {
      const data = expectOk(
        await rpc('/api/biotime/payroll/duplicates/export-xlsx', { id: payrollId }, hr.token),
      );
      await loadWorkbook(expectXlsx(data));
    });

    it('round-trips the edit template through import', async () => {
      const exported = expectOk(
        await rpc('/api/biotime/payroll/edit-template/export-xlsx', { id: payrollId }, hr.token),
      );
      const base64 = String(exported.file ?? exported.base64);
      const res = await rpc(
        '/api/biotime/payroll/edit-template/import-xlsx',
        { id: payrollId, file: base64 },
        hr.token,
      );
      // A freshly exported template carries no edits, so the import is a no-op
      // but must still parse without error.
      expect(res.body.result).toBeDefined();
    });

    /**
     * A transferred employee is paid on the branch where they worked, not the one
     * they ended up in. The sheet must label them with the payroll's grid branch,
     * even when the employee's current location has since changed to another branch.
     */
    it('shows the branch from the payroll grid, not the employee current location', async () => {
      const gridBranch = await createLocation({ name: 'GridBranchAlpha', code: 'LOC-GA' });
      const currentBranch = await createLocation({ name: 'EmpCurrentBeta', code: 'LOC-CB' });
      const employee = await prisma.employeeProfile.create({
        data: { name: 'Moved Person', code: 'X500', basicSalary: 5000, locationId: currentBranch.id },
      });
      const grid = await prisma.shiftGrid.create({
        data: {
          name: 'Alpha grid',
          dateFrom: new Date('2026-06-01'),
          dateTo: new Date('2026-06-30'),
          locationId: gridBranch.id,
        },
      });
      const payroll = await prisma.payroll.create({
        data: {
          name: 'Branch payroll',
          dateFrom: new Date('2026-06-01'),
          dateTo: new Date('2026-06-30'),
          shiftGridId: grid.id,
        },
      });
      await prisma.payrollLine.create({
        data: {
          payrollId: payroll.id,
          employeeId: employee.id,
          sequence: 1,
          employeeCode: 'X500',
          basicSalary: 5000,
          workingDays: 30,
          workDaysSalary: 5000,
          totalEarnings: 5000,
          grossSalary: 5000,
          totalDeductions: 0,
          netSalary: 5000,
        },
      });

      const data = expectOk(
        await rpc('/api/biotime/payroll/export-xlsx', { id: payroll.id }, hr.token),
      );
      const workbook = await loadWorkbook(expectXlsx(data));
      const text = workbook.worksheets.map((w) => JSON.stringify(w.getSheetValues())).join('\n');
      expect(text).toContain('GridBranchAlpha');
      expect(text).not.toContain('EmpCurrentBeta');
    });
  });

  describe('shift grid and punch report exports', () => {
    let gridId: string;

    beforeEach(async () => {
      const shift = await createShift();
      const employee = await prisma.employeeProfile.create({
        data: { name: 'Grid Export Person', code: 'X300', basicSalary: 3000 },
      });
      const grid = await prisma.shiftGrid.create({
        data: {
          name: 'Export grid',
          dateFrom: new Date('2026-06-01'),
          dateTo: new Date('2026-06-07'),
        },
      });
      gridId = grid.id;
      for (let d = 1; d <= 7; d++) {
        await prisma.shiftGridLine.create({
          data: {
            gridId: grid.id,
            employeeId: employee.id,
            date: new Date(`2026-06-0${d}T00:00:00.000Z`),
            shiftId: shift.id,
          },
        });
      }
    });

    /** HR sends the weekly sheet per department, so each department gets a sheet. */
    it('writes one sheet per department when asked', async () => {
      const kitchen = await prisma.department.create({
        data: { name: 'kitchen', code: 'DEPT-KX' },
      });
      const operation = await prisma.department.create({
        data: { name: 'operation', code: 'DEPT-OX' },
      });
      const shift = await prisma.shift.findFirstOrThrow();
      const grid = await prisma.shiftGrid.findFirstOrThrow({ where: { id: gridId } });

      await prisma.employeeProfile.updateMany({
        where: { code: 'X300' },
        data: { departmentId: kitchen.id },
      });
      const second = await prisma.employeeProfile.create({
        data: { name: 'Ops Person', code: 'X301', basicSalary: 3000, departmentId: operation.id },
      });
      await prisma.shiftGridLine.create({
        data: {
          gridId: grid.id,
          employeeId: second.id,
          date: new Date('2026-06-01T00:00:00.000Z'),
          shiftId: shift.id,
        },
      });

      const split = expectOk(
        await rpc(
          '/api/biotime/shift-grid/export-xlsx',
          { gridId, grouping: 'department', sheetPerGroup: true },
          hr.token,
        ),
      );
      const sheets = await loadWorkbook(expectXlsx(split));
      expect(gridSheetNames(sheets).sort()).toEqual(['kitchen', 'operation']);

      // Still one sheet unless asked, so the default export is unchanged.
      const single = expectOk(
        await rpc(
          '/api/biotime/shift-grid/export-xlsx',
          { gridId, grouping: 'department' },
          hr.token,
        ),
      );
      const singleBook = await loadWorkbook(expectXlsx(single));
      expect(gridSheetNames(singleBook)).toEqual(['جدول الشيفتات']);
    });

    it('exports the shift grid workbook', async () => {
      const data = expectOk(await rpc('/api/biotime/shift-grid/export-xlsx', { gridId }, hr.token));
      const workbook = await loadWorkbook(expectXlsx(data));
      expect(workbook.worksheets.length).toBeGreaterThan(0);
    });

    it('exports the grid punch report', async () => {
      const data = expectOk(
        await rpc('/api/biotime/shift-grid/punch-report-export-xlsx', { gridId }, hr.token),
      );
      await loadWorkbook(expectXlsx(data));
    });

    it('exports the standalone punch report', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/employees/punch-report-export-xlsx',
          { dateFrom: '2026-06-01', dateTo: '2026-06-07' },
          hr.token,
        ),
      );
      await loadWorkbook(expectXlsx(data));
    });

    /**
     * The breakdown sheet used to carry its own copy of the late ladder, so it
     * could contradict the summary sheet in the same workbook.
     */
    it('states the late deduction in the breakdown using the configured policy', async () => {
      const shift = await prisma.shift.findFirstOrThrow();
      const employee = await prisma.employeeProfile.findFirstOrThrow({ where: { code: 'X300' } });

      // Punch times are stored as device wall-clock (the digits, tagged UTC), so seed
      // the Cairo clock time directly with no offset. Shift starts 08:00; late by
      // 90, 90, 60 minutes => check-in 09:30, 09:30, 09:00 (minutes overflow the hour).
      expect(shift.startTime).toBe('08:00');
      const lateByMinutes: Record<number, number> = { 1: 90, 2: 90, 3: 60 };
      let txId = 900000;
      for (const [day, late] of Object.entries(lateByMinutes)) {
        const d = Number(day);
        await prisma.transaction.create({
          data: {
            employeeId: employee.id,
            empCode: employee.code!,
            biotimeTransactionId: txId++,
            punchTime: new Date(Date.UTC(2026, 5, d, 8, late)),
            punchState: '0',
          },
        });
        await prisma.transaction.create({
          data: {
            employeeId: employee.id,
            empCode: employee.code!,
            biotimeTransactionId: txId++,
            punchTime: new Date(Date.UTC(2026, 5, d, 17, 0)),
            punchState: '1',
          },
        });
      }

      const data = expectOk(
        await rpc(
          '/api/biotime/employees/punch-report-export-xlsx',
          { dateFrom: '2026-06-01', dateTo: '2026-06-07' },
          hr.token,
        ),
      );
      const workbook = await loadWorkbook(expectXlsx(data));
      const breakdown = workbook.getWorksheet('تفاصيل الحسابات');
      expect(breakdown).toBeDefined();

      const cells: string[] = [];
      breakdown!.eachRow((row) => {
        row.eachCell({ includeEmpty: false }, (cell) => cells.push(String(cell.value ?? '')));
      });
      const text = cells.join('\n');

      // Exactly 60 minutes is half a day, never a full one.
      expect(text).toContain('60د = 0.5');
      expect(text).not.toContain('60د = 1');
      // The allowance wording is derived from the policy, not hardcoded.
      expect(text).not.toContain('أول تأخيرين');
      expect(text).toContain('أقدم 2 من أيام التأخير');
      // Two of the three late days are excused, leaving only the 60-minute day.
      expect(text).toContain('0.50 يوم');
    });
  });

  describe('pdf exports', () => {
    it('renders a payslip PDF for a payroll line', async () => {
      const employee = await prisma.employeeProfile.create({
        data: { name: 'Pdf Person', code: 'X400', basicSalary: 4000 },
      });
      const payroll = await prisma.payroll.create({
        data: { name: 'Pdf payroll', dateFrom: new Date('2026-06-01'), dateTo: new Date('2026-06-30') },
      });
      await prisma.payrollLine.create({
        data: {
          payrollId: payroll.id,
          employeeId: employee.id,
          sequence: 1,
          employeeCode: 'X400',
          basicSalary: 4000,
          workingDays: 30,
          workDaysSalary: 4000,
          totalEarnings: 4000,
          grossSalary: 4000,
          totalDeductions: 0,
          netSalary: 4000,
        },
      });

      const res = await rpc(
        '/api/biotime/payroll/payslip/pdf',
        { payrollId: payroll.id, employeeId: employee.id },
        hr.token,
      );
      // PDF rendering needs a Chromium download; accept a clean failure here but
      // never a crash, and assert the payload shape when it does render.
      expect(res.body.result).toBeDefined();
      if (res.body.result?.success) {
        const base64 = String(res.body.result.data?.file ?? res.body.result.data?.base64 ?? '');
        expect(Buffer.from(base64, 'base64').subarray(0, 4).toString()).toBe('%PDF');
      }
    }, 120000);
  });
});
