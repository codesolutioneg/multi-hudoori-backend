import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { effectivePayrollEnd } from '../../src/utils/payrollPeriod';
import { expectFail, expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createUser,
  ensureBioTimeConfig,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';

/** Valid Egyptian national IDs: century 2/3 + YYMMDD + governorate + serial + check. */
const NID_MALE = '29001011234571';
const NID_FEMALE = '29001011234582';

describe('employees', () => {
  let hr: SeededUser;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hr = await createUser({ login: 'hr@test.local', role: UserRole.HR_MANAGER });
  });

  describe('create', () => {
    it('creates an employee and auto-generates a code', async () => {
      const res = await rpc(
        '/api/biotime/employees/create',
        { name: 'Ahmed Ali', nationalIdConfirm: NID_MALE, basicSalary: 4500 },
        hr.token,
      );
      const data = expectOk(res);
      expect(data.generatedCode).toMatch(/^E\d+$/);
      const employee = data.employee as Record<string, unknown>;
      expect(employee.name).toBe('Ahmed Ali');
      expect(employee.basicSalary).toBe(4500);
    });

    it('derives birthday and gender from the national ID', async () => {
      await rpc(
        '/api/biotime/employees/create',
        { name: 'Ahmed Ali', nationalIdConfirm: NID_MALE },
        hr.token,
      );
      const row = await prisma.employeeProfile.findFirst({ where: { name: 'Ahmed Ali' } });
      expect(row?.birthday?.toISOString().slice(0, 10)).toBe('1990-01-01');
      expect(row?.gender).toBe('male');
    });

    it('derives female gender from an even 13th digit', async () => {
      await rpc(
        '/api/biotime/employees/create',
        { name: 'Sara Hassan', nationalIdConfirm: NID_FEMALE },
        hr.token,
      );
      const row = await prisma.employeeProfile.findFirst({ where: { name: 'Sara Hassan' } });
      expect(row?.gender).toBe('female');
    });

    it('accepts an explicit code', async () => {
      const res = await rpc(
        '/api/biotime/employees/create',
        { name: 'Coded Person', nationalIdConfirm: NID_MALE, code: 'EMP-77' },
        hr.token,
      );
      expect(expectOk(res).generatedCode).toBe('EMP-77');
    });

    it('rejects a short name', async () => {
      expectFail(
        await rpc('/api/biotime/employees/create', { name: 'A', nationalIdConfirm: NID_MALE }, hr.token),
        'VALIDATION',
      );
    });

    it('requires a national ID', async () => {
      expectFail(
        await rpc('/api/biotime/employees/create', { name: 'No Nid' }, hr.token),
        'VALIDATION',
      );
    });

    it('rejects a malformed national ID', async () => {
      expectFail(
        await rpc('/api/biotime/employees/create', { name: 'Bad Nid', nationalIdConfirm: '123' }, hr.token),
        'VALIDATION',
      );
    });

    it('rejects a national ID with an impossible birth date', async () => {
      expectFail(
        await rpc('/api/biotime/employees/create', { name: 'Bad Date', nationalIdConfirm: '29902301234571' }, hr.token),
        'VALIDATION',
      );
    });

    it('rejects a duplicate national ID', async () => {
      await rpc('/api/biotime/employees/create', { name: 'First', nationalIdConfirm: NID_MALE }, hr.token);
      expectFail(
        await rpc('/api/biotime/employees/create', { name: 'Second', nationalIdConfirm: NID_MALE }, hr.token),
        'DUPLICATE',
      );
    });

    it('rejects a duplicate code', async () => {
      await rpc(
        '/api/biotime/employees/create',
        { name: 'First', nationalIdConfirm: NID_MALE, code: 'DUP1' },
        hr.token,
      );
      expectFail(
        await rpc(
          '/api/biotime/employees/create',
          { name: 'Second', nationalIdConfirm: NID_FEMALE, code: 'DUP1' },
          hr.token,
        ),
        'DUPLICATE',
      );
    });

    it('rejects a code with illegal characters', async () => {
      expectFail(
        await rpc(
          '/api/biotime/employees/create',
          { name: 'Bad Code', nationalIdConfirm: NID_MALE, code: 'has space' },
          hr.token,
        ),
        'VALIDATION',
      );
    });

    it('rejects a negative salary', async () => {
      expectFail(
        await rpc(
          '/api/biotime/employees/create',
          { name: 'Neg Salary', nationalIdConfirm: NID_MALE, basicSalary: -5 },
          hr.token,
        ),
        'VALIDATION',
      );
    });

    it('rejects a too-short work phone', async () => {
      expectFail(
        await rpc(
          '/api/biotime/employees/create',
          { name: 'Short Phone', nationalIdConfirm: NID_MALE, workPhone: '123' },
          hr.token,
        ),
        'VALIDATION',
      );
    });

    it('rejects an unknown department', async () => {
      expectFail(
        await rpc(
          '/api/biotime/employees/create',
          { name: 'Ghost Dept', nationalIdConfirm: NID_MALE, departmentId: 'does-not-exist' },
          hr.token,
        ),
        'VALIDATION',
      );
    });

    it('generates sequential codes for successive employees', async () => {
      const a = await rpc('/api/biotime/employees/create', { name: 'Person A', nationalIdConfirm: NID_MALE }, hr.token);
      const b = await rpc('/api/biotime/employees/create', { name: 'Person B', nationalIdConfirm: NID_FEMALE }, hr.token);
      expect(expectOk(a).generatedCode).not.toBe(expectOk(b).generatedCode);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await prisma.employeeProfile.createMany({
        data: Array.from({ length: 12 }, (_, i) => ({
          name: `Employee ${String(i).padStart(2, '0')}`,
          code: `E20${String(i).padStart(2, '0')}`,
          basicSalary: 3000 + i,
        })),
      });
    });

    it('returns employees with pagination metadata inlined on data', async () => {
      const data = expectOk(await rpc('/api/biotime/employees/list', { limit: 5 }, hr.token));
      expect((data.employees as unknown[]).length).toBe(5);
      // this endpoint spreads paginationMeta onto data rather than nesting it
      expect(data).toMatchObject({ limit: 5, offset: 0, hasMore: true });
    });

    it('pages with offset without repeating rows', async () => {
      const first = expectOk(await rpc('/api/biotime/employees/list', { limit: 5, offset: 0 }, hr.token));
      const second = expectOk(await rpc('/api/biotime/employees/list', { limit: 5, offset: 5 }, hr.token));
      const ids = (e: Record<string, unknown>) => (e.employees as { id: string }[]).map((x) => x.id);
      expect(ids(first).some((id) => ids(second).includes(id))).toBe(false);
    });

    it('reports the correct total', async () => {
      const data = expectOk(await rpc('/api/biotime/employees/list', { limit: 5 }, hr.token));
      expect(data.total).toBe(12);
    });

    it('filters by search term', async () => {
      const data = expectOk(await rpc('/api/biotime/employees/list', { search: 'Employee 03' }, hr.token));
      expect((data.employees as unknown[]).length).toBe(1);
    });

    it('caps an oversized limit', async () => {
      const data = expectOk(await rpc('/api/biotime/employees/list', { limit: 10000 }, hr.token));
      expect(data.limit as number).toBeLessThanOrEqual(200);
    });
  });

  describe('get', () => {
    it('returns a single employee', async () => {
      const emp = await prisma.employeeProfile.create({ data: { name: 'Solo', code: 'SOLO1' } });
      const data = expectOk(await rpc('/api/biotime/employees/get', { id: emp.id }, hr.token));
      expect((data.employee as { id: string }).id).toBe(emp.id);
    });

    it('fails for an unknown id', async () => {
      expectFail(await rpc('/api/biotime/employees/get', { id: 'nope' }, hr.token));
    });
  });

  describe('archive and restore', () => {
    it('archives an employee, then restores them', async () => {
      const emp = await prisma.employeeProfile.create({ data: { name: 'Leaver', code: 'LEAVE1' } });

      expectOk(
        await rpc('/api/biotime/employees/archive', { id: emp.id, reason: 'resigned' }, hr.token),
        'archive',
      );
      let row = await prisma.employeeProfile.findUnique({ where: { id: emp.id } });
      expect(row?.active).toBe(false);
      expect(row?.archivedAt).toBeTruthy();

      expectOk(await rpc('/api/biotime/employees/restore', { id: emp.id }, hr.token), 'restore');
      row = await prisma.employeeProfile.findUnique({ where: { id: emp.id } });
      expect(row?.active).toBe(true);
      expect(row?.departureDate).toBeNull();
      // archivedAt is retained deliberately as an audit trail
      expect(row?.archivedAt).toBeTruthy();
    });

    it('pays a restored employee for the full period despite the retained archive stamp', async () => {
      const emp = await prisma.employeeProfile.create({
        data: { name: 'Rehired', code: 'REHIRE1', basicSalary: 3000 },
      });
      await rpc('/api/biotime/employees/archive', { id: emp.id, reason: 'resigned' }, hr.token);
      await rpc('/api/biotime/employees/restore', { id: emp.id }, hr.token);

      const row = await prisma.employeeProfile.findUniqueOrThrow({ where: { id: emp.id } });
      const end = effectivePayrollEnd(
        new Date('2027-01-01T00:00:00.000Z'),
        new Date('2027-01-31T00:00:00.000Z'),
        row,
      );
      expect(end?.toISOString()).toBe('2027-01-31T00:00:00.000Z');
    });

    it('excludes archived employees from the default list', async () => {
      const emp = await prisma.employeeProfile.create({ data: { name: 'Hidden', code: 'HIDE1' } });
      await rpc('/api/biotime/employees/archive', { id: emp.id, reason: 'resigned' }, hr.token);
      const data = expectOk(await rpc('/api/biotime/employees/list', {}, hr.token));
      const names = (data.employees as { name: string }[]).map((e) => e.name);
      expect(names).not.toContain('Hidden');
    });
  });

  describe('location scoping', () => {
    it('restricts a location-scoped HR user to their own branch', async () => {
      const branchA = await createLocation({ name: 'Branch A', code: 'LOC-A' });
      const branchB = await createLocation({ name: 'Branch B', code: 'LOC-B' });

      await prisma.employeeProfile.create({
        data: { name: 'In A', code: 'INA1', locationId: branchA.id },
      });
      await prisma.employeeProfile.create({
        data: { name: 'In B', code: 'INB1', locationId: branchB.id },
      });

      const scoped = await createUser({
        login: 'branch-a-hr@test.local',
        role: UserRole.HR_USER,
        locationId: branchA.id,
      });

      const data = expectOk(await rpc('/api/biotime/employees/list', {}, scoped.token));
      const names = (data.employees as { name: string }[]).map((e) => e.name);
      expect(names).toContain('In A');
      expect(names).not.toContain('In B');
    });

    it('lets an unscoped HR manager see every branch', async () => {
      const branchA = await createLocation({ name: 'Branch A', code: 'LOC-A' });
      const branchB = await createLocation({ name: 'Branch B', code: 'LOC-B' });
      await prisma.employeeProfile.create({ data: { name: 'In A', code: 'INA1', locationId: branchA.id } });
      await prisma.employeeProfile.create({ data: { name: 'In B', code: 'INB1', locationId: branchB.id } });

      const data = expectOk(await rpc('/api/biotime/employees/list', {}, hr.token));
      const names = (data.employees as { name: string }[]).map((e) => e.name);
      expect(names).toEqual(expect.arrayContaining(['In A', 'In B']));
    });

    it('forces a scoped creator to their own location', async () => {
      const branchA = await createLocation({ name: 'Branch A', code: 'LOC-A' });
      const branchB = await createLocation({ name: 'Branch B', code: 'LOC-B' });
      const scoped = await createUser({
        login: 'scoped-creator@test.local',
        role: UserRole.HR_USER,
        locationId: branchA.id,
      });

      await rpc(
        '/api/biotime/employees/create',
        { name: 'Forced Scope', nationalIdConfirm: NID_MALE, locationId: branchB.id },
        scoped.token,
      );

      const row = await prisma.employeeProfile.findFirst({ where: { name: 'Forced Scope' } });
      expect(row?.locationId).toBe(branchA.id);
    });
  });
});
