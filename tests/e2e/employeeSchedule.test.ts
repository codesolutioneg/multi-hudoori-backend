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
 * The schedule an employee sees in the app. A grid line is an override of the
 * standing pattern, so the two must not disagree, and after a merge a date is
 * covered by two grids at once.
 */
describe('my schedule', () => {
  let employee: SeededUser;
  let hr: SeededUser;
  let shiftId: string;
  let locationId: string;
  let departmentId: string;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    // resetDatabase deliberately preserves config rows, so the settings these
    // specs change are put back explicitly rather than leaking into the next one.
    await prisma.bioTimeConfig.updateMany({
      data: {
        gridWeekStartDay: 0,
        employeeTeamScheduleScope: 'department',
        employeeTeamShowShiftTimes: true,
        employeeTeamShowOffDays: true,
        employeeTeamShowLeave: false,
        employeeTeamShowSickLeave: false,
      },
    });
    const location = await createLocation();
    locationId = location.id;
    const department = await prisma.department.create({
      data: { name: 'kitchen', code: 'DEPT-SCHED' },
    });
    departmentId = department.id;
    const shift = await createShift({ name: 'Morning', code: 'M' });
    shiftId = shift.id;

    hr = await createUser({ login: 'sched.hr@test.local', role: UserRole.HR_MANAGER });
    employee = await createUser({
      login: 'sched.emp@test.local',
      role: UserRole.EMPLOYEE,
      locationId,
      employee: { code: 'S001', name: 'Schedule Person', locationId },
    });
    await prisma.employeeProfile.update({
      where: { id: employee.employeeId! },
      data: { departmentId },
    });
  });

  async function createGridWithLine(
    name: string,
    from: string,
    to: string,
    lineDate: string,
    flags: Record<string, unknown> = {},
  ): Promise<string> {
    const grid = await prisma.shiftGrid.create({
      data: {
        name,
        dateFrom: new Date(`${from}T00:00:00.000Z`),
        dateTo: new Date(`${to}T00:00:00.000Z`),
        state: ShiftGridState.grid,
        locationId,
      },
    });
    await prisma.shiftGridLine.create({
      data: {
        gridId: grid.id,
        employeeId: employee.employeeId!,
        date: new Date(`${lineDate}T00:00:00.000Z`),
        shiftId,
        ...flags,
      },
    });
    return grid.id;
  }

  it('returns the week containing today, aligned to the configured start day', async () => {
    const data = expectOk(await rpc('/api/biotime/my-schedule', {}, employee.token));
    expect((data.days as unknown[]).length).toBe(7);
    expect(data.weekStartDay).toBe(0);
    // Default start day is Sunday, so the range must begin on a Sunday.
    expect(new Date(`${data.dateFrom}T00:00:00.000Z`).getUTCDay()).toBe(0);
    expect(data.employeeId).toBe(employee.employeeId);
    expect(data.departmentName).toBe('kitchen');
  });

  it('honours a configured week start day', async () => {
    expectOk(await rpc('/api/biotime/config/update', { gridWeekStartDay: 6 }, hr.token));
    const data = expectOk(await rpc('/api/biotime/my-schedule', {}, employee.token));
    expect(data.weekStartDay).toBe(6);
    expect(new Date(`${data.dateFrom}T00:00:00.000Z`).getUTCDay()).toBe(6);
  });

  it('shows a shift from the grid for that day', async () => {
    await createGridWithLine('W', '2026-06-07', '2026-06-13', '2026-06-08');
    const data = expectOk(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '2026-06-07', dateTo: '2026-06-13' },
        employee.token,
      ),
    );
    const days = data.days as { date: string; shiftName: string; fromPattern: boolean }[];
    const monday = days.find((d) => d.date === '2026-06-08')!;
    expect(monday.shiftName).toBe('Morning');
    expect(monday.fromPattern).toBe(false);
    // Days with nothing scheduled stay blank rather than guessing.
    expect(days.find((d) => d.date === '2026-06-09')!.shiftName).toBe('');
  });

  it('labels rest days and leave from the grid flags', async () => {
    await createGridWithLine('W', '2026-06-07', '2026-06-13', '2026-06-08', {
      shiftId: null,
      isOff: true,
    });
    await prisma.shiftGridLine.create({
      data: {
        gridId: (await prisma.shiftGrid.findFirstOrThrow()).id,
        employeeId: employee.employeeId!,
        date: new Date('2026-06-09T00:00:00.000Z'),
        isAnnualLeave: true,
      },
    });
    const data = expectOk(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '2026-06-07', dateTo: '2026-06-13' },
        employee.token,
      ),
    );
    const days = data.days as { date: string; label: string; isOff: boolean; isLeave: boolean }[];
    expect(days.find((d) => d.date === '2026-06-08')!.isOff).toBe(true);
    expect(days.find((d) => d.date === '2026-06-09')!.isLeave).toBe(true);
    expect(days.find((d) => d.date === '2026-06-09')!.label).toBe('إجازة سنوية');
  });

  it('falls back to the standing pattern only where no grid covers the day', async () => {
    await prisma.shiftAssignment.create({
      data: {
        employeeId: employee.employeeId!,
        shiftId,
        dateFrom: new Date('2026-01-01'),
        assignmentType: 'permanent',
        active: true,
      },
    });
    // A grid marks the Monday as a rest day, overriding the pattern.
    await createGridWithLine('W', '2026-06-07', '2026-06-13', '2026-06-08', {
      shiftId: null,
      isOff: true,
    });

    const data = expectOk(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '2026-06-07', dateTo: '2026-06-13' },
        employee.token,
      ),
    );
    const days = data.days as { date: string; isOff: boolean; fromPattern: boolean }[];
    const overridden = days.find((d) => d.date === '2026-06-08')!;
    expect(overridden.isOff).toBe(true);
    expect(overridden.fromPattern).toBe(false);
    // Tuesday has no grid line, so the pattern fills it in.
    const patterned = days.find((d) => d.date === '2026-06-09')!;
    expect(patterned.fromPattern).toBe(true);
    expect(patterned.isOff).toBe(false);
  });

  it('prefers the merged grid when two grids cover the same day', async () => {
    const weekly = await createGridWithLine('Weekly', '2026-06-07', '2026-06-13', '2026-06-08', {
      isOff: true,
      shiftId: null,
    });
    // The merge creates its grid after the sources, so it must win.
    const merged = await prisma.shiftGrid.create({
      data: {
        name: 'Merged',
        dateFrom: new Date('2026-06-07T00:00:00.000Z'),
        dateTo: new Date('2026-06-13T00:00:00.000Z'),
        state: ShiftGridState.grid,
        locationId,
        mergedFromGridIds: [weekly],
        mergedAt: new Date(),
      },
    });
    await prisma.shiftGridLine.create({
      data: {
        gridId: merged.id,
        employeeId: employee.employeeId!,
        date: new Date('2026-06-08T00:00:00.000Z'),
        shiftId,
      },
    });

    const data = expectOk(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '2026-06-07', dateTo: '2026-06-13' },
        employee.token,
      ),
    );
    const monday = (data.days as { date: string; shiftName: string; isOff: boolean }[]).find(
      (d) => d.date === '2026-06-08',
    )!;
    expect(monday.shiftName).toBe('Morning');
    expect(monday.isOff).toBe(false);
  });

  /**
   * Rows are written a day at a time the moment an employee joins a grid, long
   * before HR fills the week in, so "a row exists" is not "HR decided nothing".
   */
  it('reads the standing pattern through a grid row HR has not filled', async () => {
    await prisma.shiftAssignment.create({
      data: {
        employeeId: employee.employeeId!,
        shiftId,
        dateFrom: new Date('2026-01-01'),
        assignmentType: 'permanent',
        active: true,
      },
    });
    await createGridWithLine('W', '2026-06-07', '2026-06-13', '2026-06-08', { shiftId: null });

    const data = expectOk(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '2026-06-07', dateTo: '2026-06-13' },
        employee.token,
      ),
    );
    const monday = (
      data.days as { date: string; shiftName: string; fromPattern: boolean; label: string }[]
    ).find((d) => d.date === '2026-06-08')!;
    expect(monday.shiftName).toBe('Morning');
    expect(monday.fromPattern).toBe(true);
    expect(monday.label).not.toBe('');
  });

  it('keeps a filled row from an older grid over a blank row in a newer one', async () => {
    await createGridWithLine('Weekly', '2026-06-07', '2026-06-13', '2026-06-08');
    const newer = await prisma.shiftGrid.create({
      data: {
        name: 'Newer',
        dateFrom: new Date('2026-06-07T00:00:00.000Z'),
        dateTo: new Date('2026-06-13T00:00:00.000Z'),
        state: ShiftGridState.grid,
        locationId,
      },
    });
    await prisma.shiftGridLine.create({
      data: {
        gridId: newer.id,
        employeeId: employee.employeeId!,
        date: new Date('2026-06-08T00:00:00.000Z'),
      },
    });

    const data = expectOk(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '2026-06-07', dateTo: '2026-06-13' },
        employee.token,
      ),
    );
    const monday = (data.days as { date: string; shiftName: string }[]).find(
      (d) => d.date === '2026-06-08',
    )!;
    expect(monday.shiftName).toBe('Morning');
  });

  it('leaves the day blank when nothing fills the grid row and no pattern exists', async () => {
    await createGridWithLine('W', '2026-06-07', '2026-06-13', '2026-06-08', { shiftId: null });

    const data = expectOk(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '2026-06-07', dateTo: '2026-06-13' },
        employee.token,
      ),
    );
    const monday = (data.days as { date: string; label: string; shiftId: string | null }[]).find(
      (d) => d.date === '2026-06-08',
    )!;
    expect(monday.label).toBe('');
    expect(monday.shiftId).toBeNull();
  });

  /**
   * The team view is for the roles that run a branch, not for the branch
   * employee. `/my-schedule` pins an EMPLOYEE account to its own row whatever
   * HR configures, so these specs sign in as the branch manager and assert the
   * employee's own blindness separately.
   */
  describe('the department view', () => {
    let viewer: SeededUser;

    beforeEach(async () => {
      const other = await prisma.department.create({
        data: { name: 'operation', code: 'DEPT-OTHER' },
      });
      await prisma.employeeProfile.create({
        data: { name: 'Same Department', code: 'S002', departmentId, locationId },
      });
      await prisma.employeeProfile.create({
        data: { name: 'Other Department', code: 'S003', departmentId: other.id, locationId },
      });
      const otherBranch = await createLocation({ name: 'Other branch', code: 'LOC-SCHED2' });
      await prisma.employeeProfile.create({
        data: { name: 'Other Branch', code: 'S004', departmentId, locationId: otherBranch.id },
      });
      viewer = await createUser({
        login: 'sched.lead@test.local',
        role: UserRole.BRANCH_MANAGER,
        locationId,
        employee: { code: 'S005', name: 'Branch Lead', locationId },
      });
      await prisma.employeeProfile.update({
        where: { id: viewer.employeeId! },
        data: { departmentId },
      });
    });

    it('shows only the same department in the same branch, including the employee', async () => {
      const data = expectOk(await rpc('/api/biotime/my-schedule', {}, viewer.token));
      expect(data.teamVisible).toBe(true);
      const team = data.team as { department: string; members: { name: string }[] }[];
      expect(team).toHaveLength(1);
      expect(team[0].department).toBe('kitchen');
      const names = team[0].members.map((m) => m.name).sort();
      expect(names).toEqual(['Branch Lead', 'Same Department', 'Schedule Person']);
    });

    it('marks which row is the employee', async () => {
      const data = expectOk(await rpc('/api/biotime/my-schedule', {}, viewer.token));
      const team = data.team as { members: { name: string; isSelf: boolean }[] }[];
      const self = team[0].members.filter((m) => m.isSelf);
      expect(self).toHaveLength(1);
      expect(self[0].name).toBe('Branch Lead');
    });

    /**
     * The guard for the rule above: whatever HR sets, an EMPLOYEE account is
     * shown its own week and nothing else.
     */
    it('shows an EMPLOYEE account no colleagues at any scope', async () => {
      for (const scope of ['department', 'branch', 'all']) {
        expectOk(
          await rpc(
            '/api/biotime/config/update',
            { employeeTeamScheduleScope: scope },
            hr.token,
          ),
        );
        const data = expectOk(await rpc('/api/biotime/my-schedule', {}, employee.token));
        expect(data.teamVisible).toBe(false);
        expect(data.teamScope).toBe('none');
        expect(data.team).toEqual([]);
      }
    });

    /**
     * A colleague's absence reason is health or disciplinary information. Others
     * see a shift or nothing, and every non-working day looks the same.
     */
    it('never reveals why a teammate is not working', async () => {
      const teammate = await prisma.employeeProfile.findFirstOrThrow({
        where: { code: 'S002' },
      });
      const grid = await prisma.shiftGrid.create({
        data: {
          name: 'W',
          dateFrom: new Date('2026-06-07T00:00:00.000Z'),
          dateTo: new Date('2026-06-13T00:00:00.000Z'),
          state: ShiftGridState.grid,
          locationId,
        },
      });
      // Sick, work injury and resignation all spell themselves out in the label.
      await prisma.shiftGridLine.createMany({
        data: [
          {
            gridId: grid.id,
            employeeId: teammate.id,
            date: new Date('2026-06-08T00:00:00.000Z'),
            isSick: true,
          },
          {
            gridId: grid.id,
            employeeId: teammate.id,
            date: new Date('2026-06-09T00:00:00.000Z'),
            isWorkInjury: true,
          },
          {
            gridId: grid.id,
            employeeId: teammate.id,
            date: new Date('2026-06-10T00:00:00.000Z'),
            isAnnualLeave: true,
          },
          {
            gridId: grid.id,
            employeeId: teammate.id,
            date: new Date('2026-06-11T00:00:00.000Z'),
            shiftId,
          },
        ],
      });

      const data = expectOk(
        await rpc(
          '/api/biotime/my-schedule',
          { dateFrom: '2026-06-07', dateTo: '2026-06-13' },
          viewer.token,
        ),
      );
      const payload = JSON.stringify(data);
      expect(payload).not.toContain('إجازة مرضية');
      expect(payload).not.toContain('اصابه عمل');
      expect(payload).not.toContain('إجازة سنوية');

      const team = data.team as { members: { name: string; days: Record<string, unknown>[] }[] }[];
      const other = team[0].members.find((m) => m.name === 'Same Department')!;
      const byDate = new Map(other.days.map((d) => [d.date as string, d]));
      for (const date of ['2026-06-08', '2026-06-09', '2026-06-10']) {
        expect(byDate.get(date)!.isSick).toBe(false);
        expect(byDate.get(date)!.isLeave).toBe(false);
        expect(byDate.get(date)!.label).toBe('off');
      }
      // A real shift is still visible, which is the point of the view.
      expect(byDate.get('2026-06-11')!.shiftName).toBe('Morning');
    });

    it('reveals a colleague\'s leave or sickness only when switched on', async () => {
      const teammate = await prisma.employeeProfile.findFirstOrThrow({
        where: { code: 'S002' },
      });
      const grid = await prisma.shiftGrid.create({
        data: {
          name: 'W',
          dateFrom: new Date('2026-06-07T00:00:00.000Z'),
          dateTo: new Date('2026-06-13T00:00:00.000Z'),
          state: ShiftGridState.grid,
          locationId,
        },
      });
      await prisma.shiftGridLine.createMany({
        data: [
          {
            gridId: grid.id,
            employeeId: teammate.id,
            date: new Date('2026-06-08T00:00:00.000Z'),
            isAnnualLeave: true,
          },
          {
            gridId: grid.id,
            employeeId: teammate.id,
            date: new Date('2026-06-09T00:00:00.000Z'),
            isSick: true,
          },
        ],
      });
      const week = { dateFrom: '2026-06-07', dateTo: '2026-06-13' };

      // Leave on, sickness still off: one becomes readable, the other must not.
      expectOk(
        await rpc('/api/biotime/config/update', { employeeTeamShowLeave: true }, hr.token),
      );
      let data = expectOk(await rpc('/api/biotime/my-schedule', week, viewer.token));
      expect(JSON.stringify(data)).toContain('إجازة سنوية');
      expect(JSON.stringify(data)).not.toContain('إجازة مرضية');

      expectOk(
        await rpc('/api/biotime/config/update', { employeeTeamShowSickLeave: true }, hr.token),
      );
      data = expectOk(await rpc('/api/biotime/my-schedule', week, viewer.token));
      expect(JSON.stringify(data)).toContain('إجازة مرضية');
    });

    it('can hide shift times while still showing the shift', async () => {
      const teammate = await prisma.employeeProfile.findFirstOrThrow({
        where: { code: 'S002' },
      });
      const grid = await prisma.shiftGrid.create({
        data: {
          name: 'W',
          dateFrom: new Date('2026-06-07T00:00:00.000Z'),
          dateTo: new Date('2026-06-13T00:00:00.000Z'),
          state: ShiftGridState.grid,
          locationId,
        },
      });
      await prisma.shiftGridLine.create({
        data: {
          gridId: grid.id,
          employeeId: teammate.id,
          date: new Date('2026-06-08T00:00:00.000Z'),
          shiftId,
        },
      });
      const week = { dateFrom: '2026-06-07', dateTo: '2026-06-13' };

      const withTimes = expectOk(await rpc('/api/biotime/my-schedule', week, viewer.token));
      const readDay = (data: Record<string, unknown>) => {
        const team = data.team as { members: { name: string; days: Record<string, unknown>[] }[] }[];
        const other = team.flatMap((sec) => sec.members).find((m) => m.name === 'Same Department')!;
        return other.days.find((d) => d.date === '2026-06-08')!;
      };
      expect(readDay(withTimes).startTime).toBe('08:00');

      expectOk(
        await rpc('/api/biotime/config/update', { employeeTeamShowShiftTimes: false }, hr.token),
      );
      const without = expectOk(await rpc('/api/biotime/my-schedule', week, viewer.token));
      expect(readDay(without).startTime).toBe('');
      // The shift itself is still there, only the hours are withheld.
      expect(readDay(without).shiftName).toBe('Morning');
    });

    it('can hide rest days so an absence is not readable at all', async () => {
      expectOk(
        await rpc('/api/biotime/config/update', { employeeTeamShowOffDays: false }, hr.token),
      );
      const data = expectOk(await rpc('/api/biotime/my-schedule', {}, viewer.token));
      const team = data.team as { members: { name: string; days: Record<string, unknown>[] }[] }[];
      const other = team.flatMap((sec) => sec.members).find((m) => m.name === 'Same Department')!;
      for (const day of other.days) {
        expect(day.label).toBe('');
        expect(day.isOff).toBe(false);
      }
    });

    /**
     * The strongest form of the guarantee: a hidden absence and an ordinary rest
     * day must be identical field for field, not merely both labelled "off".
     * Anything that varies between them is the absence, readable by inference.
     */
    it('makes a hidden absence byte-identical to an ordinary rest day', async () => {
      const teammate = await prisma.employeeProfile.findFirstOrThrow({
        where: { code: 'S002' },
      });
      // A weekly pattern, which is the type that honours the per-day off flags,
      // gives Friday off. That is an ordinary pattern rest day to compare
      // against, and it arrives with fromPattern true before redaction.
      await prisma.shiftAssignment.create({
        data: {
          employeeId: teammate.id,
          shiftId,
          dateFrom: new Date('2026-01-01'),
          assignmentType: 'weekly',
          active: true,
          fridayIsOff: true,
        },
      });
      const grid = await prisma.shiftGrid.create({
        data: {
          name: 'W',
          dateFrom: new Date('2026-06-07T00:00:00.000Z'),
          dateTo: new Date('2026-06-13T00:00:00.000Z'),
          state: ShiftGridState.grid,
          locationId,
        },
      });
      // Monday is a grid-entered sick day, which the default policy hides.
      await prisma.shiftGridLine.create({
        data: {
          gridId: grid.id,
          employeeId: teammate.id,
          date: new Date('2026-06-08T00:00:00.000Z'),
          isSick: true,
        },
      });

      const data = expectOk(
        await rpc(
          '/api/biotime/my-schedule',
          { dateFrom: '2026-06-07', dateTo: '2026-06-13' },
          viewer.token,
        ),
      );
      const team = data.team as { members: { name: string; days: Record<string, unknown>[] }[] }[];
      const other = team.flatMap((sec) => sec.members).find((m) => m.name === 'Same Department')!;
      const byDate = new Map(other.days.map((d) => [d.date as string, d]));

      const hiddenSick = { ...byDate.get('2026-06-08')! };
      const ordinaryOff = { ...byDate.get('2026-06-12')! };
      // Only the date and weekday may differ.
      delete hiddenSick.date;
      delete hiddenSick.weekday;
      delete ordinaryOff.date;
      delete ordinaryOff.weekday;
      expect(hiddenSick).toEqual(ordinaryOff);
    });

    it('still shows the employee their own absence reason', async () => {
      const grid = await prisma.shiftGrid.create({
        data: {
          name: 'W',
          dateFrom: new Date('2026-06-07T00:00:00.000Z'),
          dateTo: new Date('2026-06-13T00:00:00.000Z'),
          state: ShiftGridState.grid,
          locationId,
        },
      });
      await prisma.shiftGridLine.create({
        data: {
          gridId: grid.id,
          employeeId: viewer.employeeId!,
          date: new Date('2026-06-08T00:00:00.000Z'),
          isSick: true,
        },
      });
      const data = expectOk(
        await rpc(
          '/api/biotime/my-schedule',
          { dateFrom: '2026-06-07', dateTo: '2026-06-13' },
          viewer.token,
        ),
      );
      const mine = (data.days as Record<string, unknown>[]).find(
        (d) => d.date === '2026-06-08',
      )!;
      expect(mine.isSick).toBe(true);
      expect(mine.label).toBe('إجازة مرضية');
    });

    it('widens to the whole branch at the branch scope', async () => {
      expectOk(
        await rpc(
          '/api/biotime/config/update',
          { employeeTeamScheduleScope: 'branch' },
          hr.token,
        ),
      );
      const data = expectOk(await rpc('/api/biotime/my-schedule', {}, viewer.token));
      expect(data.teamScope).toBe('branch');
      const names = (data.team as { members: { name: string }[] }[])
          .flatMap((sec) => sec.members.map((m) => m.name))
          .sort();
      // Same branch, both departments. Never the other branch.
      expect(names).toEqual([
        'Branch Lead',
        'Other Department',
        'Same Department',
        'Schedule Person',
      ]);
    });

    it('covers every branch at the all scope', async () => {
      expectOk(
        await rpc('/api/biotime/config/update', { employeeTeamScheduleScope: 'all' }, hr.token),
      );
      const data = expectOk(await rpc('/api/biotime/my-schedule', {}, viewer.token));
      const names = (data.team as { members: { name: string }[] }[])
          .flatMap((sec) => sec.members.map((m) => m.name))
          .sort();
      expect(names).toContain('Other Branch');
      expect(names).toHaveLength(5);
    });

    it('still needs a branch for the branch scope', async () => {
      expectOk(
        await rpc(
          '/api/biotime/config/update',
          { employeeTeamScheduleScope: 'branch' },
          hr.token,
        ),
      );
      await prisma.employeeProfile.update({
        where: { id: viewer.employeeId! },
        data: { locationId: null },
      });
      const data = expectOk(await rpc('/api/biotime/my-schedule', {}, viewer.token));
      expect(data.teamVisible).toBe(false);
    });

    it('needs no scope field at the all scope', async () => {
      expectOk(
        await rpc('/api/biotime/config/update', { employeeTeamScheduleScope: 'all' }, hr.token),
      );
      await prisma.employeeProfile.update({
        where: { id: viewer.employeeId! },
        data: { departmentId: null, locationId: null },
      });
      const data = expectOk(await rpc('/api/biotime/my-schedule', {}, viewer.token));
      expect(data.teamVisible).toBe(true);
    });

    it('falls back to department scope for an unknown value', async () => {
      expectOk(
        await rpc(
          '/api/biotime/config/update',
          { employeeTeamScheduleScope: 'nonsense' },
          hr.token,
        ),
      );
      const data = expectOk(await rpc('/api/biotime/my-schedule', {}, viewer.token));
      expect(data.teamScope).toBe('department');
    });

    it('hides colleagues entirely at the none scope', async () => {
      expectOk(
        await rpc(
          '/api/biotime/config/update',
          { employeeTeamScheduleScope: 'none' },
          hr.token,
        ),
      );
      const data = expectOk(await rpc('/api/biotime/my-schedule', {}, viewer.token));
      expect(data.teamVisible).toBe(false);
      expect(data.team).toEqual([]);
      // The employee still sees their own week.
      expect((data.days as unknown[]).length).toBe(7);
    });
  });

  it('answers with an empty week for a user with no employee profile', async () => {
    const admin = await createUser({ login: 'sched.admin@test.local', role: UserRole.PLATFORM_ADMIN });
    const data = expectOk(await rpc('/api/biotime/my-schedule', {}, admin.token));
    expect(data.employeeId).toBeNull();
    expect((data.days as unknown[]).length).toBe(7);
    expect(data.team).toEqual([]);
  });

  it('rejects a range longer than a month', async () => {
    // An unprivileged account could otherwise ask for a century and have a day
    // rendered for every teammate.
    expectFail(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '1900-01-01', dateTo: '2100-01-01' },
        employee.token,
      ),
    );
    // A month is still allowed.
    expectOk(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
        employee.token,
      ),
    );
  });

  it('shows no teammates when the employee has no department or branch', async () => {
    // These filters would otherwise become IS NULL and match everyone who is
    // also missing the field, which is common in this data.
    const other = await prisma.employeeProfile.create({
      data: { name: 'Also Unassigned', code: 'S010' },
    });
    await prisma.employeeProfile.update({
      where: { id: employee.employeeId! },
      data: { departmentId: null, locationId: null },
    });

    const data = expectOk(await rpc('/api/biotime/my-schedule', {}, employee.token));
    expect(data.teamVisible).toBe(false);
    expect(data.team).toEqual([]);
    expect(JSON.stringify(data)).not.toContain(other.id);
    expect(JSON.stringify(data)).not.toContain('Also Unassigned');
    // The employee still gets their own week.
    expect((data.days as unknown[]).length).toBe(7);
  });

  it('shows no teammates when the employee has a department but no branch', async () => {
    await prisma.employeeProfile.create({
      data: { name: 'Same Dept No Branch', code: 'S011', departmentId },
    });
    await prisma.employeeProfile.update({
      where: { id: employee.employeeId! },
      data: { locationId: null },
    });
    const data = expectOk(await rpc('/api/biotime/my-schedule', {}, employee.token));
    expect(data.teamVisible).toBe(false);
    expect(JSON.stringify(data)).not.toContain('Same Dept No Branch');
  });

  it('rejects half a range and an inverted one', async () => {
    expectFail(await rpc('/api/biotime/my-schedule', { dateFrom: '2026-06-07' }, employee.token));
    expectFail(
      await rpc(
        '/api/biotime/my-schedule',
        { dateFrom: '2026-06-13', dateTo: '2026-06-07' },
        employee.token,
      ),
    );
  });

  it('requires authentication', async () => {
    const res = await rpc('/api/biotime/my-schedule', {});
    expect(res.status === 401 || res.body.result?.success === false).toBe(true);
  });
});
