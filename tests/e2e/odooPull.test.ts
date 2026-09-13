import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../src/prisma/client';

vi.mock('../../src/services/odoo/odooClient.service', () => ({
  odooCall: vi.fn(),
  testOdooConnection: vi.fn(async () => ({ ok: true, message: 'ok' })),
  odooFindEmployeeIdByCode: vi.fn(async () => null),
  getOdooConfig: vi.fn(async () => ({ id: 'odoo1', baseUrl: 'https://x.odoo.com' })),
}));

import * as odooClient from '../../src/services/odoo/odooClient.service';
import {
  pullAdvancesLongFromOdoo,
  pullAdvancesShortFromOdoo,
  pullAllFromOdoo,
  pullDeductionsFromOdoo,
  pullEmployeesFromOdoo,
  pullPayrollsFromOdoo,
  pullShiftAssignmentsFromOdoo,
  pullShiftsFromOdoo,
} from '../../src/services/odoo/odooPull.service';
import { ensureBioTimeConfig, resetDatabase } from '../helpers/db';

type Stats = Parameters<typeof pullEmployeesFromOdoo>[0];

function stats(): Stats {
  return {
    employees: 0,
    shifts: 0,
    assignments: 0,
    shiftGrids: 0,
    gridLines: 0,
    deductions: 0,
    advancesShort: 0,
    advancesLong: 0,
    payrolls: 0,
    payrollLines: 0,
    skipped: 0,
    errors: 0,
  };
}

/** Route each Odoo endpoint to a canned payload; anything unmapped returns empty. */
function route(map: Record<string, unknown[]>) {
  vi.mocked(odooClient.odooCall).mockImplementation(async (path: string, params?: Record<string, unknown>) => {
    const offset = Number(params?.offset ?? 0);
    const items = map[path] ?? [];
    // Serve everything on the first page, then signal exhaustion.
    return (offset === 0
      ? { items, total: items.length }
      : { items: [], total: items.length }) as never;
  });
}

