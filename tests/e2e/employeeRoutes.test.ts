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
 * Employee detail-page routes: list / get / create / update / archive / restore / delete.
 * Covers the multi-tenant save path (work email login sync after update).
 */
describe('employee routes (detail save)', () => {
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

  it('lists and gets employees for the company', async () => {
    const { hr, location, companyId } = await seedHr();
    await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Ali',
        code: '1001',
        locationId: location.id,
        workEmail: 'ali@co.test',
        workEmailPassword: 'Temp#1234',
      },
    });

    const list = expectOk(
      await rpc('/api/biotime/employees/list', {}, hr.token),
    );
    const employees = (list.employees as Array<{ code?: string }>) ?? [];
    expect(employees.some((e) => e.code === '1001')).toBe(true);

    const empId = (
      await prismaBase.employeeProfile.findFirst({ where: { companyId, code: '1001' } })
    )!.id;
    const got = expectOk(
      await rpc('/api/biotime/employees/get', { employeeId: empId }, hr.token),
    );
    expect((got.employee as { name: string }).name).toBe('Ali');
  });

  it('creates an employee', async () => {
    const { hr, location } = await seedHr();
    const created = expectOk(
      await rpc(
        '/api/biotime/employees/create',
        {
          name: 'Sara',
          identificationId: '2002',
          locationId: location.id,
          workEmail: 'sara@co.test',
          workEmailPassword: 'Pass#2026',
          basicSalary: 4000,
        },
        hr.token,
      ),
    );
    expect((created.employee as { name?: string; code?: string }).name).toBe('Sara');
    expect((created.employee as { code?: string }).code).toBe('2002');
  });

  it('updates employee detail fields and persists after reload (work email sync)', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Before',
        code: '3003',
        locationId: location.id,
        workEmail: 'before@co.test',
        workEmailPassword: 'Old#pass1',
        basicSalary: 1000,
        address: 'old addr',
      },
    });

    const updated = expectOk(
      await rpc(
        '/api/biotime/employees/update',
        {
          employeeId: emp.id,
          name: 'After Name',
          identificationId: '3003',
          locationId: location.id,
          workEmail: 'after@co.test',
          workEmailPassword: 'New#pass2',
          basicSalary: 5500,
          address: 'new street 5',
          jobTitle: 'كاشير',
          mobilePhone: '01000000000',
        },
        hr.token,
      ),
    );

    const empJson = updated.employee as {
      name?: string;
      basicSalary?: number;
      address?: string;
      workEmail?: string;
      jobTitle?: string;
    };
    expect(empJson.name).toBe('After Name');
    expect(empJson.basicSalary).toBe(5500);
    expect(empJson.address).toBe('new street 5');
    expect(empJson.workEmail).toBe('after@co.test');
    expect(empJson.jobTitle).toBe('كاشير');

    const reloaded = expectOk(
      await rpc('/api/biotime/employees/get', { employeeId: emp.id }, hr.token),
    );
    const again = reloaded.employee as { name?: string; basicSalary?: number; address?: string };
    expect(again.name).toBe('After Name');
    expect(again.basicSalary).toBe(5500);
    expect(again.address).toBe('new street 5');

    // Login user synced under company scope
    const loginUser = await prismaBase.user.findFirst({
      where: { companyId, login: 'after@co.test', role: UserRole.EMPLOYEE },
    });
    expect(loginUser).toBeTruthy();
  });

  it('rejects update for unknown employee', async () => {
    const { hr } = await seedHr();
    expectFail(
      await rpc(
        '/api/biotime/employees/update',
        { employeeId: 'missing-id', name: 'X' },
        hr.token,
      ),
      'NOT_FOUND',
    );
  });

  it('archives and restores an employee', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Archivable',
        code: '4004',
        locationId: location.id,
      },
    });

    const archived = expectOk(
      await rpc(
        '/api/biotime/employees/archive',
        { id: emp.id, employeeId: emp.id, reason: 'left' },
        hr.token,
      ),
    );
    expect((archived.employee as { active?: boolean }).active).toBe(false);

    const restored = expectOk(
      await rpc(
        '/api/biotime/employees/restore',
        { id: emp.id, employeeId: emp.id },
        hr.token,
      ),
    );
    expect((restored.employee as { active?: boolean }).active).toBe(true);
  });

  it('forbids employee delete without delete grant', async () => {
    const { hr, location, companyId } = await seedHr();
    const emp = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        name: 'Disposable',
        code: '5005',
        locationId: location.id,
      },
    });

    expectFail(
      await rpc('/api/biotime/employees/delete', { employeeId: emp.id }, hr.token),
      'FORBIDDEN',
    );
  });

  it('keeps companies isolated on employee list', async () => {
    const a = await seedHr();
    const companyB = await prismaBase.company.create({
      data: { code: 'otherco', name: 'Other', active: true },
    });
    await prismaBase.employeeProfile.create({
      data: {
        companyId: companyB.id,
        name: 'Secret',
        code: '9999',
      },
    });

    const list = expectOk(await rpc('/api/biotime/employees/list', {}, a.hr.token));
    const employees = (list.employees as Array<{ code?: string }>) ?? [];
    expect(employees.some((e) => e.code === '9999')).toBe(false);
  });
});
