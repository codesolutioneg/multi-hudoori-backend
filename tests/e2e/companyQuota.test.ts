import { describe, it, expect, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { UserRole } from '@prisma/client';
import { prismaBase } from '../../src/prisma/client';
import { ensureBioTimeConfigFromEnv } from '../../src/bootstrap/biotimeConfig';
import { ensureOdooConfigFromEnv } from '../../src/bootstrap/odooConfig';
import {
  assertCanCreateDashboardUsers,
  assertCanCreateEmployees,
  getQuotaSnapshot,
  QuotaExceededError,
} from '../../src/services/licenseQuota.service';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { createUser, resetDatabase, type SeededUser } from '../helpers/db';

const NID_MALE = '29001011234571';
const NID_FEMALE = '29001011234582';

async function seedCompany(maxEmployees: number | null, maxUsers: number | null) {
  const company = await prismaBase.company.create({
    data: { code: 'quota', name: 'Quota Co', active: true, maxEmployees, maxUsers },
  });
  await ensureBioTimeConfigFromEnv(company.id);
  await ensureOdooConfigFromEnv(company.id);
  const hr = await createUser({
    login: 'hr@quota.test',
    role: UserRole.HR_MANAGER,
    companyId: company.id,
    withEmployeeProfile: true,
  });
  return { companyId: company.id, hr };
}

async function employeesXlsx(codes: string[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Employees');
  ws.addRow(['Code', 'Name-Arabic']);
  for (const code of codes) ws.addRow([code, `موظف ${code}`]);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

describe('company seat quotas', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('treats null caps as unlimited', async () => {
    const { companyId } = await seedCompany(null, null);
    const s = await getQuotaSnapshot(companyId);
    expect(s).toMatchObject({
      employeesUsed: 1,
      employeesMax: null,
      employeesRemaining: null,
      usersUsed: 1,
      usersMax: null,
      usersRemaining: null,
    });
    await expect(assertCanCreateEmployees(companyId, 1000)).resolves.toBeUndefined();
    await expect(assertCanCreateDashboardUsers(companyId, 1000)).resolves.toBeUndefined();
  });

  it('asserts below and at the cap', async () => {
    const { companyId } = await seedCompany(3, 2);
    await expect(assertCanCreateEmployees(companyId, 2)).resolves.toBeUndefined();
    await expect(assertCanCreateEmployees(companyId, 3)).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(assertCanCreateDashboardUsers(companyId, 1)).resolves.toBeUndefined();
    await expect(assertCanCreateDashboardUsers(companyId, 2)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('counts active seats only — archiving frees a seat; restore respects the cap', async () => {
    const { companyId, hr } = await seedCompany(2, null);
    const first = expectOk(
      await rpc('/api/biotime/employees/create', { name: 'First Person', nationalIdConfirm: NID_MALE }, hr.token),
    );
    const firstId = String((first.employee as { id: string }).id);

    // At cap (HR profile + First). Archiving First frees a seat.
    await prismaBase.employeeProfile.update({
      where: { id: firstId },
      data: { active: false, archivedAt: new Date() },
    });
    expect((await getQuotaSnapshot(companyId)).employeesUsed).toBe(1);

    expectOk(
      await rpc(
        '/api/biotime/employees/create',
        { name: 'Second Person', nationalIdConfirm: NID_FEMALE },
        hr.token,
      ),
    );
    expect((await getQuotaSnapshot(companyId)).employeesUsed).toBe(2);

    // Restore would exceed the cap while Second is still active.
    expectFail(
      await rpc('/api/biotime/employees/restore', { id: firstId }, hr.token),
      'EMPLOYEE_QUOTA_EXCEEDED',
    );
  });

  it('blocks raw inserts at the DB trigger even without the Prisma extension', async () => {
    const { companyId } = await seedCompany(1, 1);
    await expect(
      prismaBase.employeeProfile.create({ data: { companyId, name: 'Raw Insert' } }),
    ).rejects.toThrow(/EMPLOYEE_QUOTA_EXCEEDED/);

    await expect(
      prismaBase.user.create({
        data: { companyId, login: 'raw-hr@quota.test', name: 'Raw HR', passwordHash: 'x', role: UserRole.HR_USER },
      }),
    ).rejects.toThrow(/USER_QUOTA_EXCEEDED/);

    const emp = await prismaBase.user.create({
      data: { companyId, login: 'emp@quota.test', name: 'Emp', passwordHash: 'x', role: UserRole.EMPLOYEE },
    });
    await expect(
      prismaBase.user.update({ where: { id: emp.id }, data: { role: UserRole.HR_MANAGER } }),
    ).rejects.toThrow(/USER_QUOTA_EXCEEDED/);
  });

  it('fails an Excel import that would pass the cap without writing any row', async () => {
    const { companyId, hr } = await seedCompany(2, null);
    const res = await rpc(
      '/api/biotime/employees/import-xlsx',
      { base64: await employeesXlsx(['Q-1', 'Q-2']) },
      hr.token,
    );
    expectFail(res, 'EMPLOYEE_QUOTA_EXCEEDED');
    expect(await prismaBase.employeeProfile.count({ where: { companyId } })).toBe(1);
  });

  it('returns per-branch and per-department stats for the platform admin', async () => {
    const { companyId } = await seedCompany(10, 5);
    const admin = await createUser({ login: 'stats-admin@admin.bio', role: UserRole.PLATFORM_ADMIN });
    const branch = await prismaBase.location.create({ data: { companyId, name: 'Strip', code: 'strip' } });
    await prismaBase.location.create({ data: { companyId, name: 'Empty Branch', code: 'empty' } });
    const dept = await prismaBase.department.create({ data: { companyId, name: 'Kitchen' } });
    await prismaBase.employeeProfile.create({
      data: { companyId, name: 'Cook', locationId: branch.id, departmentId: dept.id },
    });
    await prismaBase.employeeProfile.create({
      data: { companyId, name: 'Old Cook', locationId: branch.id, active: false },
    });

    const data = expectOk(await rpc('/api/admin/companies/stats', { id: companyId }, admin.token));
    const stats = data.stats as {
      employees: { active: number; archived: number; total: number };
      quota: { employeesUsed: number; employeesMax: number };
      locations: Array<{ id: string | null; name: string; count: number }>;
      departments: Array<{ id: string | null; name: string; count: number }>;
    };
    expect(stats.employees).toEqual({ active: 2, archived: 1, total: 3 });
    expect(stats.quota).toMatchObject({ employeesUsed: 2, employeesMax: 10 });
    expect(stats.locations).toEqual([
      { id: branch.id, name: 'Strip', count: 1 },
      { id: null, name: '', count: 1 },
      expect.objectContaining({ name: 'Empty Branch', count: 0 }),
    ]);
    expect(stats.departments).toEqual([
      { id: dept.id, name: 'Kitchen', count: 1 },
      { id: null, name: '', count: 1 },
    ]);

    const hr = await rpc('/api/admin/companies/stats', { id: companyId }, (await prismaBase.apiToken.findFirst({
      where: { user: { login: 'hr@quota.test' } },
    }))!.token);
    expectFail(hr);
  });

  describe('dashboard users', () => {
    let admin: SeededUser;

    beforeEach(async () => {
      admin = await createUser({ login: 'bioadmin@admin.bio', role: UserRole.PLATFORM_ADMIN });
    });

    it('rejects a second HR login but still allows employee logins', async () => {
      const { companyId } = await seedCompany(10, 1);

      expectFail(
        await rpc(
          '/api/admin/users',
          { activeCompanyId: companyId, name: 'Extra HR', login: 'hr2@quota.test', password: 'HrPass#2026', role: 'HR_MANAGER' },
          admin.token,
        ),
        'USER_QUOTA_EXCEEDED',
      );
      expect(await prismaBase.user.count({ where: { companyId, login: 'hr2@quota.test' } })).toBe(0);

      expectOk(
        await rpc(
          '/api/admin/users',
          { activeCompanyId: companyId, name: 'Staff Login', login: 'staff@quota.test', password: 'Staff#2026', role: 'EMPLOYEE' },
          admin.token,
        ),
      );
    });

    it('rejects an employee login when employee seats are full', async () => {
      const { companyId } = await seedCompany(1, 5);
      expectFail(
        await rpc(
          '/api/admin/users',
          { activeCompanyId: companyId, name: 'Staff Login', login: 'staff@quota.test', password: 'Staff#2026', role: 'EMPLOYEE' },
          admin.token,
        ),
        'EMPLOYEE_QUOTA_EXCEEDED',
      );
      expect(await prismaBase.user.count({ where: { companyId, login: 'staff@quota.test' } })).toBe(0);
    });
  });
});
