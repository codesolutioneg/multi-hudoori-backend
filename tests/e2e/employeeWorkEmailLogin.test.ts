import { describe, it, expect, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';
import { prismaBase } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createUser,
  ensureBioTimeConfig,
  ensureDefaultCompany,
  resetDatabase,
} from '../helpers/db';

/**
 * Cases from single-company WORK_STATE (2026-09-07):
 * EMPLOYEE login from workEmail + workEmailPassword; limited menus;
 * block requests/payroll; forceSelfOnly schedule; auto-mint password;
 * archive deactivates app login.
 */
describe('employee workEmail login (WORK_STATE cases)', () => {
  const companyCode = 'testco';

  beforeEach(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
  });

  async function seedHr() {
    const companyId = await ensureDefaultCompany();
    const location = await createLocation({ name: 'Main', code: 'MAIN' });
    const hr = await createUser({
      login: 'hr@co.test',
      role: UserRole.HR_MANAGER,
      companyId,
    });
    return { companyId, location, hr };
  }

  async function loginEmployee(login: string, password: string, code = companyCode) {
    return rpc('/api/auth/login', {
      login,
      password,
      companyCode: code,
      device_info: 'vitest',
    });
  }

  it('provisions EMPLOYEE user on update and allows companyCode login', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Worker One',
        code: 'E1',
        locationId: location.id,
      },
    });

    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'worker1@co.test',
          workEmailPassword: 'Pass#2026',
        },
        hr.token,
      ),
    );

    const linked = await prismaBase.employeeProfile.findUnique({
      where: { id: emp.id },
      select: { userId: true },
    });
    expect(linked?.userId).toBeTruthy();
    const user = await prismaBase.user.findUnique({ where: { id: linked!.userId! } });
    expect(user?.role).toBe(UserRole.EMPLOYEE);
    expect(user?.login).toBe('worker1@co.test');
    expect(user?.active).toBe(true);

    const auth = expectOk(await loginEmployee('worker1@co.test', 'Pass#2026'));
    expect((auth.user as { role: string }).role).toBe('EMPLOYEE');
    expect(auth.companyId).toBe(companyId);
  });

  it('still provisions when name/code are empty (mandara-style detail save)', async () => {
    const { hr, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: '',
        code: '',
        workEmail: 'i@empty.test',
        workEmailPassword: 'Mos159357',
      },
    });

    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'i@empty.test',
          workEmailPassword: 'Mos159357',
        },
        hr.token,
      ),
    );

    const linked = await prismaBase.employeeProfile.findUnique({
      where: { id: emp.id },
      select: { userId: true },
    });
    expect(linked?.userId).toBeTruthy();
    expectOk(await loginEmployee('i@empty.test', 'Mos159357'));
  });

  it('rejects company employee login without companyCode', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'No Code',
        code: 'E2',
        locationId: location.id,
      },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'nocode@co.test',
          workEmailPassword: 'Pass#2026',
        },
        hr.token,
      ),
    );

    expectFail(
      await rpc('/api/auth/login', {
        login: 'nocode@co.test',
        password: 'Pass#2026',
        device_info: 'vitest',
      }),
    );
  });

  it('rejects wrong password', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Wrong Pw',
        code: 'E3',
        locationId: location.id,
      },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'wrongpw@co.test',
          workEmailPassword: 'Right#2026',
        },
        hr.token,
      ),
    );
    expectFail(
      await loginEmployee('wrongpw@co.test', 'Wrong#9999'),
      'INVALID_CREDENTIALS',
    );
  });

  it('auto-mints password when email is set without password', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Mint Me',
        code: 'E4',
        locationId: location.id,
      },
    });

    const updated = expectOk(
      await rpc(
        '/api/biotime/employees/update',
        { employeeId: emp.id, workEmail: 'mint@co.test' },
        hr.token,
      ),
    );
    const pwd = String((updated.employee as { workEmailPassword?: string }).workEmailPassword ?? '');
    expect(pwd.length).toBeGreaterThanOrEqual(6);

    const linked = await prismaBase.employeeProfile.findUnique({
      where: { id: emp.id },
      select: { userId: true, workEmailPassword: true },
    });
    expect(linked?.userId).toBeTruthy();
    expectOk(await loginEmployee('mint@co.test', linked!.workEmailPassword!));
  });

  it('EMPLOYEE /me menus are self-service only (dashboard + حضوري + جدولي + سلفة)', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Menus',
        code: 'E5',
        locationId: location.id,
      },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'menus@co.test',
          workEmailPassword: 'Pass#2026',
        },
        hr.token,
      ),
    );
    const auth = expectOk(await loginEmployee('menus@co.test', 'Pass#2026'));
    const me = expectOk(await rpc('/api/biotime/me', {}, String(auth.token)));
    const menuIds = ((me.menus as Array<{ id: string }>) ?? []).map((m) => m.id);
    expect(menuIds).toEqual(
      expect.arrayContaining(['dashboard', 'my_schedule', 'my_attendance', 'my_advance_request']),
    );
    expect(menuIds).not.toContain('employees');
    expect(menuIds).not.toContain('payroll');
    expect(menuIds).not.toContain('org_chart');
  });

  it('blocks EMPLOYEE leave/salary request create (READ_ONLY) but allows advance-request eligibility', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'RO',
        code: 'E6',
        locationId: location.id,
        basicSalary: 5000,
      },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'ro@co.test',
          workEmailPassword: 'Pass#2026',
        },
        hr.token,
      ),
    );
    const auth = expectOk(await loginEmployee('ro@co.test', 'Pass#2026'));
    const token = String(auth.token);

    expectFail(
      await rpc(
        '/api/biotime/requests/leave/create',
        {
          leaveType: 'annual',
          dateFrom: '2026-09-20',
          dateTo: '2026-09-21',
          reason: 'x',
        },
        token,
      ),
      'READ_ONLY',
    );
    expectFail(
      await rpc(
        '/api/biotime/requests/salary/create',
        { amount: 100, reason: 'x' },
        token,
      ),
      'READ_ONLY',
    );
    expectFail(await rpc('/api/biotime/payroll/my', {}, token), 'READ_ONLY');

    // Advance request is the intentional exception (WORK_STATE 2026-09-08).
    expectOk(await rpc('/api/biotime/advance-requests/eligibility', {}, token));
  });

  it('my-schedule is forceSelfOnly for EMPLOYEE (team empty)', async () => {
    const { hr, location, companyId } = await seedHr();
    await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Teammate',
        code: 'E7B',
        locationId: location.id,
      },
    });
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Self',
        code: 'E7',
        locationId: location.id,
      },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'self@co.test',
          workEmailPassword: 'Pass#2026',
        },
        hr.token,
      ),
    );
    const auth = expectOk(await loginEmployee('self@co.test', 'Pass#2026'));
    const sched = expectOk(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '2026-09-01', dateTo: '2026-09-07' },
        String(auth.token),
      ),
    );
    expect(sched.teamScope === 'none' || sched.teamScope == null || Array.isArray(sched.team)).toBe(
      true,
    );
    if (Array.isArray(sched.team)) {
      expect(sched.team.length).toBe(0);
    }
  });

  it('clearing email/password deactivates the app user', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Clear',
        code: 'E8',
        locationId: location.id,
      },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'clear@co.test',
          workEmailPassword: 'Pass#2026',
        },
        hr.token,
      ),
    );
    const before = await prismaBase.employeeProfile.findUnique({
      where: { id: emp.id },
      select: { userId: true },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: '',
          workEmailPassword: '',
        },
        hr.token,
      ),
    );
    const user = await prismaBase.user.findUnique({ where: { id: before!.userId! } });
    expect(user?.active).toBe(false);
    expectFail(await loginEmployee('clear@co.test', 'Pass#2026'));
  });

  it('archive deactivates login; restore reactivates it', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Archive',
        code: 'E9',
        locationId: location.id,
      },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'arch@co.test',
          workEmailPassword: 'Pass#2026',
        },
        hr.token,
      ),
    );
    const linked = await prismaBase.employeeProfile.findUnique({
      where: { id: emp.id },
      select: { userId: true },
    });

    expectOk(
      await rpc(
        '/api/biotime/employees/archive',
        { id: emp.id, reason: 'استقالة' },
        hr.token,
      ),
    );
    expect((await prismaBase.user.findUnique({ where: { id: linked!.userId! } }))?.active).toBe(
      false,
    );
    expectFail(await loginEmployee('arch@co.test', 'Pass#2026'));

    expectOk(await rpc('/api/biotime/employees/restore', { id: emp.id }, hr.token));
    expect((await prismaBase.user.findUnique({ where: { id: linked!.userId! } }))?.active).toBe(
      true,
    );
    expectOk(await loginEmployee('arch@co.test', 'Pass#2026'));
  });

  it('does not overwrite an HR login when workEmail collides', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Collide',
        code: 'E10',
        locationId: location.id,
      },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'hr@co.test',
          workEmailPassword: 'EmpPass#1',
        },
        hr.token,
      ),
    );
    const hrUser = await prismaBase.user.findFirst({
      where: { companyId, login: 'hr@co.test' },
    });
    expect(hrUser?.role).toBe(UserRole.HR_MANAGER);
    const empRow = await prismaBase.employeeProfile.findUnique({
      where: { id: emp.id },
      select: { userId: true },
    });
    expect(empRow?.userId).toBeNull();

    // HR can still log in with original password
    expectOk(
      await rpc('/api/auth/login', {
        login: 'hr@co.test',
        password: 'Passw0rd!2026',
        companyCode,
        device_info: 'vitest',
      }),
    );
  });

  it('password change on update refreshes login credentials', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Rotate',
        code: 'E11',
        locationId: location.id,
      },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'rotate@co.test',
          workEmailPassword: 'Old#pass1',
        },
        hr.token,
      ),
    );
    expectOk(await loginEmployee('rotate@co.test', 'Old#pass1'));

    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'rotate@co.test',
          workEmailPassword: 'New#pass2',
        },
        hr.token,
      ),
    );
    expectFail(await loginEmployee('rotate@co.test', 'Old#pass1'), 'INVALID_CREDENTIALS');
    expectOk(await loginEmployee('rotate@co.test', 'New#pass2'));
  });

  it('employee-emails report lists provisioned credentials', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Report',
        code: 'E12',
        locationId: location.id,
      },
    });
    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          workEmail: 'report@co.test',
          workEmailPassword: 'Pass#2026',
        },
        hr.token,
      ),
    );
    const data = expectOk(await rpc('/api/biotime/reports/employee-emails', {}, hr.token));
    const rows = (data.rows as Array<{ workEmail?: string }>) ??
      (data.employees as Array<{ workEmail?: string }>) ??
      [];
    expect(rows.some((r) => r.workEmail === 'report@co.test')).toBe(true);
  });
});
