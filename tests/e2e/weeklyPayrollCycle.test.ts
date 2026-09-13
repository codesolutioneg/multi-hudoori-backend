import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ShiftGridState, UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { generateAttendance } from '../../src/services/attendance.service';
import { BioTimeConnector } from '../../src/services/biotime/biotimeConnector.service';
import { expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createShift,
  createUser,
  ensureBioTimeConfig,
  ensureDefaultCompany,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';
import { createMockConnector } from '../mocks/biotime.mock';
import { writeWeeklyPayrollAudit } from '../helpers/weeklyPayrollAudit';

vi.mock('../../src/services/biotime/biotimeConnector.service', () => ({
  BioTimeConnector: { fromDb: vi.fn() },
}));

/** Payroll month 26 → 25 (not 25→26). */
const PERIOD_FROM = '2026-06-26';
const PERIOD_TO = '2026-07-25';

const WEEKS: { name: string; from: string; to: string }[] = [
  { name: 'W1 cycle', from: '2026-06-26', to: '2026-07-02' },
  { name: 'W2 cycle', from: '2026-07-03', to: '2026-07-09' },
  { name: 'W3 cycle', from: '2026-07-10', to: '2026-07-16' },
  { name: 'W4 cycle', from: '2026-07-17', to: '2026-07-25' },
];

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let d = new Date(`${from}T00:00:00.000Z`);
    d <= new Date(`${to}T00:00:00.000Z`);
    d = new Date(d.getTime() + 86400000)
  ) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function buildMockPunches(
  employees: { code: string }[],
): { id: number; emp_code: string; punch_time: string; punch_state: string }[] {
  const rows: { id: number; emp_code: string; punch_time: string; punch_state: string }[] = [];
  let id = 700000;
  for (const day of eachDay(PERIOD_FROM, PERIOD_TO)) {
    for (const emp of employees) {
      // 09:00 / 18:00 Cairo (UTC+3)
      rows.push({
        id: id++,
        emp_code: emp.code,
        punch_time: `${day}T06:00:00`,
        punch_state: '0',
      });
      rows.push({
        id: id++,
        emp_code: emp.code,
        punch_time: `${day}T15:00:00`,
        punch_state: '1',
      });
    }
  }
  return rows;
}

