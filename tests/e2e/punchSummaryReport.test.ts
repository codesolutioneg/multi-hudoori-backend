import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { UserRole } from '@prisma/client';
import { expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createShift,
  createUser,
  ensureBioTimeConfig,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';
import { prisma } from '../../src/prisma/client';
import {
  computeEmployeeSummary,
  generatePunchReportLines,
  getSummaryPeriodDays,
} from '../../src/services/punchReportLine.service';
import { getLatePolicy } from '../../src/services/latePolicy.service';

const RPC = '/api/biotime/reports/punch-summary';
const RPC_XLSX = `${RPC}/export-xlsx`;
const RPC_SYNC = '/api/biotime/reports/punch-report/sync-start';
const PERIOD = { dateFrom: '2026-06-01', dateTo: '2026-06-07' };

type Row = {
  employeeId: string;
  code: string;
  name: string;
  locationName: string;
  departmentName: string;
  workingDays: number;
  earnedLeaveCapped: number;
  actualWorkingDays: number;
  singlePunch: number;
  punchDeduction: number;
  absentCount: number;
  adminPenalty: number;
  overtime: number;
  lateDeduction: number;
  earlyDeduction: number;
  sickDayCount: number;
  sickDeduction: number;
  totalPenalties: number;
  measured: boolean;
};

let txSeq = 950000;

function at(day: string, time: string): Date {
  return new Date(`${day}T${time}:00.000Z`);
}

async function punch(employeeId: string, code: string, when: Date, state: '0' | '1') {
  return prisma.transaction.create({
    data: {
      employeeId,
      empCode: code,
      biotimeTransactionId: txSeq++,
      punchTime: when,
      punchState: state,
      terminalSn: 'PS-SN-1',
    },
  });
}

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

function cell(headers: string[], row: string[], header: string): string {
  const i = headers.indexOf(header);
  if (i < 0) throw new Error(`header not found: ${header}`);
  return row[i] ?? '';
}

describe('punch summary report (ملخص البصمات)', () => {
  let hr: SeededUser;
  let cairo: { id: string; name: string };
  let alex: { id: string; name: string };
  let kitchen: { id: string };
  let shiftId: string;
  let gridId: string;

  beforeAll(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    hr = await createUser({ role: UserRole.HR_MANAGER, login: 'punchsummary.hr@test.bio' });
  });

  beforeEach(async () => {
    await prisma.syncJob.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.shiftGridLine.deleteMany();
    await prisma.shiftGrid.deleteMany();
    await prisma.shiftAssignment.deleteMany();
    await prisma.employeeProfile.deleteMany({ where: { userId: null } });
    await prisma.department.deleteMany();
    await prisma.shift.deleteMany();
    await prisma.location.deleteMany();

    cairo = await createLocation({ name: 'Cairo Branch', code: 'CAI' });
    alex = await createLocation({ name: 'Alex Branch', code: 'ALX' });
    kitchen = await prisma.department.create({ data: { name: 'Kitchen', code: 'D-KIT' } });
    const shift = await createShift({ name: 'Day', startTime: '08:00', endTime: '17:00' });
    shiftId = shift.id;
    const grid = await prisma.shiftGrid.create({
      data: {
        name: 'June week 1',
        dateFrom: new Date('2026-06-01'),
        dateTo: new Date('2026-06-07'),
      },
    });
    gridId = grid.id;
  });

  async function seedEmployee(opts: {
    code: string;
    name: string;
    locationId: string;
    departmentId?: string;
  }) {
    return prisma.employeeProfile.create({
      data: {
        name: opts.name,
        code: opts.code,
        locationId: opts.locationId,
        departmentId: opts.departmentId ?? kitchen.id,
        basicSalary: 6000,
      },
    });
  }

  /** One scheduled day on the grid, so the line is not treated as unscheduled. */
  async function scheduleDay(employeeId: string, day: string, overrides = {}) {
    return prisma.shiftGridLine.create({
      data: {
        gridId,
        employeeId,
        date: new Date(`${day}T00:00:00.000Z`),
        shiftId,
        ...overrides,
      },
    });
  }

  async function call(params: Record<string, unknown> = {}): Promise<Row[]> {
    const data = expectOk(
      await rpc(RPC, { ...PERIOD, locationId: cairo.id, ...params }, hr.token),
    );
    return data.rows as Row[];
  }

  /**
   * The report itself never pulls from BioTime — that is a separate job the screen
   * waits on — so a period already covered by a recent sync must not queue one.
   */
  it('skips the punch sync when the period was synced recently', async () => {
    const now = new Date();
    await prisma.syncJob.create({
      data: {
        jobType: 'transaction_range',
        status: 'done',
        progress: 100,
        message: JSON.stringify({ ...PERIOD, locationId: cairo.id }),
        startedAt: now,
        finishedAt: now,
      },
    });

    const data = expectOk(
      await rpc(RPC_SYNC, { ...PERIOD, locationId: cairo.id }, hr.token),
    );
    expect(data.queued).toBe(false);
    expect(data.fresh).toBe(true);
  });

  it('returns one row per employee with the summary numbers', async () => {
    const emp = await seedEmployee({ code: 'PS001', name: 'Punchy', locationId: cairo.id });
    for (const day of ['2026-06-01', '2026-06-02', '2026-06-03']) {
      await scheduleDay(emp.id, day);
      await punch(emp.id, 'PS001', at(day, '08:00'), '0');
      await punch(emp.id, 'PS001', at(day, '17:00'), '1');
    }

    const rows = await call();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      employeeId: emp.id,
      code: 'PS001',
      name: 'Punchy',
      locationName: 'Cairo Branch',
      departmentName: 'Kitchen',
      workingDays: 3,
      actualWorkingDays: 3,
    });
  });

  /**
   * The whole point of the report: it must not recompute anything. If these
   * numbers ever drift from computeEmployeeSummary, the screen and the
   * punch-report Excel would disagree with each other and with Odoo.
   */
  it('agrees exactly with computeEmployeeSummary for the same data', async () => {
    const emp = await seedEmployee({ code: 'PS002', name: 'Mixed Bag', locationId: cairo.id });
    // A clean day, a late day, a single-punch day, an absent scheduled day.
    await scheduleDay(emp.id, '2026-06-01');
    await punch(emp.id, 'PS002', at('2026-06-01', '08:00'), '0');
    await punch(emp.id, 'PS002', at('2026-06-01', '18:30'), '1');

    await scheduleDay(emp.id, '2026-06-02');
    await punch(emp.id, 'PS002', at('2026-06-02', '09:05'), '0');
    await punch(emp.id, 'PS002', at('2026-06-02', '17:00'), '1');

    await scheduleDay(emp.id, '2026-06-03');
    await punch(emp.id, 'PS002', at('2026-06-03', '08:00'), '0');

    await scheduleDay(emp.id, '2026-06-04');

    const rows = await call();
    expect(rows).toHaveLength(1);

    const lines = await generatePunchReportLines({
      dateFrom: new Date('2026-06-01'),
      dateTo: new Date('2026-06-07'),
      employeeIds: [emp.id],
    });
    const expected = computeEmployeeSummary(
      lines,
      getSummaryPeriodDays(new Date('2026-06-01'), new Date('2026-06-07')),
      0,
      await getLatePolicy(),
    );

    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      expect(rows[0][key], `summary field ${key} drifted`).toBe(expected[key]);
    }
    // A line exists for every day in the period whether punched or not, which is
    // exactly why the report reports no per-line counts of its own.
    expect(lines.length).toBeGreaterThan(3);
  });

  it('counts a scheduled day with no punches as an absence', async () => {
    const emp = await seedEmployee({ code: 'PS003', name: 'Absent Guy', locationId: cairo.id });
    // 2026-06-01 is a Monday → single weight in the Odoo weekday rule.
    await scheduleDay(emp.id, '2026-06-01');

    const rows = await call();
    expect(rows[0].absentCount).toBe(1);
    expect(rows[0].workingDays).toBe(0);
    expect(rows[0].totalPenalties).toBeGreaterThan(0);
  });

  it('honours the location and department scope filters', async () => {
    const cairoEmp = await seedEmployee({ code: 'PS004', name: 'Cairo Emp', locationId: cairo.id });
    const alexEmp = await seedEmployee({ code: 'PS005', name: 'Alex Emp', locationId: alex.id });
    const service = await prisma.department.create({ data: { name: 'Service', code: 'D-SRV' } });
    const otherDept = await seedEmployee({
      code: 'PS006',
      name: 'Service Emp',
      locationId: cairo.id,
      departmentId: service.id,
    });
    for (const e of [cairoEmp, alexEmp, otherDept]) {
      await scheduleDay(e.id, '2026-06-01');
      await punch(e.id, e.code!, at('2026-06-01', '08:00'), '0');
      await punch(e.id, e.code!, at('2026-06-01', '17:00'), '1');
    }

    expect((await call()).map((r) => r.code).sort()).toEqual([
      'PS004',
      'PS006',
    ]);
    expect((await call({ departmentId: service.id })).map((r) => r.code)).toEqual(['PS006']);
  });

  it('reports an employee with no punches as an all-zero row, not a missing one', async () => {
    const punched = await seedEmployee({ code: 'PS007', name: 'Has Punches', locationId: cairo.id });
    await seedEmployee({ code: 'PS008', name: 'Never Punched', locationId: cairo.id });
    await scheduleDay(punched.id, '2026-06-01');
    await punch(punched.id, 'PS007', at('2026-06-01', '08:00'), '0');
    await punch(punched.id, 'PS007', at('2026-06-01', '17:00'), '1');

    const all = await call();
    expect(all.map((r) => r.code).sort()).toEqual(['PS007', 'PS008']);
    // Nothing scheduled and nothing punched, so there is nothing to charge for.
    expect(all.find((r) => r.code === 'PS008')).toMatchObject({
      workingDays: 0,
      absentCount: 0,
      totalPenalties: 0,
    });
  });

  it('still reports an inactive-but-not-archived employee the scope selected', async () => {
    const emp = await seedEmployee({ code: 'PS009', name: 'Inactive Guy', locationId: cairo.id });
    await prisma.employeeProfile.update({ where: { id: emp.id }, data: { active: false } });
    await scheduleDay(emp.id, '2026-06-01');
    await punch(emp.id, 'PS009', at('2026-06-01', '08:00'), '0');
    await punch(emp.id, 'PS009', at('2026-06-01', '17:00'), '1');

    // The population is chosen by the scope filters; the line generator must not
    // re-filter on `active` and hand back an all-zero row.
    const row = (await call()).find((r) => r.code === 'PS009')!;
    expect(row.workingDays).toBe(1);
  });

  it('sorts employees by name within the required branch', async () => {
    const b = await seedEmployee({ code: 'PS010', name: 'Beta', locationId: alex.id });
    const a = await seedEmployee({ code: 'PS011', name: 'Alpha', locationId: alex.id });
    const c = await seedEmployee({ code: 'PS012', name: 'Gamma', locationId: cairo.id });
    for (const e of [a, b, c]) await scheduleDay(e.id, '2026-06-01');

    const rows = await call({ locationId: alex.id });
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Beta']);
  });

  /**
   * generatePunchReportLines keys every line by the attendance code, so an
   * employee without one gets no lines at all. The all-zero row that produces
   * must not read as a clean attendance record.
   */
  it('flags a scheduled employee who has no attendance code as unmeasured', async () => {
    const coded = await seedEmployee({ code: 'PS020', name: 'Coded', locationId: cairo.id });
    const bare = await prisma.employeeProfile.create({
      data: { name: 'No Code At All', locationId: cairo.id, departmentId: kitchen.id },
    });
    await scheduleDay(coded.id, '2026-06-01');
    await scheduleDay(bare.id, '2026-06-01');

    const rows = await call();
    const codedRow = rows.find((r) => r.name === 'Coded')!;
    const bareRow = rows.find((r) => r.name === 'No Code At All')!;

    expect(codedRow.measured).toBe(true);
    expect(codedRow.absentCount).toBe(1);

    // Same scheduled day, but nothing could be matched to them.
    expect(bareRow.measured).toBe(false);
    // Every figure has to be zero: the day counts are otherwise derived from the
    // period length, which would invent an attendance record out of nothing.
    for (const [key, value] of Object.entries(bareRow)) {
      if (typeof value === 'number') expect(value, `${key} should be zero`).toBe(0);
    }
  });

  /**
   * The punch report omits an inactive employee with no punches, matching Odoo.
   * Their scheduled absence therefore cannot be counted, so the row has to say
   * it was not measured instead of reporting a clean zero.
   */
  it('flags an inactive employee with a schedule but no punches as unmeasured', async () => {
    const emp = await seedEmployee({ code: 'PS030', name: 'Inactive Silent', locationId: cairo.id });
    await prisma.employeeProfile.update({ where: { id: emp.id }, data: { active: false } });
    await scheduleDay(emp.id, '2026-06-01');

    const row = (await call()).find((r) => r.code === 'PS030')!;
    expect(row.measured).toBe(false);
    expect(row.actualWorkingDays).toBe(0);
    expect(row.earnedLeaveCapped).toBe(0);
  });

  it('measures a barcode-only employee', async () => {
    // The الكود column ignores barcode but the attendance pipeline does not, so
    // an empty code cell must not be read as an unmeasurable employee.
    await prisma.employeeProfile.create({
      data: { name: 'Barcode Only', barcode: 'BC-900', locationId: cairo.id, departmentId: kitchen.id },
    });
    await scheduleDay((await prisma.employeeProfile.findFirstOrThrow({ where: { barcode: 'BC-900' } })).id, '2026-06-01');
    const row = (await call()).find((r) => r.name === 'Barcode Only')!;
    expect(row.measured).toBe(true);
  });

  it('rejects a request with no period', async () => {
    const res = await rpc(RPC, {}, hr.token);
    expect(res.body.result?.success).toBe(false);
  });

  it('requires a branch', async () => {
    const res = await rpc(RPC, PERIOD, hr.token);
    expect(res.body.result?.success).toBe(false);
  });

  describe('Excel export', () => {
    it('writes the exact shift-grid punch-report workbook schema', async () => {
      const emp = await seedEmployee({ code: 'PS100', name: 'Excel Guy', locationId: cairo.id });
      await scheduleDay(emp.id, '2026-06-01');
      await punch(emp.id, 'PS100', at('2026-06-01', '09:05'), '0');
      await punch(emp.id, 'PS100', at('2026-06-01', '18:30'), '1');

      const file = expectOk(
        await rpc(RPC_XLSX, { ...PERIOD, locationId: cairo.id }, hr.token),
      );
      expect(file.filename).toBe('punch_report_2026-06-01_2026-06-07.xlsx');

      const sheets = await loadSheets(file.base64 as string);
      expect([...sheets.keys()]).toEqual([
        'تقرير البصمات',
        '_meta',
        'تفاصيل الحسابات',
      ]);
      const table = sheetTable(sheets.get('تقرير البصمات')!);
      expect(table.headers).toEqual([
        '#',
        'اسم الموظف',
        'الوظيفة',
        'كود الموظف',
        'التاريخ',
        'اليوم',
        'الشيفت',
        'وقت الحضور',
        'وقت الانصراف',
        'الحضور المتوقع',
        'الانصراف المتوقع',
        'إذن',
        'تأخير الحضور',
        'انصراف مبكر',
        'صافي الساعات',
        'الجهاز',
        'Line ID',
      ]);
      const employeeRow = table.body.find(
        (row) => cell(table.headers, row, 'كود الموظف') === 'PS100',
      );
      expect(employeeRow).toBeDefined();
      expect(cell(table.headers, employeeRow!, 'اسم الموظف')).toBe('Excel Guy');
    });

    it('rejects export when the selected branch has no employees', async () => {
      const res = await rpc(
        RPC_XLSX,
        { ...PERIOD, locationId: alex.id },
        hr.token,
      );
      expect(res.body.result?.success).toBe(false);
    });
  });
});
