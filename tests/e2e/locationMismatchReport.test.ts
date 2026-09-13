import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { UserRole } from '@prisma/client';
import { expectOk, rpc } from '../helpers/api';
import { createLocation, createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';
import { prisma } from '../../src/prisma/client';

const RPC = '/api/biotime/reports/location-mismatch';
const RPC_XLSX = `${RPC}/export-xlsx`;
const PERIOD = { dateFrom: '2026-06-01', dateTo: '2026-06-07' };

type Row = {
  employeeId: string;
  code: string;
  name: string;
  employeeLocationName: string;
  deviceName: string;
  deviceSn: string;
  deviceLocationName: string;
  punchCount: number;
  firstPunchAt: string;
  lastPunchAt: string;
  status: 'mismatched' | 'unmapped_device';
  statusLabel: string;
};

let txSeq = 810000;
async function punch(opts: {
  employeeId?: string;
  empCode?: string;
  at: string;
  terminalSn?: string | null;
  terminalAlias?: string | null;
  isDuplicate?: boolean;
}) {
  return prisma.transaction.create({
    data: {
      employeeId: opts.employeeId,
      empCode: opts.empCode,
      biotimeTransactionId: txSeq++,
      punchTime: new Date(opts.at),
      punchState: '0',
      terminalSn: opts.terminalSn ?? null,
      terminalAlias: opts.terminalAlias ?? null,
      isDuplicate: opts.isDuplicate ?? false,
    },
  });
}

/** Header row of a report sheet is the one whose first cell is '#'. */
function sheetTable(rows: string[][]): { headers: string[]; body: string[][] } {
  const idx = rows.findIndex((r) => r[0] === '#');
  if (idx < 0) throw new Error('no header row found');
  return { headers: rows[idx], body: rows.slice(idx + 1) };
}

async function loadSheets(base64: string): Promise<Map<string, string[][]>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
  const sheets = new Map<string, string[][]>();
  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(String(cell.value ?? '')));
      rows.push(cells);
    });
    sheets.set(sheet.name, rows);
  });
  return sheets;
}

/** Value under a given header, for one body row. */
function cell(headers: string[], row: string[], header: string): string {
  const i = headers.indexOf(header);
  if (i < 0) throw new Error(`header not found: ${header}`);
  return row[i] ?? '';
}

