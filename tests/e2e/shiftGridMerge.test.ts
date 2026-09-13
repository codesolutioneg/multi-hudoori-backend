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

/**
 * The schedule is filled in weekly and merged at month end, then payroll runs on
 * the merged grid. The last test is the one that matters: payroll must produce
 * the same figures from one merged grid as it would from a single month-long one.
 */
describe('shift grid merge', () => {
  let hr: SeededUser;
  let shiftId: string;
  let employeeId: string;
  let locationId: string;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    // Config rows survive resetDatabase, and one spec changes the month start
    // day, so it is restored here to keep the specs independent.
    await prisma.bioTimeConfig.updateMany({ data: { payrollMonthStartDay: 26 } });
    hr = await createUser({ login: 'merge.hr@test.local', role: UserRole.HR_MANAGER });
    const location = await createLocation();
    locationId = location.id;
    const shift = await createShift();
    shiftId = shift.id;
    const employee = await prisma.employeeProfile.create({
      data: { name: 'Merge Person', code: 'M001', basicSalary: 3000, locationId },
    });
    employeeId = employee.id;
  });

  /** A week of scheduled days for the one employee. */
  async function createWeek(name: string, from: string, to: string): Promise<string> {
    const grid = await prisma.shiftGrid.create({
      data: {
        name,
        dateFrom: new Date(`${from}T00:00:00.000Z`),
        dateTo: new Date(`${to}T00:00:00.000Z`),
        state: ShiftGridState.grid,
        locationId,
      },
    });
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
      await prisma.shiftGridLine.create({
        data: { gridId: grid.id, employeeId, date: new Date(d), shiftId },
      });
    }
    return grid.id;
  }

  describe('candidates and preview', () => {
    it('lists unmerged grids inside the payroll month', async () => {
      await createWeek('W1', '2026-06-01', '2026-06-07');
      await createWeek('W2', '2026-06-08', '2026-06-14');

      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/candidates',
          { reference: '2026-06-15', monthStartDay: 1 },
          hr.token,
        ),
      );
      expect(data.dateFrom).toBe('2026-06-01');
      expect(data.dateTo).toBe('2026-06-30');
      expect((data.grids as unknown[]).length).toBe(2);
      expect((data.grids as { dayCount: number }[]).map((g) => g.dayCount)).toEqual([7, 7]);
    });

    it('offers the boundary weeks that straddle a mid-month period', async () => {
      // Weeks never line up with a period closing on the 25th, so a candidates
      // query that required containment would drop the days at each end.
      await createWeek('Straddles start', '2026-06-22', '2026-06-28');
      await createWeek('Inside', '2026-06-29', '2026-07-05');
      await createWeek('Straddles end', '2026-07-20', '2026-07-26');
      await createWeek('Next period', '2026-07-27', '2026-08-02');

      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/candidates',
          { reference: '2026-07-10', monthStartDay: 26 },
          hr.token,
        ),
      );
      expect(data.dateFrom).toBe('2026-06-26');
      expect(data.dateTo).toBe('2026-07-25');
      const names = (data.grids as { name: string }[]).map((g) => g.name).sort();
      expect(names).toEqual(['Inside', 'Straddles end', 'Straddles start']);
    });

    it('honours a payroll month that starts mid-month', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/candidates',
          { reference: '2026-07-03', monthStartDay: 26 },
          hr.token,
        ),
      );
      expect(data.dateFrom).toBe('2026-06-26');
      expect(data.dateTo).toBe('2026-07-25');
    });

    it('reports uncovered days so a missing week is visible', async () => {
      const w1 = await createWeek('W1', '2026-06-01', '2026-06-07');
      // Deliberate gap: 8 to 14 June is never scheduled.
      const w3 = await createWeek('W3', '2026-06-15', '2026-06-21');

      const data = expectOk(
        await rpc('/api/biotime/shift-grid/merge/preview', { sourceGridIds: [w1, w3] }, hr.token),
      );
      expect(data.dateFrom).toBe('2026-06-01');
      expect(data.dateTo).toBe('2026-06-21');
      expect((data.missingDates as string[]).length).toBe(7);
      expect(data.missingDates).toContain('2026-06-08');
      expect(data.overlappingDayCount).toBe(0);
      expect(data.coveredDayCount).toBe(14);
    });

    it('counts overlapping days without writing anything', async () => {
      const w1 = await createWeek('W1', '2026-06-01', '2026-06-07');
      const overlap = await createWeek('Overlap', '2026-06-05', '2026-06-11');

      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/preview',
          { sourceGridIds: [w1, overlap] },
          hr.token,
        ),
      );
      expect(data.overlappingDayCount).toBe(3);
      expect(data.overlappingEmployeeDayCount).toBe(3);
      expect(data.coveredDayCount).toBe(11);
      expect(await prisma.shiftGrid.count()).toBe(2);
    });

    it('reports one overlapping calendar day even if many employees share it', async () => {
      const w1 = await createWeek('W1', '2026-06-01', '2026-06-07');
      const overlap = await createWeek('Overlap', '2026-06-07', '2026-06-13');
      const employee2 = await prisma.employeeProfile.create({
        data: { name: 'Merge Person 2', code: 'M002', basicSalary: 3000, locationId },
      });
      await prisma.shiftGridLine.createMany({
        data: [
          {
            gridId: w1,
            employeeId: employee2.id,
            date: new Date('2026-06-07T00:00:00.000Z'),
            shiftId,
          },
          {
            gridId: overlap,
            employeeId: employee2.id,
            date: new Date('2026-06-07T00:00:00.000Z'),
            shiftId,
          },
        ],
      });

      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/preview',
          { sourceGridIds: [w1, overlap] },
          hr.token,
        ),
      );
      expect(data.overlappingDayCount).toBe(1);
      expect(data.overlappingEmployeeDayCount).toBe(2);
      expect(data.coveredDayCount).toBe(13);
    });
  });

  describe('merging', () => {
    it('marks source weeks as already added to the monthly merge', async () => {
      const w1 = await createWeek('W1', '2026-06-01', '2026-06-07');
      const w2 = await createWeek('W2', '2026-06-08', '2026-06-14');

      const data = expectOk(
        await rpc('/api/biotime/shift-grid/merge', { sourceGridIds: [w1, w2] }, hr.token),
      );
      expect(data.appended).toBe(false);

      const sources = await prisma.shiftGrid.findMany({ where: { id: { in: [w1, w2] } } });
      expect(sources.every((g) => g.mergedIntoGridId === String(data.gridId))).toBe(true);

      const candidates = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/candidates',
          { reference: '2026-06-15', monthStartDay: 1 },
          hr.token,
        ),
      );
      expect((candidates.grids as unknown[]).length).toBe(0);
      expect((candidates.consumed as unknown[]).length).toBe(2);
      expect((candidates.targets as { id: string }[]).map((t) => t.id)).toContain(String(data.gridId));
    });

    it('appends a later week into the existing monthly merge', async () => {
      const w1 = await createWeek('W1', '2026-06-01', '2026-06-07');
      const w2 = await createWeek('W2', '2026-06-08', '2026-06-14');
      const w3 = await createWeek('W3', '2026-06-15', '2026-06-21');
      const first = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge',
          {
            sourceGridIds: [w1, w2],
            periodFrom: '2026-06-01',
            periodTo: '2026-06-30',
          },
          hr.token,
        ),
      );

      const appended = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge',
          {
            sourceGridIds: [w3],
            targetGridId: String(first.gridId),
            periodFrom: '2026-06-01',
            periodTo: '2026-06-30',
          },
          hr.token,
        ),
      );
      expect(appended.appended).toBe(true);
      expect(appended.gridId).toBe(first.gridId);
      expect(appended.lineCount).toBe(21);

      const monthly = await prisma.shiftGrid.findUniqueOrThrow({
        where: { id: String(first.gridId) },
      });
      expect(monthly.mergedFromGridIds.sort()).toEqual([w1, w2, w3].sort());

      const week3 = await prisma.shiftGrid.findUniqueOrThrow({ where: { id: w3 } });
      expect(week3.mergedIntoGridId).toBe(String(first.gridId));

      // Cannot merge the same week again.
      expectFail(
        await rpc(
          '/api/biotime/shift-grid/merge',
          { sourceGridIds: [w3], targetGridId: String(first.gridId) },
          hr.token,
        ),
      );
    });

    it('produces one grid spanning the whole period', async () => {
      const w1 = await createWeek('W1', '2026-06-01', '2026-06-07');
      const w2 = await createWeek('W2', '2026-06-08', '2026-06-14');

      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge',
          { sourceGridIds: [w1, w2], name: 'يونيو المدمج' },
          hr.token,
        ),
      );
      expect(data.dateFrom).toBe('2026-06-01');
      expect(data.dateTo).toBe('2026-06-14');
      expect(data.lineCount).toBe(14);
      expect(data.employeeCount).toBe(1);

      const merged = await prisma.shiftGrid.findUniqueOrThrow({
        where: { id: String(data.gridId) },
      });
      expect(merged.mergedFromGridIds.sort()).toEqual([w1, w2].sort());
      expect(merged.mergedAt).not.toBeNull();
      // The sources survive: the weekly sheets stay auditable.
      expect(await prisma.shiftGrid.count()).toBe(3);
    });

    it('keeps every scheduling flag on a merged day', async () => {
      const w1 = await createWeek('W1', '2026-06-01', '2026-06-07');
      const w2 = await createWeek('W2', '2026-06-08', '2026-06-14');
      await prisma.shiftGridLine.updateMany({
        where: { gridId: w1, date: new Date('2026-06-03T00:00:00.000Z') },
        data: { isAnnualLeave: true, isOff: false },
      });
      await prisma.shiftGridLine.updateMany({
        where: { gridId: w1, date: new Date('2026-06-04T00:00:00.000Z') },
        data: { isSick: true },
      });

      const data = expectOk(
        await rpc('/api/biotime/shift-grid/merge', { sourceGridIds: [w1, w2] }, hr.token),
      );
      const leave = await prisma.shiftGridLine.findFirstOrThrow({
        where: { gridId: String(data.gridId), date: new Date('2026-06-03T00:00:00.000Z') },
      });
      expect(leave.isAnnualLeave).toBe(true);
      const sick = await prisma.shiftGridLine.findFirstOrThrow({
        where: { gridId: String(data.gridId), date: new Date('2026-06-04T00:00:00.000Z') },
      });
      expect(sick.isSick).toBe(true);
    });

    it('resolves an overlapping day to the later grid by default', async () => {
      const first = await createWeek('First', '2026-06-01', '2026-06-07');
      const second = await createWeek('Second', '2026-06-05', '2026-06-11');
      await prisma.shiftGridLine.updateMany({
        where: { gridId: second, date: new Date('2026-06-05T00:00:00.000Z') },
        data: { isOff: true },
      });

      const data = expectOk(
        await rpc('/api/biotime/shift-grid/merge', { sourceGridIds: [first, second] }, hr.token),
      );
      expect((data.conflicts as unknown[]).length).toBe(3);
      const contested = await prisma.shiftGridLine.findFirstOrThrow({
        where: { gridId: String(data.gridId), date: new Date('2026-06-05T00:00:00.000Z') },
      });
      expect(contested.isOff).toBe(true);
      // The unique constraint means one row per employee and day, always.
      const count = await prisma.shiftGridLine.count({
        where: { gridId: String(data.gridId), date: new Date('2026-06-05T00:00:00.000Z') },
      });
      expect(count).toBe(1);
    });

    it('can prefer the earlier grid instead', async () => {
      const first = await createWeek('First', '2026-06-01', '2026-06-07');
      const second = await createWeek('Second', '2026-06-05', '2026-06-11');
      await prisma.shiftGridLine.updateMany({
        where: { gridId: second, date: new Date('2026-06-05T00:00:00.000Z') },
        data: { isOff: true },
      });

      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge',
          { sourceGridIds: [first, second], conflictStrategy: 'earliest_grid' },
          hr.token,
        ),
      );
      const contested = await prisma.shiftGridLine.findFirstOrThrow({
        where: { gridId: String(data.gridId), date: new Date('2026-06-05T00:00:00.000Z') },
      });
      expect(contested.isOff).toBe(false);
    });

    it('refuses to merge on conflict when asked to fail', async () => {
      const first = await createWeek('First', '2026-06-01', '2026-06-07');
      const second = await createWeek('Second', '2026-06-05', '2026-06-11');
      expectFail(
        await rpc(
          '/api/biotime/shift-grid/merge',
          { sourceGridIds: [first, second], conflictStrategy: 'fail' },
          hr.token,
        ),
      );
      // Nothing partial is left behind.
      expect(await prisma.shiftGrid.count()).toBe(2);
    });

    it('rejects a single grid, a merged grid, and mixed locations', async () => {
      const w1 = await createWeek('W1', '2026-06-01', '2026-06-07');
      const w2 = await createWeek('W2', '2026-06-08', '2026-06-14');
      expectFail(await rpc('/api/biotime/shift-grid/merge', { sourceGridIds: [w1] }, hr.token));

      const merged = expectOk(
        await rpc('/api/biotime/shift-grid/merge', { sourceGridIds: [w1, w2] }, hr.token),
      );
      const w3 = await createWeek('W3', '2026-06-15', '2026-06-21');
      expectFail(
        await rpc(
          '/api/biotime/shift-grid/merge',
          { sourceGridIds: [String(merged.gridId), w3] },
          hr.token,
        ),
      );

      const otherLocation = await createLocation({ name: 'Other', code: 'LOC-002' });
      const foreign = await prisma.shiftGrid.create({
        data: {
          name: 'Foreign',
          dateFrom: new Date('2026-06-22T00:00:00.000Z'),
          dateTo: new Date('2026-06-28T00:00:00.000Z'),
          state: ShiftGridState.grid,
          locationId: otherLocation.id,
        },
      });
      await prisma.shiftGridLine.create({
        data: {
          gridId: foreign.id,
          employeeId,
          date: new Date('2026-06-22T00:00:00.000Z'),
          shiftId,
        },
      });
      expectFail(
        await rpc('/api/biotime/shift-grid/merge', { sourceGridIds: [w3, foreign.id] }, hr.token),
      );
    });
  });

  describe('the configured month start day', () => {
    it('round-trips through the config API and drives the default range', async () => {
      const saved = expectOk(
        await rpc('/api/biotime/config/update', { payrollMonthStartDay: 26 }, hr.token),
      );
      expect((saved.config as Record<string, unknown>).payrollMonthStartDay).toBe(26);

      const reread = expectOk(await rpc('/api/biotime/config/get', {}, hr.token));
      expect((reread.config as Record<string, unknown>).payrollMonthStartDay).toBe(26);

      // No monthStartDay passed: the stored value has to be what takes effect.
      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/candidates',
          { reference: '2026-07-10' },
          hr.token,
        ),
      );
      expect(data.dateFrom).toBe('2026-06-26');
      expect(data.dateTo).toBe('2026-07-25');
      expect(data.monthStartDay).toBe(26);
    });

    it('rejects a day outside 1 to 31', async () => {
      expectFail(await rpc('/api/biotime/config/update', { payrollMonthStartDay: 0 }, hr.token));
      expectFail(await rpc('/api/biotime/config/update', { payrollMonthStartDay: 32 }, hr.token));
    });
  });

  describe('clamping to the payroll period', () => {
    /**
     * The branch closes mid-month, so the boundary weeks straddle the period.
     * Without clamping, the merged grid would span 22 June to 26 July and
     * payroll created from it would inherit that wider range.
     */
    it('clamps the merged grid to the requested period', async () => {
      const weeks = [
        await createWeek('W0', '2026-06-22', '2026-06-28'),
        await createWeek('W1', '2026-06-29', '2026-07-05'),
        await createWeek('W2', '2026-07-20', '2026-07-26'),
      ];

      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge',
          {
            sourceGridIds: weeks,
            periodFrom: '2026-06-26',
            periodTo: '2026-07-25',
          },
          hr.token,
        ),
      );
      expect(data.dateFrom).toBe('2026-06-26');
      expect(data.dateTo).toBe('2026-07-25');
      // 22-25 June and 26 July fall in the neighbouring periods.
      expect(data.outOfPeriodLineCount).toBe(5);

      const dates = (
        await prisma.shiftGridLine.findMany({
          where: { gridId: String(data.gridId) },
          orderBy: { date: 'asc' },
        })
      ).map((l) => l.date.toISOString().slice(0, 10));
      expect(dates[0]).toBe('2026-06-26');
      expect(dates[dates.length - 1]).toBe('2026-07-25');
    });

    it('spans the source grids when no period is given', async () => {
      const weeks = [
        await createWeek('W0', '2026-06-22', '2026-06-28'),
        await createWeek('W1', '2026-06-29', '2026-07-05'),
      ];
      const data = expectOk(
        await rpc('/api/biotime/shift-grid/merge', { sourceGridIds: weeks }, hr.token),
      );
      expect(data.dateFrom).toBe('2026-06-22');
      expect(data.dateTo).toBe('2026-07-05');
      expect(data.outOfPeriodLineCount).toBe(0);
    });

    it('reports gaps against the period, not the source edges', async () => {
      const weeks = [
        await createWeek('W0', '2026-06-22', '2026-06-28'),
        await createWeek('W2', '2026-07-20', '2026-07-26'),
      ];
      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/preview',
          { sourceGridIds: weeks, periodFrom: '2026-06-26', periodTo: '2026-07-25' },
          hr.token,
        ),
      );
      expect(data.dateFrom).toBe('2026-06-26');
      expect(data.dateTo).toBe('2026-07-25');
      // 29 June to 19 July is scheduled by nobody.
      expect((data.missingDates as string[]).length).toBe(21);
      expect(data.outOfPeriodLineCount).toBe(5);
    });

    it('rejects half a period', async () => {
      const weeks = [
        await createWeek('W0', '2026-06-22', '2026-06-28'),
        await createWeek('W1', '2026-06-29', '2026-07-05'),
      ];
      expectFail(
        await rpc(
          '/api/biotime/shift-grid/merge',
          { sourceGridIds: weeks, periodFrom: '2026-06-26' },
          hr.token,
        ),
      );
    });
  });

  describe('location scoping', () => {
    it('never shows a branch manager another branch\'s merge candidates', async () => {
      await createWeek('Mine', '2026-06-01', '2026-06-07');
      const other = await createLocation({ name: 'Other branch', code: 'LOC-OTHER' });
      const foreignGrid = await prisma.shiftGrid.create({
        data: {
          name: 'Theirs',
          dateFrom: new Date('2026-06-08T00:00:00.000Z'),
          dateTo: new Date('2026-06-14T00:00:00.000Z'),
          state: ShiftGridState.grid,
          locationId: other.id,
        },
      });
      const manager = await createUser({
        login: 'branch.manager@test.local',
        role: UserRole.BRANCH_MANAGER,
        locationId,
      });

      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/candidates',
          { reference: '2026-06-15', monthStartDay: 1 },
          manager.token,
        ),
      );
      const ids = (data.grids as { id: string }[]).map((g) => g.id);
      expect(ids).not.toContain(foreignGrid.id);
      expect(ids).toHaveLength(1);
    });

    it('rejects asking for another location outright', async () => {
      const other = await createLocation({ name: 'Other branch', code: 'LOC-OTHER2' });
      const manager = await createUser({
        login: 'branch.manager2@test.local',
        role: UserRole.BRANCH_MANAGER,
        locationId,
      });
      expectFail(
        await rpc(
          '/api/biotime/shift-grid/merge/candidates',
          { locationId: other.id },
          manager.token,
        ),
        'ACCESS_DENIED',
      );
    });

    it('still shows every branch to an HR manager', async () => {
      await createWeek('Mine', '2026-06-01', '2026-06-07');
      const other = await createLocation({ name: 'Other branch', code: 'LOC-OTHER3' });
      await prisma.shiftGrid.create({
        data: {
          name: 'Theirs',
          dateFrom: new Date('2026-06-08T00:00:00.000Z'),
          dateTo: new Date('2026-06-14T00:00:00.000Z'),
          state: ShiftGridState.grid,
          locationId: other.id,
        },
      });
      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/candidates',
          { reference: '2026-06-15', monthStartDay: 1 },
          hr.token,
        ),
      );
      expect((data.grids as unknown[]).length).toBe(2);
    });
  });

  describe('Option A — cross-location merge (last week branch)', () => {
    async function createWeekAt(
      name: string,
      from: string,
      to: string,
      locId: string,
    ): Promise<string> {
      const grid = await prisma.shiftGrid.create({
        data: {
          name,
          dateFrom: new Date(`${from}T00:00:00.000Z`),
          dateTo: new Date(`${to}T00:00:00.000Z`),
          state: ShiftGridState.grid,
          locationId: locId,
        },
      });
      const start = new Date(`${from}T00:00:00.000Z`);
      const end = new Date(`${to}T00:00:00.000Z`);
      for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
        await prisma.shiftGridLine.create({
          data: { gridId: grid.id, employeeId, date: new Date(d), shiftId },
        });
      }
      return grid.id;
    }

    it('pulls earlier days from other branches into the home branch merge', async () => {
      const locB = await createLocation({ name: 'Branch B', code: 'LOC-B' });
      const wA1 = await createWeekAt('A-W1', '2026-06-26', '2026-07-02', locationId);
      const wA2 = await createWeekAt('A-W2', '2026-07-03', '2026-07-09', locationId);
      const wB3 = await createWeekAt('B-W3', '2026-07-10', '2026-07-16', locB.id);
      const wB4 = await createWeekAt('B-W4', '2026-07-17', '2026-07-23', locB.id);

      const mergedB = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge',
          {
            sourceGridIds: [wB3, wB4],
            periodFrom: '2026-06-26',
            periodTo: '2026-07-25',
          },
          hr.token,
        ),
      );
      expect(mergedB.crossLocationMode).toBe('last_week');
      expect(mergedB.crossLocationLineCount).toBeGreaterThan(0);
      expect(mergedB.employeeCount).toBe(1);
      // 7 days × 4 weeks = 28, minus days outside period on boundary weeks
      expect(mergedB.lineCount).toBe(28);

      expectFail(
        await rpc(
          '/api/biotime/shift-grid/merge',
          {
            sourceGridIds: [wA1, wA2],
            periodFrom: '2026-06-26',
            periodTo: '2026-07-25',
          },
          hr.token,
        ),
      );
    });

    it('lists movers in merge candidates', async () => {
      const locB = await createLocation({ name: 'Branch B2', code: 'LOC-B2' });
      await createWeekAt('A-W1', '2026-06-26', '2026-07-02', locationId);
      await createWeekAt('B-W2', '2026-07-10', '2026-07-16', locB.id);

      const data = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/candidates',
          { reference: '2026-07-15', monthStartDay: 26 },
          hr.token,
        ),
      );
      const movers = data.movers as { employeeId: string; homeLocationId: string }[];
      expect(movers.length).toBe(1);
      expect(movers[0].employeeId).toBe(employeeId);
      expect(movers[0].homeLocationId).toBe(locB.id);
    });
  });

  describe('payroll on the merged grid', () => {
    it('matches a payroll built from one month-long grid', async () => {
      // Punches every day of June so neither payroll is mass-absent.
      const rows: {
        employeeId: string;
        empCode: string;
        biotimeTransactionId: number;
        punchTime: Date;
        punchState: string;
      }[] = [];
      let txId = 810000;
      for (let d = 1; d <= 28; d++) {
        const day = String(d).padStart(2, '0');
        rows.push({
          employeeId,
          empCode: 'M001',
          biotimeTransactionId: txId++,
          punchTime: new Date(`2026-06-${day}T05:00:00.000Z`),
          punchState: '0',
        });
        rows.push({
          employeeId,
          empCode: 'M001',
          biotimeTransactionId: txId++,
          punchTime: new Date(`2026-06-${day}T14:00:00.000Z`),
          punchState: '1',
        });
      }
      await prisma.transaction.createMany({ data: rows });

      // Four weekly grids covering 1 to 28 June, then merged.
      const weeks = [
        await createWeek('W1', '2026-06-01', '2026-06-07'),
        await createWeek('W2', '2026-06-08', '2026-06-14'),
        await createWeek('W3', '2026-06-15', '2026-06-21'),
        await createWeek('W4', '2026-06-22', '2026-06-28'),
      ];
      const merged = expectOk(
        await rpc('/api/biotime/shift-grid/merge', { sourceGridIds: weeks }, hr.token),
      );
      expect(merged.lineCount).toBe(28);

      const mergedCreate = expectOk(
        await rpc(
          '/api/biotime/payroll/create',
          { shiftGridId: String(merged.gridId) },
          hr.token,
        ),
      );
      const mergedPayrollId = String((mergedCreate.payroll as { id: string }).id);
      expectOk(
        await rpc('/api/biotime/payroll/calculate', { id: mergedPayrollId }, hr.token),
        'merged calculate',
      );
      const mergedLine = await prisma.payrollLine.findFirstOrThrow({
        where: { payrollId: mergedPayrollId, employeeId },
      });

      // The same 28 days as a single grid, for comparison.
      const singleGridId = await createWeek('Whole month', '2026-06-01', '2026-06-28');
      const singleCreate = expectOk(
        await rpc('/api/biotime/payroll/create', { shiftGridId: singleGridId }, hr.token),
      );
      const singlePayrollId = String((singleCreate.payroll as { id: string }).id);
      expectOk(
        await rpc('/api/biotime/payroll/calculate', { id: singlePayrollId }, hr.token),
        'single calculate',
      );
      const singleLine = await prisma.payrollLine.findFirstOrThrow({
        where: { payrollId: singlePayrollId, employeeId },
      });

      expect(mergedLine.workingDays).toBe(singleLine.workingDays);
      expect(mergedLine.netSalary).toBe(singleLine.netSalary);
      expect(mergedLine.totalDeductions).toBe(singleLine.totalDeductions);
      expect(mergedLine.lateDeductibleDays).toBe(singleLine.lateDeductibleDays);
    });
  });
});
