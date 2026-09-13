import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PayrollState, UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createUser,
  ensureBioTimeConfig,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';
import { cairoDateOnly } from '../../src/utils/payrollPeriod';

/**
 * Every tile on this endpoint counts the whole company. The screen a branch
 * employee sees shows only their own attendance, but the guard has to be on the
 * response, not the widget: hiding a card in Flutter still ships the number.
 */
describe('dashboard stats', () => {
  let employee: SeededUser;
  let hr: SeededUser;
  let branchManager: SeededUser;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();

    const location = await createLocation();
    hr = await createUser({ login: 'stats.hr@test.local', role: UserRole.HR_MANAGER });
    branchManager = await createUser({
      login: 'stats.lead@test.local',
      role: UserRole.BRANCH_MANAGER,
      locationId: location.id,
    });
    employee = await createUser({
      login: 'stats.emp@test.local',
      role: UserRole.EMPLOYEE,
      locationId: location.id,
      employee: { code: 'D001', name: 'Dashboard Person', locationId: location.id },
    });

    // Something to count, so a zero in the response means "withheld" rather
    // than "there was nothing there anyway".
    const colleague = await prisma.employeeProfile.create({
      data: { name: 'Colleague', code: 'D002', locationId: location.id },
    });
    await prisma.attendance.createMany({
      data: [employee.employeeId!, colleague.id].map((employeeId) => ({
        employeeId,
        date: cairoDateOnly(),
      })),
    });
    await prisma.payroll.create({
      data: {
        name: 'Draft payroll',
        dateFrom: new Date('2026-06-01T00:00:00.000Z'),
        dateTo: new Date('2026-06-30T00:00:00.000Z'),
        state: PayrollState.draft,
      },
    });
  });

  it('gives HR the real figures', async () => {
    const data = expectOk(await rpc('/api/biotime/dashboard/stats', {}, hr.token));
    expect(data.attendanceToday).toBe(2);
    expect(data.employeesCount).toBe(2);
    expect(data.payrollDraft).toBe(1);
  });

  it('gives a branch manager the real figures', async () => {
    const data = expectOk(await rpc('/api/biotime/dashboard/stats', {}, branchManager.token));
    expect(data.attendanceToday).toBe(2);
    expect(data.employeesCount).toBe(2);
  });

  it('withholds every company figure from an employee', async () => {
    const data = expectOk(await rpc('/api/biotime/dashboard/stats', {}, employee.token));
    for (const field of [
      'attendanceToday',
      'employeesCount',
      'employees',
      'payrollDraft',
      'pendingRequests',
      'healthCertAlerts',
      'hiringUnread',
      'absentUnread',
    ]) {
      expect(data[field], field).toBe(0);
    }
  });

  it('still answers an employee rather than refusing', async () => {
    // The dashboard calls this on load for everyone, so withholding has to look
    // like zeros. A refusal would put an error banner on the employee's own
    // home screen.
    const res = await rpc('/api/biotime/dashboard/stats', {}, employee.token);
    expect(res.status).toBe(200);
    expect(res.body.result?.success).toBe(true);
  });
});
