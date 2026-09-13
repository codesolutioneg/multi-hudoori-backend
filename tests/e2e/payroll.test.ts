import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PayrollState, UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { createShift, createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';

const PERIOD_FROM = '2026-06-01';
const PERIOD_TO = '2026-06-30';

async function seedPunchedEmployee(opts: { code: string; name: string; basicSalary?: number }) {
  const employee = await prisma.employeeProfile.create({
    data: {
      name: opts.name,
      code: opts.code,
      basicSalary: opts.basicSalary ?? 3000,
      insuranceSalary: 0,
      medicalInsuranceSalary: 0,
    },
  });
  const shift = await createShift({ name: `Shift ${opts.code}` });
  await prisma.shiftAssignment.create({
    data: {
      employeeId: employee.id,
      shiftId: shift.id,
      dateFrom: new Date('2026-01-01'),
      assignmentType: 'permanent',
      active: true,
    },
  });

  // Two punches every day of the period, so the employee is not mass-absent.
  const rows: { employeeId: string; empCode: string; biotimeTransactionId: number; punchTime: Date; punchState: string }[] = [];
  let txId = Math.floor(Math.random() * 100000) + 500000;
  for (let d = 1; d <= 30; d++) {
    const day = String(d).padStart(2, '0');
    rows.push({
      employeeId: employee.id,
      empCode: opts.code,
      biotimeTransactionId: txId++,
      punchTime: new Date(`2026-06-${day}T05:00:00.000Z`), // 08:00 Cairo
      punchState: '0',
    });
    rows.push({
      employeeId: employee.id,
      empCode: opts.code,
      biotimeTransactionId: txId++,
      punchTime: new Date(`2026-06-${day}T14:00:00.000Z`), // 17:00 Cairo
      punchState: '1',
    });
  }
  await prisma.transaction.createMany({ data: rows });
  return { employee, shift };
}

describe('payroll lifecycle', () => {
  let hr: SeededUser;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hr = await createUser({ login: 'hr@test.local', role: UserRole.HR_MANAGER });
  });

  describe('create', () => {
    it('creates a draft payroll for an explicit period', async () => {
      const data = expectOk(
        await rpc('/api/biotime/payroll/create', { dateFrom: PERIOD_FROM, dateTo: PERIOD_TO }, hr.token),
      );
      const payroll = data.payroll as Record<string, unknown>;
      expect(payroll.state).toBe(PayrollState.draft);
      expect(payroll.name).toContain(PERIOD_FROM);
    });

    it('accepts a custom name', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/payroll/create',
          { dateFrom: PERIOD_FROM, dateTo: PERIOD_TO, name: 'June salaries' },
          hr.token,
        ),
      );
      expect((data.payroll as { name: string }).name).toBe('June salaries');
    });

    it('inherits the period from a shift grid', async () => {
      const grid = await prisma.shiftGrid.create({
        data: { name: 'June grid', dateFrom: new Date(PERIOD_FROM), dateTo: new Date(PERIOD_TO) },
      });
      const data = expectOk(
        await rpc('/api/biotime/payroll/create', { shiftGridId: grid.id }, hr.token),
      );
      const payroll = data.payroll as { dateFrom: string; dateTo: string };
      expect(String(payroll.dateFrom)).toContain(PERIOD_FROM);
      expect(String(payroll.dateTo)).toContain(PERIOD_TO);
    });

    it('rejects a payroll with no period', async () => {
      const res = await rpc('/api/biotime/payroll/create', {}, hr.token);
      expectFail(res);
    });

    it('rejects the literal string "undefined" as a date', async () => {
      expectFail(
        await rpc('/api/biotime/payroll/create', { dateFrom: 'undefined', dateTo: 'undefined' }, hr.token),
      );
    });

    it('fails for an unknown shift grid', async () => {
      expectFail(await rpc('/api/biotime/payroll/create', { shiftGridId: 'nope' }, hr.token));
    });
  });

  describe('calculate', () => {
    it('produces one line per punched employee with money totals', async () => {
      await seedPunchedEmployee({ code: 'P100', name: 'Payroll One', basicSalary: 3000 });
      const created = expectOk(
        await rpc('/api/biotime/payroll/create', { dateFrom: PERIOD_FROM, dateTo: PERIOD_TO }, hr.token),
      );
      const payrollId = (created.payroll as { id: string }).id;

      const calc = expectOk(await rpc('/api/biotime/payroll/calculate', { id: payrollId }, hr.token), 'calculate');
      const payroll = calc.payroll as { state: string; lines: Record<string, unknown>[] };
      expect(payroll.state).toBe(PayrollState.calculated);
      expect(payroll.lines.length).toBe(1);

      const line = payroll.lines[0];
      expect(line.basicSalary).toBe(3000);
      expect(Number(line.netSalary)).toBeGreaterThan(0);
      expect(Number(line.grossSalary)).toBeGreaterThan(0);
    });

    it('keeps header totals in step with the lines', async () => {
      await seedPunchedEmployee({ code: 'P200', name: 'Payroll Two' });
      const created = expectOk(
        await rpc('/api/biotime/payroll/create', { dateFrom: PERIOD_FROM, dateTo: PERIOD_TO }, hr.token),
      );
      const payrollId = (created.payroll as { id: string }).id;
      await rpc('/api/biotime/payroll/calculate', { id: payrollId }, hr.token);
      await rpc('/api/biotime/payroll/link-deductions', { id: payrollId }, hr.token);

      const header = await prisma.payroll.findUniqueOrThrow({ where: { id: payrollId } });
      const lines = await prisma.payrollLine.findMany({ where: { payrollId } });
      const sumNet = Math.round(lines.reduce((s, l) => s + l.netSalary, 0) * 100) / 100;
      expect(header.totalNet).toBeCloseTo(sumNet, 2);
    });

    it('fails when the period holds no punch data', async () => {
      const created = expectOk(
        await rpc('/api/biotime/payroll/create', { dateFrom: '2020-01-01', dateTo: '2020-01-31' }, hr.token),
      );
      const res = await rpc(
        '/api/biotime/payroll/calculate',
        { id: (created.payroll as { id: string }).id },
        hr.token,
      );
      expectFail(res, 'ACTION_ERROR');
    });

    it('is idempotent: recalculating does not duplicate lines', async () => {
      await seedPunchedEmployee({ code: 'P300', name: 'Payroll Three' });
      const created = expectOk(
        await rpc('/api/biotime/payroll/create', { dateFrom: PERIOD_FROM, dateTo: PERIOD_TO }, hr.token),
      );
      const payrollId = (created.payroll as { id: string }).id;
      await rpc('/api/biotime/payroll/calculate', { id: payrollId }, hr.token);
      await rpc('/api/biotime/payroll/calculate', { id: payrollId }, hr.token);
      expect(await prisma.payrollLine.count({ where: { payrollId } })).toBe(1);
    });
  });

  describe('state machine', () => {
    let payrollId: string;

    beforeEach(async () => {
      await seedPunchedEmployee({ code: 'P400', name: 'Payroll Four' });
      const created = expectOk(
        await rpc('/api/biotime/payroll/create', { dateFrom: PERIOD_FROM, dateTo: PERIOD_TO }, hr.token),
      );
      payrollId = (created.payroll as { id: string }).id;
      await rpc('/api/biotime/payroll/calculate', { id: payrollId }, hr.token);
    });

    it('goes back to draft from calculated', async () => {
      const data = expectOk(await rpc('/api/biotime/payroll/back-to-draft', { id: payrollId }, hr.token));
      expect((data.payroll as { state: string }).state).toBe(PayrollState.draft);
    });

    it('refuses back-to-draft from draft', async () => {
      await rpc('/api/biotime/payroll/back-to-draft', { id: payrollId }, hr.token);
      expectFail(await rpc('/api/biotime/payroll/back-to-draft', { id: payrollId }, hr.token), 'ACTION_ERROR');
    });

    it('confirms a calculated payroll', async () => {
      const data = expectOk(await rpc('/api/biotime/payroll/confirm', { id: payrollId }, hr.token));
      expect((data.payroll as { state: string }).state).toBe(PayrollState.confirmed);
    });

    it('refuses to recalculate a confirmed payroll', async () => {
      await rpc('/api/biotime/payroll/confirm', { id: payrollId }, hr.token);
      expectFail(await rpc('/api/biotime/payroll/calculate', { id: payrollId }, hr.token), 'ACTION_ERROR');
    });

    it('refuses to add an employee to a confirmed payroll', async () => {
      await rpc('/api/biotime/payroll/confirm', { id: payrollId }, hr.token);
      const other = await prisma.employeeProfile.create({ data: { name: 'Late Joiner', code: 'P401' } });
      expectFail(
        await rpc(
          '/api/biotime/payroll/calculate-single-employee',
          { id: payrollId, employeeId: other.id },
          hr.token,
        ),
      );
    });

    it('rejects adding an employee already on the payroll', async () => {
      const line = await prisma.payrollLine.findFirstOrThrow({ where: { payrollId } });
      expectFail(
        await rpc(
          '/api/biotime/payroll/calculate-single-employee',
          { id: payrollId, employeeId: line.employeeId },
          hr.token,
        ),
      );
    });
  });

  describe('lines and reads', () => {
    let payrollId: string;
    let lineId: string;

    beforeEach(async () => {
      await seedPunchedEmployee({ code: 'P500', name: 'Payroll Five' });
      const created = expectOk(
        await rpc('/api/biotime/payroll/create', { dateFrom: PERIOD_FROM, dateTo: PERIOD_TO }, hr.token),
      );
      payrollId = (created.payroll as { id: string }).id;
      await rpc('/api/biotime/payroll/calculate', { id: payrollId }, hr.token);
      lineId = (await prisma.payrollLine.findFirstOrThrow({ where: { payrollId } })).id;
    });

    it('lists payrolls with pagination', async () => {
      const data = expectOk(await rpc('/api/biotime/payroll/list', { limit: 10 }, hr.token));
      expect((data.payrolls as unknown[]).length).toBeGreaterThan(0);
    });

    it('gets a payroll with paginated lines', async () => {
      const data = expectOk(
        await rpc('/api/biotime/payroll/get', { id: payrollId, lineLimit: 1, lineOffset: 0 }, hr.token),
      );
      const payroll = data.payroll as { lines: unknown[] };
      expect(payroll.lines.length).toBe(1);
    });

    it('fails for an unknown payroll id', async () => {
      expectFail(await rpc('/api/biotime/payroll/get', { id: 'missing' }, hr.token));
    });

    it('recomputes totals when a manual deduction is edited', async () => {
      const before = await prisma.payrollLine.findUniqueOrThrow({ where: { id: lineId } });
      expectOk(
        await rpc('/api/biotime/payroll/line/update', { id: lineId, fines: 250 }, hr.token),
        'line/update',
      );
      const after = await prisma.payrollLine.findUniqueOrThrow({ where: { id: lineId } });
      expect(after.fines).toBe(250);
      expect(after.totalDeductions).toBeCloseTo(before.totalDeductions + 250, 2);
      expect(after.netSalary).toBeCloseTo(before.netSalary - 250, 2);
    });

    it('keeps net salary at or above zero when deductions exceed earnings', async () => {
      await rpc('/api/biotime/payroll/line/update', { id: lineId, manualDebit: 999999 }, hr.token);
      const after = await prisma.payrollLine.findUniqueOrThrow({ where: { id: lineId } });
      expect(after.netSalary).toBe(0);
    });

    it('reports no duplicates for a clean payroll', async () => {
      const data = expectOk(await rpc('/api/biotime/payroll/check-duplicates', { id: payrollId }, hr.token));
      expect(data.count).toBe(0);
    });

    it('exposes the payslip detail to the owning employee', async () => {
      const line = await prisma.payrollLine.findUniqueOrThrow({ where: { id: lineId } });
      const employeeUser = await createUser({ login: 'own@test.local', role: UserRole.EMPLOYEE });
      await prisma.employeeProfile.update({
        where: { id: line.employeeId },
        data: { userId: employeeUser.userId },
      });
      await rpc('/api/biotime/payroll/confirm', { id: payrollId }, hr.token);

      const data = expectOk(await rpc('/api/biotime/payroll/my', {}, employeeUser.token));
      expect((data.records as unknown[]).length).toBeGreaterThan(0);
      expect(data.count).toBeGreaterThan(0);
    });
  });

  describe('archived employees', () => {
    it('prorates pay up to the archive date', async () => {
      const { employee } = await seedPunchedEmployee({ code: 'P600', name: 'Mid Month Leaver' });
      await prisma.employeeProfile.update({
        where: { id: employee.id },
        data: {
          active: false,
          archivedAt: new Date('2026-06-05T00:00:00.000Z'),
          departureDate: new Date('2026-06-05T00:00:00.000Z'),
          archiveReason: 'resigned',
        },
      });

      const created = expectOk(
        await rpc('/api/biotime/payroll/create', { dateFrom: PERIOD_FROM, dateTo: PERIOD_TO }, hr.token),
      );
      const payrollId = (created.payroll as { id: string }).id;
      expectOk(await rpc('/api/biotime/payroll/calculate', { id: payrollId }, hr.token), 'calculate');

      const line = await prisma.payrollLine.findFirst({ where: { payrollId } });
      expect(line?.daysCount).toBe(5);
    });

    it('omits an employee archived before the period', async () => {
      const { employee } = await seedPunchedEmployee({ code: 'P700', name: 'Early Leaver' });
      await seedPunchedEmployee({ code: 'P701', name: 'Still Here' });
      await prisma.employeeProfile.update({
        where: { id: employee.id },
        data: {
          active: false,
          archivedAt: new Date('2026-05-01T00:00:00.000Z'),
          departureDate: new Date('2026-05-01T00:00:00.000Z'),
          archiveReason: 'resigned',
        },
      });

      const created = expectOk(
        await rpc('/api/biotime/payroll/create', { dateFrom: PERIOD_FROM, dateTo: PERIOD_TO }, hr.token),
      );
      const payrollId = (created.payroll as { id: string }).id;
      await rpc('/api/biotime/payroll/calculate', { id: payrollId }, hr.token);

      const codes = (await prisma.payrollLine.findMany({ where: { payrollId } })).map((l) => l.employeeCode);
      expect(codes).not.toContain('P700');
      expect(codes).toContain('P701');
    });
  });
});
