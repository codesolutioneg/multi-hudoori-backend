import { describe, it, expect, beforeEach } from 'vitest';
import { PayrollState, RequestState, UserRole } from '@prisma/client';
import { prisma, prismaBase } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import {
  createShift,
  createUser,
  ensureBioTimeConfig,
  resetDatabase,
  seedShiftGridForEmployee,
  type SeededUser,
} from '../helpers/db';
import { addUtcDays, utcDateOnly } from '../../src/utils/payrollPeriod';
import { getOpenCycle } from '../../src/services/payrollCycleGuard.service';
import { getEmployeeLeaveSummary } from '../../src/services/employeeLeave.service';

function dayAfter(iso: string): string {
  return addUtcDays(utcDateOnly(new Date(`${iso}T00:00:00.000Z`)), 1).toISOString().slice(0, 10);
}

function dayBefore(iso: string): string {
  return addUtcDays(utcDateOnly(new Date(`${iso}T00:00:00.000Z`)), -1).toISOString().slice(0, 10);
}

describe('mobile employee ↔ HR request cycle', () => {
  let hr: SeededUser;
  let employee: SeededUser;
  let shiftId: string;
  let cycle: { dateFrom: string; dateTo: string; payrollMonthStartDay: number };
  let inCycleDay: string;
  let inCycleDay2: string;
  let afterCycleDay: string;

  beforeEach(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    hr = await createUser({ login: 'hr-cycle@test.local', role: UserRole.HR_MANAGER });
    employee = await createUser({
      login: 'emp-cycle@test.local',
      role: UserRole.EMPLOYEE,
      withEmployeeProfile: true,
      employee: { code: 'CYC1', name: 'Cycle Emp' },
    });
    await prismaBase.employeeProfile.update({
      where: { id: employee.employeeId! },
      data: { leaveStartingBalance: 21 },
    });
    await prismaBase.bioTimeConfig.updateMany({
      where: { companyId: employee.companyId },
      data: { payrollMonthStartDay: 1 },
    });
    const shift = await createShift({ name: 'Day', code: 'DAY' });
    shiftId = shift.id;

    cycle = await getOpenCycle();
    inCycleDay = cycle.dateFrom;
    inCycleDay2 = dayAfter(cycle.dateFrom);
    afterCycleDay = dayAfter(cycle.dateTo);

    // Cover open cycle + one day into the next cycle (for spanning leave).
    await seedShiftGridForEmployee({
      companyId: employee.companyId,
      employeeId: employee.employeeId!,
      dateFrom: cycle.dateFrom,
      dateTo: afterCycleDay,
      shiftId,
    });
  });

  it('employee creates leave; HR approve sets annual leave on grid', async () => {
    const created = expectOk(
      await rpc(
        '/api/biotime/requests/leave/create',
        { leaveType: 'annual', dateFrom: inCycleDay, dateTo: inCycleDay2, reason: 'off' },
        employee.token,
      ),
    );
    const id = (created.request as { id: string }).id;
    expectOk(await rpc('/api/biotime/requests/leave/approve', { id }, hr.token));

    const line = await prisma.shiftGridLine.findFirst({
      where: { employeeId: employee.employeeId!, date: new Date(`${inCycleDay}T00:00:00.000Z`) },
    });
    expect(line?.isAnnualLeave).toBe(true);
  });

  it('leave may extend past openCycle.dateTo', async () => {
    expectOk(
      await rpc(
        '/api/biotime/requests/leave/create',
        {
          leaveType: 'annual',
          dateFrom: cycle.dateTo,
          dateTo: afterCycleDay,
          reason: 'span',
        },
        employee.token,
      ),
    );
  });

  it('leave create without shift-grid coverage succeeds; approve → NO_GRID_COVERAGE', async () => {
    const far = dayAfter(afterCycleDay);
    const created = expectOk(
      await rpc(
        '/api/biotime/requests/leave/create',
        {
          leaveType: 'annual',
          dateFrom: far,
          dateTo: far,
          reason: 'no grid',
        },
        employee.token,
      ),
    );
    const id = (created.request as { id: string }).id;
    expectFail(
      await rpc('/api/biotime/requests/leave/approve', { id }, hr.token),
      'NO_GRID_COVERAGE',
    );
  });

  it('leave starting before openCycle → BEFORE_OPEN_CYCLE', async () => {
    expectFail(
      await rpc(
        '/api/biotime/requests/leave/create',
        {
          leaveType: 'annual',
          dateFrom: dayBefore(cycle.dateFrom),
          dateTo: cycle.dateFrom,
          reason: 'early',
        },
        employee.token,
      ),
      'BEFORE_OPEN_CYCLE',
    );
  });

  it('leave dateTo < dateFrom → INVALID_DATE_RANGE', async () => {
    expectFail(
      await rpc(
        '/api/biotime/requests/leave/create',
        {
          leaveType: 'annual',
          dateFrom: inCycleDay2,
          dateTo: inCycleDay,
          reason: 'bad',
        },
        employee.token,
      ),
      'INVALID_DATE_RANGE',
    );
  });

  it('shift change past openCycle.dateTo → OUTSIDE_OPEN_CYCLE', async () => {
    expectFail(
      await rpc(
        '/api/biotime/requests/shift-change/create',
        {
          newShiftId: shiftId,
          dateFrom: cycle.dateTo,
          dateTo: afterCycleDay,
          reason: 'span',
        },
        employee.token,
      ),
      'OUTSIDE_OPEN_CYCLE',
    );
  });

  it('unpaid leave approve does not reduce annual leave balance', async () => {
    const before = await getEmployeeLeaveSummary(employee.employeeId!);
    const created = expectOk(
      await rpc(
        '/api/biotime/requests/leave/create',
        { leaveType: 'unpaid', dateFrom: inCycleDay, dateTo: inCycleDay, reason: 'unpaid' },
        employee.token,
      ),
    );
    const id = (created.request as { id: string }).id;
    expectOk(await rpc('/api/biotime/requests/leave/approve', { id }, hr.token));

    const line = await prisma.shiftGridLine.findFirst({
      where: { employeeId: employee.employeeId!, date: new Date(`${inCycleDay}T00:00:00.000Z`) },
    });
    expect(line?.isOff).toBe(true);
    expect(line?.isAnnualLeave).toBe(false);
    expect(line?.isSick).toBe(false);

    const after = await getEmployeeLeaveSummary(employee.employeeId!);
    expect(after.usedLeaveDays).toBe(before.usedLeaveDays);
    expect(after.remainingLeaveBalance).toBe(before.remainingLeaveBalance);
  });

  it('employee cannot create loan (READ_ONLY)', async () => {
    expectFail(
      await rpc(
        '/api/biotime/requests/loan/create',
        { amount: 1000, repaymentMonths: 3, reason: 'x' },
        employee.token,
      ),
      'READ_ONLY',
    );
  });

  it('HR approve attendance-edit writes punches and attendance', async () => {
    const created = expectOk(
      await rpc(
        '/api/biotime/requests/attendance-edit/create',
        {
          date: inCycleDay2,
          requestedCheckIn: '08:00',
          requestedCheckOut: '17:00',
          reason: 'forgot',
        },
        employee.token,
      ),
    );
    const id = (created.request as { id: string }).id;
    expectOk(await rpc('/api/biotime/requests/attendance-edit/approve', { id }, hr.token));

    const txs = await prisma.transaction.findMany({
      where: {
        employeeId: employee.employeeId!,
        punchTime: { gte: new Date(`${inCycleDay2}T00:00:00.000Z`) },
      },
    });
    expect(txs.length).toBeGreaterThanOrEqual(2);
    const att = await prisma.attendance.findFirst({
      where: { employeeId: employee.employeeId!, date: new Date(`${inCycleDay2}T00:00:00.000Z`) },
    });
    expect(att).not.toBeNull();
  });

  it('blocks create/approve when payroll period is confirmed (PERIOD_LOCKED)', async () => {
    const payroll = await prisma.payroll.create({
      data: {
        companyId: employee.companyId,
        name: 'Locked',
        dateFrom: new Date(`${cycle.dateFrom}T00:00:00.000Z`),
        dateTo: new Date(`${cycle.dateTo}T00:00:00.000Z`),
        state: PayrollState.confirmed,
      },
    });
    await prisma.payrollLine.create({
      data: {
        companyId: employee.companyId,
        payrollId: payroll.id,
        employeeId: employee.employeeId!,
        sequence: 1,
        employeeCode: 'CYC1',
        basicSalary: 3000,
        workingDays: 30,
        workDaysSalary: 3000,
        totalEarnings: 3000,
        grossSalary: 3000,
        totalDeductions: 0,
        netSalary: 3000,
      },
    });

    expectFail(
      await rpc(
        '/api/biotime/requests/leave/create',
        { leaveType: 'annual', dateFrom: inCycleDay, dateTo: inCycleDay, reason: 'x' },
        employee.token,
      ),
      'PERIOD_LOCKED',
    );

    const pending = await prismaBase.leaveRequest.create({
      data: {
        companyId: employee.companyId,
        employeeId: employee.employeeId!,
        leaveType: 'annual',
        dateFrom: new Date(`${inCycleDay2}T00:00:00.000Z`),
        dateTo: new Date(`${inCycleDay2}T00:00:00.000Z`),
        reason: 'seed',
        state: RequestState.pending,
      },
    });
    expectFail(
      await rpc('/api/biotime/requests/leave/approve', { id: pending.id }, hr.token),
      'PERIOD_LOCKED',
    );
  });

  it('employee payroll/my and payslip only for own line', async () => {
    const other = await createUser({
      login: 'other-cycle@test.local',
      role: UserRole.EMPLOYEE,
      withEmployeeProfile: true,
      employee: { code: 'CYC2', name: 'Other' },
    });
    const payroll = await prisma.payroll.create({
      data: {
        companyId: employee.companyId,
        name: 'June',
        dateFrom: new Date('2026-06-01T00:00:00.000Z'),
        dateTo: new Date('2026-06-30T00:00:00.000Z'),
        state: PayrollState.confirmed,
      },
    });
    const ownLine = await prisma.payrollLine.create({
      data: {
        payrollId: payroll.id,
        employeeId: employee.employeeId!,
        sequence: 1,
        employeeCode: 'CYC1',
        basicSalary: 3000,
        workingDays: 30,
        workDaysSalary: 3000,
        totalEarnings: 3000,
        grossSalary: 3000,
        totalDeductions: 0,
        netSalary: 3000,
      },
    });
    await prisma.payrollLine.create({
      data: {
        companyId: employee.companyId,
        payrollId: payroll.id,
        employeeId: other.employeeId!,
        sequence: 2,
        employeeCode: 'CYC2',
        basicSalary: 3000,
        workingDays: 30,
        workDaysSalary: 3000,
        totalEarnings: 3000,
        grossSalary: 3000,
        totalDeductions: 0,
        netSalary: 3000,
      },
    });

    const my = expectOk(await rpc('/api/biotime/payroll/my', {}, employee.token));
    const records = my.records as { line: { id: string } }[];
    expect(records.length).toBe(1);
    expect(records[0].line.id).toBe(ownLine.id);

    expectOk(
      await rpc('/api/biotime/payroll/payslip/detail', { lineId: ownLine.id }, employee.token),
    );
    const otherLine = await prisma.payrollLine.findFirstOrThrow({
      where: { payrollId: payroll.id, employeeId: other.employeeId! },
    });
    expectFail(
      await rpc('/api/biotime/payroll/payslip/detail', { lineId: otherLine.id }, employee.token),
      'FORBIDDEN',
    );
  });

  it('requests/my includes openCycle', async () => {
    const data = expectOk(await rpc('/api/biotime/requests/my', {}, employee.token));
    const payload = data.openCycle as { dateFrom: string; dateTo: string; payrollMonthStartDay: number };
    expect(payload.dateFrom).toBe(cycle.dateFrom);
    expect(payload.dateTo).toBe(cycle.dateTo);
    expect(payload.payrollMonthStartDay).toBe(1);
  });

  it('shift-change create without grid succeeds; HR approve → NO_GRID_COVERAGE', async () => {
    // Grid membership alone counts as coverage — shrink grid so inCycleDay2 has no grid.
    await prisma.shiftGrid.updateMany({
      where: { companyId: employee.companyId, employeeIds: { has: employee.employeeId! } },
      data: { dateTo: new Date(`${inCycleDay}T00:00:00.000Z`) },
    });
    const created = expectOk(
      await rpc(
        '/api/biotime/requests/shift-change/create',
        {
          newShiftId: shiftId,
          dateFrom: inCycleDay2,
          dateTo: inCycleDay2,
          reason: 'no grid shift',
        },
        employee.token,
      ),
    );
    const id = (created.request as { id: string }).id;
    expectFail(
      await rpc('/api/biotime/requests/shift-change/approve', { id }, hr.token),
      'NO_GRID_COVERAGE',
    );
  });

  it('employee creates attendance-edit; salary/certificate are READ_ONLY for EMPLOYEE role', async () => {
    expectOk(
      await rpc(
        '/api/biotime/requests/attendance-edit/create',
        {
          date: inCycleDay,
          requestedCheckIn: '08:00',
          requestedCheckOut: '17:00',
          reason: 'mobile e2e',
        },
        employee.token,
      ),
    );
    expectFail(
      await rpc(
        '/api/biotime/requests/salary/create',
        { amount: 500, reason: 'mobile e2e' },
        employee.token,
      ),
      'READ_ONLY',
    );
    expectFail(
      await rpc(
        '/api/biotime/requests/certificate/create',
        { certificateType: 'employment', reason: 'mobile e2e' },
        employee.token,
      ),
      'READ_ONLY',
    );
  });

  it('auth login with companyCode mirrors mobile payload', async () => {
    const login = expectOk(
      await rpc('/api/auth/login', {
        companyCode: 'testco',
        login: employee.login,
        password: employee.password,
      }),
    );
    expect(typeof login.token).toBe('string');
    expectOk(await rpc('/api/biotime/me', {}, String(login.token)));
  });
});
