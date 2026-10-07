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

describe('mobile employee ↔ HR request cycle', () => {
  let hr: SeededUser;
  let employee: SeededUser;
  let shiftId: string;

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
    const shift = await createShift({ name: 'Day', code: 'DAY' });
    shiftId = shift.id;
    await seedShiftGridForEmployee({
      companyId: employee.companyId,
      employeeId: employee.employeeId!,
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      shiftId,
    });
  });

  it('employee creates leave; HR approve sets annual leave on grid', async () => {
    const created = expectOk(
      await rpc(
        '/api/biotime/requests/leave/create',
        { leaveType: 'annual', dateFrom: '2026-07-02', dateTo: '2026-07-03', reason: 'off' },
        employee.token,
      ),
    );
    const id = (created.request as { id: string }).id;
    expectOk(await rpc('/api/biotime/requests/leave/approve', { id }, hr.token));

    const line = await prisma.shiftGridLine.findFirst({
      where: { employeeId: employee.employeeId!, date: new Date('2026-07-02T00:00:00.000Z') },
    });
    expect(line?.isAnnualLeave).toBe(true);
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
          date: '2026-07-10',
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
      where: { employeeId: employee.employeeId!, punchTime: { gte: new Date('2026-07-10T00:00:00.000Z') } },
    });
    expect(txs.length).toBeGreaterThanOrEqual(2);
    const att = await prisma.attendance.findFirst({
      where: { employeeId: employee.employeeId!, date: new Date('2026-07-10T00:00:00.000Z') },
    });
    expect(att).not.toBeNull();
  });

  it('blocks create/approve when payroll period is confirmed (PERIOD_LOCKED)', async () => {
    const payroll = await prisma.payroll.create({
      data: {
        companyId: employee.companyId,
        name: 'Locked',
        dateFrom: new Date('2026-07-01T00:00:00.000Z'),
        dateTo: new Date('2026-07-31T00:00:00.000Z'),
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
        { leaveType: 'annual', dateFrom: '2026-07-05', dateTo: '2026-07-05', reason: 'x' },
        employee.token,
      ),
      'PERIOD_LOCKED',
    );

    const pending = await prismaBase.leaveRequest.create({
      data: {
        companyId: employee.companyId,
        employeeId: employee.employeeId!,
        leaveType: 'annual',
        dateFrom: new Date('2026-07-06T00:00:00.000Z'),
        dateTo: new Date('2026-07-06T00:00:00.000Z'),
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
    const cycle = data.openCycle as { dateFrom: string; dateTo: string; payrollMonthStartDay: number };
    expect(cycle.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cycle.dateTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof cycle.payrollMonthStartDay).toBe('number');
  });
});