describe('Odoo pull (client mocked)', () => {
  beforeEach(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    vi.clearAllMocks();
    vi.mocked(odooClient.testOdooConnection).mockResolvedValue({ ok: true, message: 'ok' });
  });

  describe('employees', () => {
    it('creates local employees from Odoo rows', async () => {
      route({
        '/api/biotime/employees/list': [
          {
            id: 501,
            name: 'Odoo Person',
            displayName: 'Odoo Person',
            code: 'O501',
            identificationId: 'O501',
            job: 'Cashier',
            basicSalary: 4200,
            active: true,
          },
        ],
      });

      const s = stats();
      await pullEmployeesFromOdoo(s);

      expect(s.employees).toBe(1);
      const row = await prisma.employeeProfile.findFirstOrThrow({ where: { code: 'O501' } });
      expect(row.name).toBe('Odoo Person');
      expect(row.basicSalary).toBe(4200);
      expect(row.jobTitle).toBe('Cashier');
    });

    it('records an id mapping so a second pull updates instead of duplicating', async () => {
      route({
        '/api/biotime/employees/list': [
          { id: 501, name: 'Odoo Person', code: 'O501', identificationId: 'O501', basicSalary: 4200 },
        ],
      });
      await pullEmployeesFromOdoo(stats());

      route({
        '/api/biotime/employees/list': [
          { id: 501, name: 'Renamed Person', code: 'O501', identificationId: 'O501', basicSalary: 5000 },
        ],
      });
      await pullEmployeesFromOdoo(stats());

      expect(await prisma.employeeProfile.count({ where: { code: 'O501' } })).toBe(1);
      const row = await prisma.employeeProfile.findFirstOrThrow({ where: { code: 'O501' } });
      expect(row.name).toBe('Renamed Person');
      expect(row.basicSalary).toBe(5000);
    });

    it('adopts an existing local employee matched on code', async () => {
      const local = await prisma.employeeProfile.create({
        data: { name: 'Local Person', code: 'O777', identificationId: 'O777' },
      });
      route({
        '/api/biotime/employees/list': [
          { id: 777, name: 'Odoo Name', code: 'O777', identificationId: 'O777' },
        ],
      });
      await pullEmployeesFromOdoo(stats());

      expect(await prisma.employeeProfile.count()).toBe(1);
      const row = await prisma.employeeProfile.findUniqueOrThrow({ where: { id: local.id } });
      expect(row.name).toBe('Odoo Name');
    });

    it('imports inactive employees as inactive', async () => {
      route({
        '/api/biotime/employees/list': [
          { id: 502, name: 'Archived Person', code: 'O502', active: false },
        ],
      });
      await pullEmployeesFromOdoo(stats());
      const row = await prisma.employeeProfile.findFirstOrThrow({ where: { code: 'O502' } });
      expect(row.active).toBe(false);
    });

    it('counts a failing row as an error and keeps going', async () => {
      route({
        '/api/biotime/employees/list': [
          { id: 503, name: 'Good', code: 'O503' },
          { id: 504 }, // no name/code, still creates a fallback name
        ],
      });
      const s = stats();
      await pullEmployeesFromOdoo(s);
      expect(s.employees + s.errors).toBe(2);
    });

    it('stops when Odoo returns no rows', async () => {
      route({ '/api/biotime/employees/list': [] });
      const s = stats();
      await pullEmployeesFromOdoo(s);
      expect(s.employees).toBe(0);
    });
  });

  describe('shifts and assignments', () => {
    it('creates shifts from Odoo', async () => {
      route({
        '/api/biotime/shifts/list': [
          {
            id: 900,
            name: 'Odoo Morning',
            code: 'OM1',
            startTime: 8,
            endTime: 17,
            breakDuration: 1,
            isOvernight: false,
          },
        ],
      });
      const s = stats();
      await pullShiftsFromOdoo(s);
      expect(s.shifts).toBe(1);
      const shift = await prisma.shift.findFirstOrThrow({ where: { name: 'Odoo Morning' } });
      expect(shift.startTime).toBeTruthy();
    });

    it('skips an assignment whose employee was never pulled', async () => {
      route({
        '/api/biotime/shift-assignments/list': [
          { id: 1, employeeId: 99999, shiftId: 88888, dateFrom: '2026-06-01' },
        ],
      });
      const s = stats();
      await pullShiftAssignmentsFromOdoo(s, 50);
      expect(await prisma.shiftAssignment.count()).toBe(0);
      expect(s.skipped + s.errors).toBeGreaterThan(0);
    });
  });

  describe('payroll-related pulls', () => {
    it('skips deductions for unknown employees', async () => {
      route({
        '/api/biotime/deductions/list': [
          { id: 5, employeeId: 99999, type: 'fines', amount: 100, date: '2026-06-10' },
        ],
      });
      const s = stats();
      await pullDeductionsFromOdoo(s, 50);
      expect(await prisma.deduction.count()).toBe(0);
      expect(s.skipped + s.errors).toBeGreaterThan(0);
    });

    it('skips short advances for unknown employees', async () => {
      route({
        '/api/biotime/advances/short/list': [
          { id: 5, employeeId: 99999, amount: 500, date: '2026-06-10' },
        ],
      });
      const s = stats();
      await pullAdvancesShortFromOdoo(s, 50);
      expect(await prisma.advanceShort.count()).toBe(0);
    });

    it('skips long advances for unknown employees', async () => {
      route({
        '/api/biotime/advances/long/list': [
          { id: 5, employeeId: 99999, totalAmount: 6000, installments: 6 },
        ],
      });
      const s = stats();
      await pullAdvancesLongFromOdoo(s, 50);
      expect(await prisma.advanceLong.count()).toBe(0);
    });

    it('handles an empty payroll list', async () => {
      route({ '/api/biotime/payroll/list': [] });
      const s = stats();
      await pullPayrollsFromOdoo(s, 50);
      expect(s.payrolls).toBe(0);
    });
  });

  describe('pullAllFromOdoo', () => {
    it('refuses to run when the connection test fails', async () => {
      vi.mocked(odooClient.testOdooConnection).mockResolvedValue({
        ok: false,
        message: 'ECONNREFUSED',
      });
      await expect(pullAllFromOdoo()).rejects.toThrow(/ECONNREFUSED/);
    });

    it('runs every stage by default and returns a stats block', async () => {
      route({});
      const result = await pullAllFromOdoo();
      expect(result).toMatchObject({ employees: 0, shifts: 0, errors: 0 });

      const paths = vi.mocked(odooClient.odooCall).mock.calls.map(([p]) => p);
      expect(paths).toEqual(
        expect.arrayContaining([
          '/api/biotime/employees/list',
          '/api/biotime/shifts/list',
          '/api/biotime/deductions/list',
          '/api/biotime/payroll/list',
        ]),
      );
    });

    it('pulls only the selected stage', async () => {
      route({});
      await pullAllFromOdoo({ employees: true });
      const paths = vi.mocked(odooClient.odooCall).mock.calls.map(([p]) => p);
      expect(paths).toContain('/api/biotime/employees/list');
      expect(paths).not.toContain('/api/biotime/payroll/list');
    });

    it('pulls employees then payrolls when both are selected', async () => {
      route({});
      await pullAllFromOdoo({ employees: true, payrolls: true });
      const paths = vi.mocked(odooClient.odooCall).mock.calls.map(([p]) => p);
      expect(paths).toContain('/api/biotime/employees/list');
      expect(paths).toContain('/api/biotime/payroll/list');
      expect(paths).not.toContain('/api/biotime/shifts/list');
    });
  });
});
