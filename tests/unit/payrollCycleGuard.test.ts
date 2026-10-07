import { describe, it, expect, beforeEach } from 'vitest';
import { PayrollState } from '@prisma/client';
import { prisma, prismaBase } from '../../src/prisma/client';
import {
  assertDatesNotPeriodLocked,
  enumerateUtcDates,
  getOpenCycle,
} from '../../src/services/payrollCycleGuard.service';
import { createUser, ensureBioTimeConfig, resetDatabase } from '../helpers/db';
import { UserRole } from '@prisma/client';

describe('payrollCycleGuard', () => {
  beforeEach(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
  });

  it('enumerateUtcDates is inclusive', () => {
    const days = enumerateUtcDates(new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-03T00:00:00.000Z'));
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
  });

  it('getOpenCycle respects payrollMonthStartDay on company config', async () => {
    const hr = await createUser({ login: 'hr-guard@test.local', role: UserRole.HR_MANAGER });
    await prismaBase.bioTimeConfig.updateMany({
      where: { companyId: hr.companyId },
      data: { payrollMonthStartDay: 1 },
    });
    const cycle = await getOpenCycle(new Date('2026-07-15T12:00:00.000Z'));
    expect(cycle.payrollMonthStartDay).toBe(1);
    expect(cycle.dateFrom).toBe('2026-07-01');
    expect(cycle.dateTo).toBe('2026-07-31');
  });

  it('assertDatesNotPeriodLocked throws PERIOD_LOCKED for confirmed payroll days', async () => {
    const employee = await createUser({
      login: 'emp-guard@test.local',
      role: UserRole.EMPLOYEE,
      withEmployeeProfile: true,
    });
    const payroll = await prisma.payroll.create({
      data: {
        companyId: employee.companyId,
        name: 'P',
        dateFrom: new Date('2026-08-01T00:00:00.000Z'),
        dateTo: new Date('2026-08-31T00:00:00.000Z'),
        state: PayrollState.confirmed,
      },
    });
    await prisma.payrollLine.create({
      data: {
        companyId: employee.companyId,
        payrollId: payroll.id,
        employeeId: employee.employeeId!,
        sequence: 1,
        employeeCode: 'G1',
        basicSalary: 1000,
        workingDays: 30,
        workDaysSalary: 1000,
        totalEarnings: 1000,
        grossSalary: 1000,
        totalDeductions: 0,
        netSalary: 1000,
      },
    });

    await expect(
      assertDatesNotPeriodLocked(employee.employeeId!, [new Date('2026-08-10T00:00:00.000Z')]),
    ).rejects.toMatchObject({ errorCode: 'PERIOD_LOCKED' });

    await expect(
      assertDatesNotPeriodLocked(employee.employeeId!, [new Date('2026-09-01T00:00:00.000Z')]),
    ).resolves.toBeUndefined();
  });
});
