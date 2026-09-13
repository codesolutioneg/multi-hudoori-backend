import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ShiftGridState, UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createShift,
  createUser,
  ensureBioTimeConfig,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';

describe('shift grid', () => {
  let hr: SeededUser;
  let shiftId: string;
  let employeeIds: string[];

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hr = await createUser({ login: 'hr@test.local', role: UserRole.HR_MANAGER });
    const shift = await createShift();
    shiftId = shift.id;
    employeeIds = [];
    for (let i = 0; i < 3; i++) {
      const emp = await prisma.employeeProfile.create({
        data: { name: `Grid Employee ${i}`, code: `G10${i}`, basicSalary: 3000 },
      });
      employeeIds.push(emp.id);
      await prisma.shiftAssignment.create({
        data: {
          employeeId: emp.id,
          shiftId,
          dateFrom: new Date('2026-01-01'),
          assignmentType: 'permanent',
          active: true,
        },
      });
    }
  });

  async function createGrid(overrides: Record<string, unknown> = {}) {
    const res = await rpc(
      '/api/biotime/shift-grid/create',
      {
        name: 'June grid',
        dateFrom: '2026-06-01',
        dateTo: '2026-06-07',
        selectionMethod: 'manual',
        employeeIds,
        ...overrides,
      },
      hr.token,
    );
    const data = expectOk(res, 'shift-grid/create');
    return (data.grid as { id: string }).id;
  }

  describe('create and generate', () => {
    it('creates a grid in setup state', async () => {
      const gridId = await createGrid();
      const grid = await prisma.shiftGrid.findUniqueOrThrow({ where: { id: gridId } });
      expect(grid.state).toBe(ShiftGridState.setup);
      expect(grid.name).toBe('June grid');
    });

    it('generates one line per employee per day', async () => {
      const gridId = await createGrid({ generate: true });
      const count = await prisma.shiftGridLine.count({ where: { gridId } });
      expect(count).toBe(3 * 7);
    });

    it('generates on demand after creation', async () => {
      const gridId = await createGrid();
      expect(await prisma.shiftGridLine.count({ where: { gridId } })).toBe(0);
      expectOk(
        await rpc('/api/biotime/shift-grid/generate', { gridId, employeeIds }, hr.token),
        'generate',
      );
      expect(await prisma.shiftGridLine.count({ where: { gridId } })).toBeGreaterThan(0);
    });

    it('attaches the grid to a location when selected by location', async () => {
      const location = await createLocation({ name: 'Branch X', code: 'LOC-X' });
      const gridId = await createGrid({ selectionMethod: 'location', locationId: location.id });
      const grid = await prisma.shiftGrid.findUniqueOrThrow({ where: { id: gridId } });
      expect(grid.locationId).toBe(location.id);
    });
  });

  describe('read', () => {
    it('lists grids', async () => {
      await createGrid();
      const data = expectOk(await rpc('/api/biotime/shift-grid/list', {}, hr.token));
      expect((data.grids as unknown[]).length).toBe(1);
    });

    it('gets a grid with paginated employee rows', async () => {
      const gridId = await createGrid({ generate: true });
      const data = expectOk(
        await rpc('/api/biotime/shift-grid/get', { id: gridId, employeeLimit: 2, employeeOffset: 0 }, hr.token),
      );
      expect(data.grid).toBeDefined();
    });

    it('fails for an unknown grid', async () => {
      expectFail(await rpc('/api/biotime/shift-grid/get', { id: 'nope' }, hr.token));
    });

    /**
     * The branch runs an operation and a kitchen department, and the weekly
     * sheet goes out per department, so the grid has to section by department
     * and not only by job title.
     */
    it('sections rows by department when asked, and by job otherwise', async () => {
      const kitchen = await prisma.department.create({
        data: { name: 'kitchen', code: 'DEPT-K' },
      });
      const operation = await prisma.department.create({
        data: { name: 'operation', code: 'DEPT-O' },
      });
      await prisma.employeeProfile.update({
        where: { id: employeeIds[0] },
        data: { departmentId: kitchen.id, jobTitle: 'Cook' },
      });
      await prisma.employeeProfile.update({
        where: { id: employeeIds[1] },
        data: { departmentId: operation.id, jobTitle: 'Waiter' },
      });
      await prisma.employeeProfile.update({
        where: { id: employeeIds[2] },
        data: { departmentId: kitchen.id, jobTitle: 'Waiter' },
      });
      const gridId = await createGrid({ generate: true });

      const byDepartment = expectOk(
        await rpc(
          '/api/biotime/shift-grid/get',
          { id: gridId, grouping: 'department' },
          hr.token,
        ),
      );
      const departmentGroups = (byDepartment.data as Record<string, unknown>)
        .job_groups as Record<string, unknown[]>;
      expect(Object.keys(departmentGroups).sort()).toEqual(['kitchen', 'operation']);
      expect(departmentGroups['kitchen']).toHaveLength(2);
      expect(departmentGroups['operation']).toHaveLength(1);
      expect((byDepartment.data as Record<string, unknown>).grouping).toBe('department');

      const byJob = expectOk(
        await rpc('/api/biotime/shift-grid/get', { id: gridId }, hr.token),
      );
      const jobGroups = (byJob.data as Record<string, unknown>).job_groups as Record<
        string,
        unknown[]
      >;
      expect(Object.keys(jobGroups).sort()).toEqual(['Cook', 'Waiter']);
      expect((byJob.data as Record<string, unknown>).grouping).toBe('job');
    });

    it('buckets employees with no department under a single section', async () => {
      const gridId = await createGrid({ generate: true });
      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/get',
          { id: gridId, grouping: 'department' },
          hr.token,
        ),
      );
      const groups = (data.data as Record<string, unknown>).job_groups as Record<
        string,
        unknown[]
      >;
      expect(Object.keys(groups)).toEqual(['بدون قسم']);
      expect(groups['بدون قسم']).toHaveLength(3);
    });
  });

  describe('cells', () => {
    let gridId: string;

    beforeEach(async () => {
      gridId = await createGrid({ generate: true });
    });

    it('marks a single cell as an off day', async () => {
      const line = await prisma.shiftGridLine.findFirstOrThrow({ where: { gridId } });
      expectOk(
        await rpc(
          '/api/biotime/shift-grid/cell/update',
          { gridId, lineId: line.id, cellValue: 'off' },
          hr.token,
        ),
        'cell/update',
      );
      const updated = await prisma.shiftGridLine.findUniqueOrThrow({ where: { id: line.id } });
      expect(updated.isOff).toBe(true);
    });

    it('marks a cell as sick leave', async () => {
      const line = await prisma.shiftGridLine.findFirstOrThrow({ where: { gridId } });
      expectOk(
        await rpc('/api/biotime/shift-grid/cell/update', { gridId, lineId: line.id, cellValue: 'sick' }, hr.token),
        'cell/update sick',
      );
      const updated = await prisma.shiftGridLine.findUniqueOrThrow({ where: { id: line.id } });
      expect(updated.isSick).toBe(true);
    });

    it('rejects a line that belongs to another grid', async () => {
      const otherGridId = await createGrid({ name: 'Other grid', generate: true });
      const foreignLine = await prisma.shiftGridLine.findFirstOrThrow({ where: { gridId: otherGridId } });
      expectFail(
        await rpc('/api/biotime/shift-grid/cell/update', { gridId, lineId: foreignLine.id, cellValue: 'off' }, hr.token),
        'NOT_FOUND',
      );
    });

    it('refuses cell edits once the grid is confirmed', async () => {
      const line = await prisma.shiftGridLine.findFirstOrThrow({ where: { gridId } });
      await rpc('/api/biotime/shift-grid/confirm', { gridId }, hr.token);
      expectFail(
        await rpc('/api/biotime/shift-grid/cell/update', { gridId, lineId: line.id, cellValue: 'off' }, hr.token),
        'UPDATE_FAILED',
      );
    });

    it('applies a bulk change across an employee row', async () => {
      const employeeId = employeeIds[0];
      expectOk(
        await rpc('/api/biotime/shift-grid/bulk/row', { gridId, employeeId, cellValue: 'off' }, hr.token),
        'bulk/row',
      );
      const lines = await prisma.shiftGridLine.findMany({ where: { gridId, employeeId } });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.isOff)).toBe(true);
    });

    it('rejects a bulk row range outside the grid period', async () => {
      expectFail(
        await rpc(
          '/api/biotime/shift-grid/bulk/row',
          { gridId, employeeId: employeeIds[0], cellValue: 'off', dateFrom: '2026-05-01', dateTo: '2026-05-10' },
          hr.token,
        ),
        'VALIDATION',
      );
    });

    it('applies a bulk change down a date column', async () => {
      const date = '2026-06-03';
      expectOk(
        await rpc('/api/biotime/shift-grid/bulk/column', { gridId, date, cellValue: 'off' }, hr.token),
        'bulk/column',
      );
      const lines = await prisma.shiftGridLine.findMany({
        where: { gridId, date: new Date(`${date}T00:00:00.000Z`) },
      });
      expect(lines.length).toBe(3);
      expect(lines.every((l) => l.isOff)).toBe(true);
    });
  });

  describe('membership', () => {
    let gridId: string;

    beforeEach(async () => {
      gridId = await createGrid({ generate: true });
    });

    it('adds an employee to an existing grid', async () => {
      const newbie = await prisma.employeeProfile.create({
        data: { name: 'Newbie', code: 'G900', basicSalary: 3000 },
      });
      await prisma.shiftAssignment.create({
        data: {
          employeeId: newbie.id,
          shiftId,
          dateFrom: new Date('2026-01-01'),
          assignmentType: 'permanent',
          active: true,
        },
      });

      expectOk(
        await rpc('/api/biotime/shift-grid/add-employee', { gridId, employeeId: newbie.id }, hr.token),
        'add-employee',
      );
      expect(
        await prisma.shiftGridLine.count({ where: { gridId, employeeId: newbie.id } }),
      ).toBeGreaterThan(0);
    });

    it('refuses to remove an employee who still has shifts on the grid', async () => {
      expectFail(
        await rpc('/api/biotime/shift-grid/remove-employee', { gridId, employeeId: employeeIds[0] }, hr.token),
        'VALIDATION',
      );
    });

    it('removes an employee whose cells are entirely blank', async () => {
      const employeeId = employeeIds[0];
      // Any flag (including "off") counts as an assignment, so blank every cell.
      await prisma.shiftGridLine.updateMany({
        where: { gridId, employeeId },
        data: {
          shiftId: null,
          isOff: false,
          isSick: false,
          isAnnualLeave: false,
          isExcluded: false,
          isBusDelay: false,
          isPresent: false,
          isFinished: false,
          isResignation: false,
          isWorkAbsence: false,
          isWorkInjury: false,
          isMarriageLeave: false,
        },
      });
      expectOk(
        await rpc('/api/biotime/shift-grid/remove-employee', { gridId, employeeId }, hr.token),
        'remove-employee',
      );
      expect(await prisma.shiftGridLine.count({ where: { gridId, employeeId } })).toBe(0);
    });
  });

  describe('lifecycle', () => {
    let gridId: string;

    beforeEach(async () => {
      gridId = await createGrid({ generate: true });
    });

    it('confirms, closes, then reopens a grid', async () => {
      expectOk(await rpc('/api/biotime/shift-grid/confirm', { gridId }, hr.token), 'confirm');
      let grid = await prisma.shiftGrid.findUniqueOrThrow({ where: { id: gridId } });
      expect(grid.state).toBe(ShiftGridState.confirmed);

      // close is a lock: it also lands on `confirmed` (there is no separate closed state)
      expectOk(await rpc('/api/biotime/shift-grid/close', { gridId }, hr.token), 'close');
      grid = await prisma.shiftGrid.findUniqueOrThrow({ where: { id: gridId } });
      expect(grid.state).toBe(ShiftGridState.confirmed);

      expectOk(await rpc('/api/biotime/shift-grid/reopen', { gridId }, hr.token), 'reopen');
      grid = await prisma.shiftGrid.findUniqueOrThrow({ where: { id: gridId } });
      expect(grid.state).toBe(ShiftGridState.grid);
    });

    it('returns a confirmed grid to setup', async () => {
      await rpc('/api/biotime/shift-grid/confirm', { gridId }, hr.token);
      expectOk(await rpc('/api/biotime/shift-grid/back-to-setup', { gridId }, hr.token), 'back-to-setup');
      const grid = await prisma.shiftGrid.findUniqueOrThrow({ where: { id: gridId } });
      expect(grid.state).toBe(ShiftGridState.setup);
    });
  });

  describe('location scoping', () => {
    it('hides other branches from a branch manager', async () => {
      const branchA = await createLocation({ name: 'Branch A', code: 'LOC-A' });
      const branchB = await createLocation({ name: 'Branch B', code: 'LOC-B' });
      await prisma.shiftGrid.create({
        data: { name: 'A grid', dateFrom: new Date('2026-06-01'), dateTo: new Date('2026-06-07'), locationId: branchA.id },
      });
      await prisma.shiftGrid.create({
        data: { name: 'B grid', dateFrom: new Date('2026-06-01'), dateTo: new Date('2026-06-07'), locationId: branchB.id },
      });

      const manager = await createUser({
        login: 'bm-a@test.local',
        role: UserRole.BRANCH_MANAGER,
        locationId: branchA.id,
      });
      const data = expectOk(await rpc('/api/biotime/shift-grid/list', {}, manager.token));
      const names = (data.grids as { name: string }[]).map((g) => g.name);
      expect(names).toContain('A grid');
      expect(names).not.toContain('B grid');
    });

    it('refuses cross-branch access to a specific grid', async () => {
      const branchA = await createLocation({ name: 'Branch A', code: 'LOC-A' });
      const branchB = await createLocation({ name: 'Branch B', code: 'LOC-B' });
      const foreign = await prisma.shiftGrid.create({
        data: { name: 'B grid', dateFrom: new Date('2026-06-01'), dateTo: new Date('2026-06-07'), locationId: branchB.id },
      });
      const manager = await createUser({
        login: 'bm-a2@test.local',
        role: UserRole.BRANCH_MANAGER,
        locationId: branchA.id,
      });
      expectFail(await rpc('/api/biotime/shift-grid/get', { id: foreign.id }, manager.token), 'ACCESS_DENIED');
    });
  });
});
