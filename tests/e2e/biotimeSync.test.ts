import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';

vi.mock('../../src/services/biotime/biotimeConnector.service', () => ({
  BioTimeConnector: { fromDb: vi.fn() },
}));

import { BioTimeConnector } from '../../src/services/biotime/biotimeConnector.service';
import * as syncService from '../../src/services/biotime/sync.service';
import { applyDuplicateMarking } from '../../src/services/biotime/transactionDuplicate.service';
import { expectOk, rpc } from '../helpers/api';
import { createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';
import {
  MOCK_DEPARTMENTS,
  MOCK_DEVICES,
  MOCK_EMPLOYEES,
  MOCK_TRANSACTIONS,
  createMockConnector,
} from '../mocks/biotime.mock';

function mockConnector(overrides: Record<string, unknown> = {}) {
  const base = createMockConnector();
  vi.mocked(BioTimeConnector.fromDb).mockImplementation(
    async () => ({ ...base, ...overrides }) as never,
  );
}

describe('BioTime sync (connector mocked, no outbound calls)', () => {
  let hr: SeededUser;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    mockConnector();
    hr = await createUser({ login: 'hr@test.local', role: UserRole.HR_MANAGER });
  });

  describe('departments', () => {
    it('imports departments from BioTime', async () => {
      const count = await syncService.syncDepartments();
      expect(count).toBe(MOCK_DEPARTMENTS.length);
      const names = (await prisma.department.findMany()).map((d) => d.name);
      expect(names).toEqual(expect.arrayContaining(['Human Resources', 'Information Technology']));
    });

    it('is idempotent across repeated syncs', async () => {
      await syncService.syncDepartments();
      await syncService.syncDepartments();
      expect(await prisma.department.count()).toBe(MOCK_DEPARTMENTS.length);
    });

    it('records a BioTime mapping per department', async () => {
      await syncService.syncDepartments();
      expect(await prisma.departmentMapping.count()).toBeGreaterThan(0);
    });
  });

  describe('employees', () => {
    it('imports employees with their BioTime mapping', async () => {
      const count = await syncService.syncEmployees();
      expect(count).toBe(MOCK_EMPLOYEES.length);

      const employee = await prisma.employeeProfile.findFirst({
        where: { code: 'E1001' },
        include: { mapping: true },
      });
      expect(employee?.name).toBe('Ahmed Ali');
      expect(employee?.biotimeSynced).toBe(true);
      expect(employee?.mapping?.biotimeEmpId).toBe(1001);
    });

    it('does not duplicate an employee already imported', async () => {
      await syncService.syncEmployees();
      await syncService.syncEmployees();
      expect(await prisma.employeeProfile.count({ where: { code: 'E1001' } })).toBe(1);
    });

    it('links employees to departments pulled from BioTime', async () => {
      await syncService.syncDepartments();
      await syncService.syncEmployees();
      const employee = await prisma.employeeProfile.findFirst({ where: { code: 'E1001' } });
      expect(employee?.departmentId).toBeTruthy();
    });

    it('stops paging when BioTime reports no next page', async () => {
      const getEmployees = vi.fn(async () => ({ data: MOCK_EMPLOYEES, next: null }));
      mockConnector({ getEmployees });
      await syncService.syncEmployees();
      expect(getEmployees).toHaveBeenCalledTimes(1);
    });

    it('follows the next cursor across pages', async () => {
      const page2 = [{ ...MOCK_EMPLOYEES[0], id: 1003, emp_code: 'E1003', first_name: 'Page2' }];
      const getEmployees = vi.fn(async (page = 1) =>
        page === 1
          ? { data: MOCK_EMPLOYEES, next: 'http://biotime/next' }
          : { data: page2, next: null },
      );
      mockConnector({ getEmployees });
      const count = await syncService.syncEmployees();

      expect(getEmployees).toHaveBeenCalledTimes(2);
      expect(count).toBe(MOCK_EMPLOYEES.length + 1);
      expect(await prisma.employeeProfile.findFirst({ where: { code: 'E1003' } })).toBeTruthy();
    });
  });

  describe('devices', () => {
    it('imports terminals', async () => {
      const count = await syncService.syncDevices();
      expect(count).toBe(MOCK_DEVICES.length);
      const device = await prisma.device.findFirst({ where: { serialNumber: 'SN001' } });
      expect(device?.name ?? device?.alias).toBeTruthy();
    });
  });

  describe('transactions', () => {
    it('imports punches for a date range', async () => {
      await syncService.syncEmployees();
      const count = await syncService.syncTransactions(
        new Date('2026-06-01'),
        new Date('2026-06-02'),
      );
      expect(count).toBe(MOCK_TRANSACTIONS.length);

      const tx = await prisma.transaction.findFirst({
        where: { biotimeTransactionId: MOCK_TRANSACTIONS[0].id },
      });
      expect(tx?.empCode).toBe('E1001');
    });

    it('does not re-import the same punch', async () => {
      await syncService.syncEmployees();
      await syncService.syncTransactions(new Date('2026-06-01'), new Date('2026-06-02'));
      await syncService.syncTransactions(new Date('2026-06-01'), new Date('2026-06-02'));
      expect(await prisma.transaction.count()).toBe(MOCK_TRANSACTIONS.length);
    });

    it('links punches to the matching employee profile', async () => {
      await syncService.syncEmployees();
      await syncService.syncTransactions(new Date('2026-06-01'), new Date('2026-06-02'));
      const tx = await prisma.transaction.findFirstOrThrow({ where: { empCode: 'E1001' } });
      expect(tx.employeeId).toBeTruthy();
    });
  });

  describe('duplicate punch marking', () => {
    beforeEach(async () => {
      const cfg = await prisma.bioTimeConfig.findFirstOrThrow();
      await prisma.bioTimeConfig.update({
        where: { id: cfg.id },
        data: { duplicateGraceMinutes: 5, duplicatePolicy: 'mark' },
      });
    });

    async function punch(id: number, iso: string, state = '0') {
      return prisma.transaction.create({
        data: {
          empCode: 'DUP1',
          biotimeTransactionId: id,
          punchTime: new Date(iso),
          punchState: state,
        },
      });
    }

    it('leaves a lone punch unmarked', async () => {
      const tx = await punch(1, '2026-06-01T08:00:00.000Z');
      await applyDuplicateMarking(tx.id, { duplicateGraceMinutes: 5, duplicatePolicy: 'mark' });
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      expect(row.isDuplicate).toBe(false);
    });

    it('marks a second identical punch inside the grace window', async () => {
      const first = await punch(1, '2026-06-01T08:00:00.000Z');
      const second = await punch(2, '2026-06-01T08:02:00.000Z');
      await applyDuplicateMarking(first.id, { duplicateGraceMinutes: 5, duplicatePolicy: 'mark' });
      await applyDuplicateMarking(second.id, { duplicateGraceMinutes: 5, duplicatePolicy: 'mark' });

      const rows = await prisma.transaction.findMany({ orderBy: { punchTime: 'asc' } });
      expect(rows[0].isDuplicate).toBe(false);
      expect(rows[1].isDuplicate).toBe(true);
      expect(rows[1].duplicateOfId).toBe(rows[0].id);
    });

    it('keeps a punch outside the grace window', async () => {
      const first = await punch(1, '2026-06-01T08:00:00.000Z');
      const later = await punch(2, '2026-06-01T08:30:00.000Z');
      await applyDuplicateMarking(later.id, { duplicateGraceMinutes: 5, duplicatePolicy: 'mark' });
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: later.id } });
      expect(row.isDuplicate).toBe(false);
      void first;
    });

    it('does not treat a check-out as a duplicate check-in', async () => {
      await punch(1, '2026-06-01T08:00:00.000Z', '0');
      const out = await punch(2, '2026-06-01T08:02:00.000Z', '1');
      await applyDuplicateMarking(out.id, { duplicateGraceMinutes: 5, duplicatePolicy: 'mark' });
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: out.id } });
      expect(row.isDuplicate).toBe(false);
    });

    it('marks nothing when the grace window is disabled', async () => {
      await punch(1, '2026-06-01T08:00:00.000Z');
      const second = await punch(2, '2026-06-01T08:01:00.000Z');
      await applyDuplicateMarking(second.id, { duplicateGraceMinutes: 0, duplicatePolicy: 'mark' });
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: second.id } });
      expect(row.isDuplicate).toBe(false);
    });
  });

  describe('sync endpoints', () => {
    it('reports sync status from local data only', async () => {
      const data = expectOk(await rpc('/api/biotime/config/sync-status', {}, hr.token));
      expect(data.counts).toBeDefined();
      expect(BioTimeConnector.fromDb).not.toHaveBeenCalled();
    });

    it('reports config counts without calling BioTime', async () => {
      const data = expectOk(await rpc('/api/biotime/config/get', {}, hr.token));
      expect((data.config as { employeeCount: number }).employeeCount).toBeTypeOf('number');
      expect(BioTimeConnector.fromDb).not.toHaveBeenCalled();
    });

    it('syncs employees through the endpoint', async () => {
      expectOk(await rpc('/api/biotime/config/sync-employees', {}, hr.token), 'sync-employees');
      expect(await prisma.employeeProfile.count()).toBeGreaterThan(0);
    });

    it('surfaces a connector failure as a business error, not a crash', async () => {
      vi.mocked(BioTimeConnector.fromDb).mockImplementation(async () => {
        throw new Error('BioTime unreachable');
      });
      const res = await rpc('/api/biotime/config/sync-employees', {}, hr.token);
      expect(res.status).toBeLessThan(500);
      expect(res.body.result?.success).toBe(false);
    });

    it('lists sync jobs', async () => {
      const data = expectOk(await rpc('/api/biotime/config/sync-jobs/list', {}, hr.token));
      expect(Array.isArray(data.jobs ?? data.items)).toBe(true);
    });

    it('tests the connection through the endpoint', async () => {
      const res = await rpc('/api/biotime/config/test-connection', {}, hr.token);
      expect(res.body.result).toBeDefined();
    });
  });
});