describe('location-mismatch (wrong fingerprint device) report', () => {
  let hr: SeededUser;
  let employee: SeededUser;
  let cairo: { id: string; name: string };
  let alex: { id: string; name: string };

  beforeAll(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    hr = await createUser({ role: UserRole.HR_MANAGER, login: 'mismatch.hr@test.bio' });
    employee = await createUser({
      role: UserRole.EMPLOYEE,
      login: 'mismatch.emp@test.bio',
      withEmployeeProfile: true,
    });
  });

  beforeEach(async () => {
    await prisma.transaction.deleteMany();
    await prisma.device.deleteMany();
    await prisma.employeeProfile.deleteMany({ where: { userId: null } });
    await prisma.location.deleteMany();
    cairo = await createLocation({ name: 'Cairo Branch', code: 'CAI' });
    alex = await createLocation({ name: 'Alex Branch', code: 'ALX' });
  });

  async function seedEmployee(opts: { code: string; name: string; locationId: string | null }) {
    return prisma.employeeProfile.create({
      data: { name: opts.name, code: opts.code, locationId: opts.locationId },
    });
  }

  async function call(params: Record<string, unknown> = {}): Promise<Row[]> {
    const data = expectOk(await rpc(RPC, { ...PERIOD, ...params }, hr.token));
    return data.rows as Row[];
  }

  it('flags a punch on a device assigned to another branch, resolved by serial', async () => {
    const emp = await seedEmployee({ code: 'LM001', name: 'Cairo Guy', locationId: cairo.id });
    await prisma.device.create({
      data: { name: 'Alex Terminal', alias: 'ALX-1', serialNumber: 'SN-ALEX', locationId: alex.id },
    });

    await punch({ employeeId: emp.id, empCode: 'LM001', at: '2026-06-02T06:00:00.000Z', terminalSn: 'SN-ALEX' });
    await punch({ employeeId: emp.id, empCode: 'LM001', at: '2026-06-04T15:30:00.000Z', terminalSn: 'SN-ALEX' });

    const rows = await call();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      employeeId: emp.id,
      code: 'LM001',
      name: 'Cairo Guy',
      employeeLocationName: 'Cairo Branch',
      deviceName: 'ALX-1', // alias wins over name in deviceLabel
      deviceSn: 'SN-ALEX',
      deviceLocationName: 'Alex Branch',
      punchCount: 2,
      status: 'mismatched',
    });
    expect(rows[0].firstPunchAt).toBe('2026-06-02T06:00:00Z');
    expect(rows[0].lastPunchAt).toBe('2026-06-04T15:30:00Z');
  });

  it('does not flag a punch on a device in the employee own branch', async () => {
    const emp = await seedEmployee({ code: 'LM002', name: 'Same Branch', locationId: cairo.id });
    await prisma.device.create({
      data: { name: 'Cairo Terminal', serialNumber: 'SN-CAIRO', locationId: cairo.id },
    });
    await punch({ employeeId: emp.id, empCode: 'LM002', at: '2026-06-02T06:00:00.000Z', terminalSn: 'SN-CAIRO' });

    expect(await call()).toHaveLength(0);
  });

  it('falls back to terminal alias when the serial matches no device', async () => {
    const emp = await seedEmployee({ code: 'LM003', name: 'Alias Path', locationId: cairo.id });
    await prisma.device.create({
      data: { name: 'Alex Terminal', alias: 'ALX-1', serialNumber: 'SN-ALEX', locationId: alex.id },
    });
    // Serial recorded on the punch is unknown to Settings; alias is not.
    await punch({
      employeeId: emp.id,
      empCode: 'LM003',
      at: '2026-06-03T06:00:00.000Z',
      terminalSn: 'SN-NOT-IN-SETTINGS',
      terminalAlias: 'ALX-1',
    });

    const rows = await call();
    expect(rows).toHaveLength(1);
    expect(rows[0].deviceLocationName).toBe('Alex Branch');
    expect(rows[0].status).toBe('mismatched');
    // Serial column keeps what the terminal actually reported.
    expect(rows[0].deviceSn).toBe('SN-NOT-IN-SETTINGS');
  });

  it('refuses the alias fallback when the same terminal name exists in two branches', async () => {
    const emp = await seedEmployee({ code: 'LM004', name: 'Ambiguous', locationId: cairo.id });
    await prisma.device.create({
      data: { name: 'Main Gate', serialNumber: 'SN-A', locationId: cairo.id },
    });
    await prisma.device.create({
      data: { name: 'Main Gate', serialNumber: 'SN-B', locationId: alex.id },
    });
    await punch({
      employeeId: emp.id,
      empCode: 'LM004',
      at: '2026-06-03T06:00:00.000Z',
      terminalSn: 'SN-UNKNOWN',
      terminalAlias: 'Main Gate',
    });

    // Ambiguous name must not be guessed into a mismatch.
    expect(await call()).toHaveLength(0);
    // With unmapped devices requested it surfaces as unresolved, not as a mismatch.
    const withUnmapped = await call({ includeUnmappedDevices: true });
    expect(withUnmapped).toHaveLength(1);
    expect(withUnmapped[0].status).toBe('unmapped_device');
  });

  it('hides unmapped-device punches unless includeUnmappedDevices is set', async () => {
    const emp = await seedEmployee({ code: 'LM005', name: 'No Link', locationId: cairo.id });
    await prisma.device.create({
      data: { name: 'Orphan Terminal', serialNumber: 'SN-ORPHAN', locationId: null },
    });
    await punch({ employeeId: emp.id, empCode: 'LM005', at: '2026-06-03T06:00:00.000Z', terminalSn: 'SN-ORPHAN' });
    // Terminal that is not registered in Settings at all.
    await punch({ employeeId: emp.id, empCode: 'LM005', at: '2026-06-04T06:00:00.000Z', terminalSn: 'SN-GHOST' });

    expect(await call()).toHaveLength(0);

    const rows = await call({ includeUnmappedDevices: true });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'unmapped_device')).toBe(true);
    expect(rows.map((r) => r.deviceLocationName).sort()).toEqual(
      ['الجهاز بدون لوكيشن', 'جهاز غير مسجّل في النظام'].sort(),
    );
  });

  it('skips employees with no assigned location', async () => {
    const emp = await seedEmployee({ code: 'LM006', name: 'Unassigned', locationId: null });
    await prisma.device.create({
      data: { name: 'Alex Terminal', serialNumber: 'SN-ALEX', locationId: alex.id },
    });
    await punch({ employeeId: emp.id, empCode: 'LM006', at: '2026-06-03T06:00:00.000Z', terminalSn: 'SN-ALEX' });

    expect(await call()).toHaveLength(0);
    expect(await call({ includeUnmappedDevices: true })).toHaveLength(0);
  });

  it('ignores duplicate punches and punches outside the period', async () => {
    const emp = await seedEmployee({ code: 'LM007', name: 'Edge Cases', locationId: cairo.id });
    await prisma.device.create({
      data: { name: 'Alex Terminal', serialNumber: 'SN-ALEX', locationId: alex.id },
    });
    await punch({
      employeeId: emp.id,
      empCode: 'LM007',
      at: '2026-06-03T06:00:00.000Z',
      terminalSn: 'SN-ALEX',
      isDuplicate: true,
    });
    await punch({ employeeId: emp.id, empCode: 'LM007', at: '2026-05-30T06:00:00.000Z', terminalSn: 'SN-ALEX' });
    await punch({ employeeId: emp.id, empCode: 'LM007', at: '2026-06-09T06:00:00.000Z', terminalSn: 'SN-ALEX' });

    expect(await call()).toHaveLength(0);
  });

  it('matches a punch that carries only an employee code', async () => {
    const emp = await seedEmployee({ code: 'LM008', name: 'Code Only', locationId: cairo.id });
    await prisma.device.create({
      data: { name: 'Alex Terminal', serialNumber: 'SN-ALEX', locationId: alex.id },
    });
    await punch({ empCode: 'LM008', at: '2026-06-03T06:00:00.000Z', terminalSn: 'SN-ALEX' });

    const rows = await call();
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeId).toBe(emp.id);
  });

  it('honours the location scope filter', async () => {
    const cairoEmp = await seedEmployee({ code: 'LM009', name: 'Cairo Emp', locationId: cairo.id });
    const alexEmp = await seedEmployee({ code: 'LM010', name: 'Alex Emp', locationId: alex.id });
    await prisma.device.create({
      data: { name: 'Alex Terminal', serialNumber: 'SN-ALEX', locationId: alex.id },
    });
    await prisma.device.create({
      data: { name: 'Cairo Terminal', serialNumber: 'SN-CAIRO', locationId: cairo.id },
    });
    await punch({ employeeId: cairoEmp.id, empCode: 'LM009', at: '2026-06-03T06:00:00.000Z', terminalSn: 'SN-ALEX' });
    await punch({ employeeId: alexEmp.id, empCode: 'LM010', at: '2026-06-03T07:00:00.000Z', terminalSn: 'SN-CAIRO' });

    expect(await call()).toHaveLength(2);
    const onlyCairo = await call({ locationId: cairo.id });
    expect(onlyCairo.map((r) => r.code)).toEqual(['LM009']);
  });

  it('does not leak the report to a non-HR caller', async () => {
    // rbac.test.ts owns the guard matrix; this just proves the export twin is guarded too.
    const res = await rpc(RPC_XLSX, PERIOD, employee.token);
    expect(res.body.result?.success).not.toBe(true);
  });

  describe('Excel export', () => {
    it('puts the wrong device next to the employee location and keeps every column aligned', async () => {
      const emp = await seedEmployee({ code: 'LM100', name: 'Excel Guy', locationId: cairo.id });
      const dept = await prisma.department.create({ data: { name: 'Kitchen' } });
      await prisma.employeeProfile.update({
        where: { id: emp.id },
        data: { departmentId: dept.id, nationalIdConfirm: '29001010101015' },
      });
      await prisma.device.create({
        data: { name: 'Alex Terminal', alias: 'ALX-1', serialNumber: 'SN-ALEX', locationId: alex.id },
      });
      await punch({ employeeId: emp.id, empCode: 'LM100', at: '2026-06-02T06:00:00.000Z', terminalSn: 'SN-ALEX' });
      await punch({ employeeId: emp.id, empCode: 'LM100', at: '2026-06-05T14:45:00.000Z', terminalSn: 'SN-ALEX' });

      const file = expectOk(await rpc(RPC_XLSX, PERIOD, hr.token));
      expect(file.filename).toBe('report_location_mismatch_2026-06-01_2026-06-07.xlsx');
      expect(file.rowCount).toBe(2); // 1 detail row + 1 summary row

      const sheets = await loadSheets(file.base64 as string);
      expect([...sheets.keys()]).toEqual(['بصمة في لوكيشن مختلف', 'ملخص حسب الجهاز']);

      const detail = sheetTable(sheets.get('بصمة في لوكيشن مختلف')!);
      // The point of the recent change: wrong device sits right after employee location.
      expect(detail.headers.slice(0, 7)).toEqual([
        '#',
        'الكود',
        'الاسم',
        'لوكيشن الموظف (المسجّل)',
        'الجهاز اللي الموظف بصم عليه',
        'لوكيشن الجهاز (مكان البصمة)',
        'عدد البصمات في الفترة',
      ]);
      expect(detail.body).toHaveLength(1);

      const r = detail.body[0];
      expect(cell(detail.headers, r, 'الكود')).toBe('LM100');
      expect(cell(detail.headers, r, 'الاسم')).toBe('Excel Guy');
      expect(cell(detail.headers, r, 'لوكيشن الموظف (المسجّل)')).toBe('Cairo Branch');
      expect(cell(detail.headers, r, 'الجهاز اللي الموظف بصم عليه')).toBe('ALX-1');
      expect(cell(detail.headers, r, 'لوكيشن الجهاز (مكان البصمة)')).toBe('Alex Branch');
      expect(cell(detail.headers, r, 'عدد البصمات في الفترة')).toBe('2');
      expect(cell(detail.headers, r, 'الحالة')).toBe('بصم في لوكيشن مختلف');
      expect(cell(detail.headers, r, 'القسم')).toBe('Kitchen');
      expect(cell(detail.headers, r, 'الرقم القومي')).toBe('29001010101015');
      expect(cell(detail.headers, r, 'سيريال الجهاز')).toBe('SN-ALEX');
      expect(cell(detail.headers, r, 'أول بصمة')).toBe('2026-06-02 06:00');
      expect(cell(detail.headers, r, 'آخر بصمة')).toBe('2026-06-05 14:45');
      // No column drifted off the end of the header list.
      expect(r).toHaveLength(detail.headers.length);
    });

    it('summarises per wrong device, not per branch pair', async () => {
      const a = await seedEmployee({ code: 'LM101', name: 'Emp A', locationId: cairo.id });
      const b = await seedEmployee({ code: 'LM102', name: 'Emp B', locationId: cairo.id });
      // Two distinct terminals, both in Alex: must be two summary rows now.
      await prisma.device.create({
        data: { name: 'Alex Gate 1', alias: 'ALX-G1', serialNumber: 'SN-G1', locationId: alex.id },
      });
      await prisma.device.create({
        data: { name: 'Alex Gate 2', alias: 'ALX-G2', serialNumber: 'SN-G2', locationId: alex.id },
      });
      await punch({ employeeId: a.id, empCode: 'LM101', at: '2026-06-02T06:00:00.000Z', terminalSn: 'SN-G1' });
      await punch({ employeeId: a.id, empCode: 'LM101', at: '2026-06-03T06:00:00.000Z', terminalSn: 'SN-G1' });
      await punch({ employeeId: b.id, empCode: 'LM102', at: '2026-06-02T06:00:00.000Z', terminalSn: 'SN-G1' });
      await punch({ employeeId: b.id, empCode: 'LM102', at: '2026-06-04T06:00:00.000Z', terminalSn: 'SN-G2' });

      const file = expectOk(await rpc(RPC_XLSX, PERIOD, hr.token));
      const sheets = await loadSheets(file.base64 as string);
      const summary = sheetTable(sheets.get('ملخص حسب الجهاز')!);

      expect(summary.headers).toEqual([
        '#',
        'لوكيشن الموظف',
        'الجهاز اللي الموظف بصم عليه',
        'لوكيشن الجهاز',
        'عدد الموظفين',
        'إجمالي البصمات',
      ]);
      expect(summary.body).toHaveLength(2);

      const g1 = summary.body.find((row) => cell(summary.headers, row, 'الجهاز اللي الموظف بصم عليه') === 'ALX-G1')!;
      const g2 = summary.body.find((row) => cell(summary.headers, row, 'الجهاز اللي الموظف بصم عليه') === 'ALX-G2')!;
      expect(cell(summary.headers, g1, 'عدد الموظفين')).toBe('2');
      expect(cell(summary.headers, g1, 'إجمالي البصمات')).toBe('3');
      expect(cell(summary.headers, g2, 'عدد الموظفين')).toBe('1');
      expect(cell(summary.headers, g2, 'إجمالي البصمات')).toBe('1');
      // Busiest device first.
      expect(cell(summary.headers, summary.body[0], 'الجهاز اللي الموظف بصم عليه')).toBe('ALX-G1');
    });

    it('writes the empty-state message when nothing is wrong', async () => {
      await seedEmployee({ code: 'LM103', name: 'Clean', locationId: cairo.id });
      const file = expectOk(await rpc(RPC_XLSX, PERIOD, hr.token));
      expect(file.rowCount).toBe(0);
      const sheets = await loadSheets(file.base64 as string);
      const flat = sheets.get('بصمة في لوكيشن مختلف')!.map((r) => r.join('|')).join('\n');
      expect(flat).toContain('لا توجد بصمات في لوكيشن مختلف عن لوكيشن الموظف في الفترة المحددة');
    });
  });
});