describe('full weekly payroll cycle (DEV, pull-only, never push)', () => {
  let hr: SeededUser;
  let locationId: string;
  let locationCode: string;
  let locationName: string;
  let shiftId: string;
  let employees: { id: string; code: string; name: string }[];

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    await ensureDefaultCompany();
    vi.clearAllMocks();

    const cfg = await prisma.bioTimeConfig.findFirstOrThrow();
    await prisma.bioTimeConfig.update({
      where: { id: cfg.id },
      data: {
        payrollMonthStartDay: 26,
        autoPushToBiotime: false,
        advanceEnforceLimit: false,
        advanceMinimumWorkingDays: 0,
        advanceDefaultPercent: 50,
      },
    });

    hr = await createUser({ login: 'cycle.hr@test.local', role: UserRole.HR_MANAGER });
    const location = await createLocation({ name: 'Baladi Ala', code: 'BAL.ALA' });
    locationId = location.id;
    locationCode = location.code!;
    locationName = location.name;
    const shift = await createShift({
      name: 'Morning 9-18',
      startTime: '09:00',
      endTime: '18:00',
      gracePeriodIn: 15,
      gracePeriodOut: 15,
    });
    shiftId = shift.id;

    employees = [];
    for (let i = 0; i < 3; i++) {
      const code = `WPC0${i + 1}`;
      const emp = await prisma.employeeProfile.create({
        data: {
          name: `Cycle Emp ${i + 1}`,
          code,
          basicSalary: 3000 + i * 500,
          locationId,
        },
      });
      employees.push({ id: emp.id, code, name: emp.name });
      await prisma.shiftAssignment.create({
        data: {
          employeeId: emp.id,
          shiftId,
          dateFrom: new Date('2026-01-01'),
          assignmentType: 'permanent',
          active: true,
        },
      });
    }

    const punches = buildMockPunches(employees);
    const base = createMockConnector();
    vi.mocked(BioTimeConnector.fromDb).mockImplementation(
      async () =>
        ({
          ...base,
          getTransactions: async () => ({ data: punches, next: null }),
        }) as never,
    );
  });

  it('runs weeks → assign → merge/append → pull → attendance → money → payroll + audit', async () => {
    const config = await prisma.bioTimeConfig.findFirstOrThrow();
    // Forbidden in this suite: push-biotime, pushToBiotime, sync-all when autoPush=true
    expect(config.autoPushToBiotime).toBe(false);
    expect(config.payrollMonthStartDay).toBe(26);

    const weekIds: string[] = [];
    for (const week of WEEKS) {
      const created = expectOk(
        await rpc(
          '/api/biotime/shift-grid/create',
          {
            name: week.name,
            dateFrom: week.from,
            dateTo: week.to,
            selectionMethod: 'location',
            locationId,
            generate: true,
          },
          hr.token,
        ),
        `create ${week.name}`,
      );
      weekIds.push((created.grid as { id: string }).id);
    }

    // Assign the morning shift on every cell via bulk row (readable on get).
    for (const gridId of weekIds) {
      for (const emp of employees) {
        expectOk(
          await rpc(
            '/api/biotime/shift-grid/bulk/row',
            { gridId, employeeId: emp.id, cellValue: shiftId },
            hr.token,
          ),
          `assign ${gridId}`,
        );
      }
      const got = expectOk(await rpc('/api/biotime/shift-grid/get', { id: gridId }, hr.token));
      expect(got.grid).toBeDefined();
    }

    const merge = expectOk(
      await rpc(
        '/api/biotime/shift-grid/merge',
        {
          sourceGridIds: weekIds.slice(0, 3),
          periodFrom: PERIOD_FROM,
          periodTo: PERIOD_TO,
          name: 'Monthly cycle merge',
          state: 'grid',
        },
        hr.token,
      ),
      'merge weeks 1-3',
    );
    const monthlyId = String(merge.gridId);
    expect(merge.appended).toBe(false);

    for (const id of weekIds.slice(0, 3)) {
      const src = await prisma.shiftGrid.findUniqueOrThrow({ where: { id } });
      expect(src.mergedIntoGridId).toBe(monthlyId);
    }

    const append = expectOk(
      await rpc(
        '/api/biotime/shift-grid/merge',
        {
          sourceGridIds: [weekIds[3]],
          targetGridId: monthlyId,
          periodFrom: PERIOD_FROM,
          periodTo: PERIOD_TO,
        },
        hr.token,
      ),
      'append week 4',
    );
    expect(append.appended).toBe(true);
    expect(append.gridId).toBe(monthlyId);

    const week4 = await prisma.shiftGrid.findUniqueOrThrow({ where: { id: weekIds[3] } });
    expect(week4.mergedIntoGridId).toBe(monthlyId);

    const monthly = await prisma.shiftGrid.findUniqueOrThrow({ where: { id: monthlyId } });
    expect(monthly.state).toBe(ShiftGridState.grid);
    expect(monthly.dateFrom.toISOString().slice(0, 10)).toBe(PERIOD_FROM);
    expect(monthly.dateTo.toISOString().slice(0, 10)).toBe(PERIOD_TO);

    const lineCount = await prisma.shiftGridLine.count({ where: { gridId: monthlyId } });
    expect(lineCount).toBe(employees.length * eachDay(PERIOD_FROM, PERIOD_TO).length);

    // Pull-only sync route (never push / sync-all with auto-push).
    const pull = expectOk(
      await rpc(
        '/api/biotime/config/sync-transactions',
        { dateFrom: PERIOD_FROM, dateTo: PERIOD_TO },
        hr.token,
      ),
      'sync-transactions pull',
    );
    expect(Number(pull.count)).toBeGreaterThan(0);
    const punchCount = await prisma.transaction.count();
    expect(punchCount).toBe(employees.length * eachDay(PERIOD_FROM, PERIOD_TO).length * 2);

    const attendance = await generateAttendance({
      dateFrom: new Date(`${PERIOD_FROM}T00:00:00.000Z`),
      dateTo: new Date(`${PERIOD_TO}T00:00:00.000Z`),
      shiftGridId: monthlyId,
      employeeIds: employees.map((e) => e.id),
    });
    expect(attendance.created + attendance.updated).toBeGreaterThan(0);

    const advanceTargets = employees.slice(0, 2);
    const advances: { employeeCode: string; amount: number }[] = [];
    for (const emp of advanceTargets) {
      const amount = emp.code === 'WPC01' ? 400 : 250;
      expectOk(
        await rpc(
          '/api/biotime/advances/short/create',
          { employeeId: emp.id, amount, date: '2026-07-05' },
          hr.token,
        ),
        `advance ${emp.code}`,
      );
      advances.push({ employeeCode: emp.code, amount });
    }

    const deductionTargets = employees.slice(0, 2);
    const deductions: { employeeCode: string; amount: number; type: string }[] = [];
    for (const emp of deductionTargets) {
      const amount = emp.code === 'WPC01' ? 100 : 75;
      expectOk(
        await rpc(
          '/api/biotime/deductions/create',
          { employeeId: emp.id, type: 'fines', amount, date: '2026-07-08' },
          hr.token,
        ),
        `deduction ${emp.code}`,
      );
      deductions.push({ employeeCode: emp.code, amount, type: 'fines' });
    }

    const createdPay = expectOk(
      await rpc('/api/biotime/payroll/create', { shiftGridId: monthlyId }, hr.token),
      'payroll create from merged grid',
    );
    const payrollId = (createdPay.payroll as { id: string }).id;

    const calc = expectOk(
      await rpc('/api/biotime/payroll/calculate', { id: payrollId }, hr.token),
      'payroll calculate',
    );
    expectOk(await rpc('/api/biotime/payroll/link-deductions', { id: payrollId }, hr.token));

    const payroll = (calc.payroll as { lines: Record<string, unknown>[] }) ??
      ((await prisma.payroll.findUniqueOrThrow({
        where: { id: payrollId },
        include: { lines: true },
      })) as unknown as { lines: Record<string, unknown>[] });

    const lines =
      (await prisma.payrollLine.findMany({
        where: { payrollId },
        include: { employee: true },
      })) ?? [];
    expect(lines.length).toBe(employees.length);

    const totals = lines.map((line) => {
      const code = line.employeeCode || line.employee?.code || '';
      expect(Number(line.workingDays)).toBeGreaterThan(0);
      if (code === 'WPC01' || code === 'WPC02') {
        expect(Number(line.advanceShortTotal)).toBeGreaterThan(0);
        expect(Number(line.fines)).toBeGreaterThan(0);
      }
      expect(Number(line.netSalary)).toBeLessThan(Number(line.grossSalary) + 0.01);
      return {
        employeeCode: code,
        net: Number(line.netSalary),
        advanceShort: Number(line.advanceShortTotal),
        fines: Number(line.fines),
      };
    });

    const auditPath = writeWeeklyPayrollAudit({
      period: { from: PERIOD_FROM, to: PERIOD_TO },
      location: { id: locationId, name: locationName, code: locationCode },
      employees,
      weeklyGrids: WEEKS.map((w, i) => ({
        id: weekIds[i],
        name: w.name,
        from: w.from,
        to: w.to,
      })),
      merge: {
        monthlyGridId: monthlyId,
        sourceIds: weekIds.slice(0, 3),
        appendedGridId: weekIds[3],
        lineCount,
      },
      punches: { count: punchCount, via: 'config/sync-transactions (mocked connector)' },
      attendance: { createdOrUpdated: attendance.created + attendance.updated },
      money: { advances, deductions },
      payroll: { id: payrollId, lineCount: lines.length, totals },
      extraSections: [
        {
          title: 'Hard guards',
          lines: [
            '- autoPushToBiotime=false',
            '- No push-biotime / pushToBiotime / sync-all with auto-push invoked',
          ],
        },
      ],
    });

    // eslint-disable-next-line no-console
    console.log(`weekly payroll cycle audit: ${auditPath}`);
    expect(payroll).toBeTruthy();
  }, 120_000);
});
