/**
 * The weekly schedule as an employee sees it in the app (جدولي).
 *
 * Employees could previously see their attendance, requests and payslip but not
 * what they are actually rostered for, so the weekly sheet only existed on paper
 * and in HR's Excel file.
 *
 * Two sources decide a day, in this order:
 *   1. a shift grid line, which is what HR filled in for that week
 *   2. the employee's standing ShiftAssignment pattern, when no grid fills the day
 * Resolving in that order matters: the grid is an override of the pattern, and
 * showing the pattern where HR entered something would tell people the wrong
 * shift. A grid row that HR has not filled yet is not such an entry.
 *
 * Only schedule data is exposed, and how much of a colleague's day is revealed
 * is HR's decision, not a constant. A shift is roster information; the reason
 * someone is absent is health or disciplinary information, so the two are
 * configured separately and absence reasons default to hidden.
 */
import type { Prisma, Shift, ShiftGridLine } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { formatGridCellLabel, lineHasAssignment } from './shiftGridData.service';
import { getEmployeeShiftForDate } from './shiftGridAssignment.service';
import { parseWeekStartDay } from './shiftGridExcelWeeks';

/**
 * Longest range the endpoint will build. The screen navigates a week at a time,
 * so this is generous; without it an unprivileged account could ask for a
 * century and have a day rendered for every teammate.
 */
export const MAX_SCHEDULE_DAYS = 31;

/** Who a colleague-facing schedule may include. */
export const TEAM_SCHEDULE_SCOPES = ['none', 'department', 'branch', 'all'] as const;
export type TeamScheduleScope = (typeof TEAM_SCHEDULE_SCOPES)[number];

export function parseTeamScheduleScope(value: unknown): TeamScheduleScope {
  const raw = String(value ?? '').trim();
  return (TEAM_SCHEDULE_SCOPES as readonly string[]).includes(raw)
    ? (raw as TeamScheduleScope)
    : 'department';
}

/** What an employee may see of somebody else's day. */
export type TeamVisibilityPolicy = {
  scope: TeamScheduleScope;
  showShiftTimes: boolean;
  showOffDays: boolean;
  showLeave: boolean;
  showSickLeave: boolean;
};

export const DEFAULT_TEAM_VISIBILITY: TeamVisibilityPolicy = {
  scope: 'department',
  showShiftTimes: true,
  showOffDays: true,
  showLeave: false,
  showSickLeave: false,
};

export function teamVisibilityFromConfig(
  config: {
    employeeTeamScheduleScope?: string | null;
    employeeTeamShowShiftTimes?: boolean | null;
    employeeTeamShowOffDays?: boolean | null;
    employeeTeamShowLeave?: boolean | null;
    employeeTeamShowSickLeave?: boolean | null;
  } | null,
): TeamVisibilityPolicy {
  if (!config) return DEFAULT_TEAM_VISIBILITY;
  return {
    scope: parseTeamScheduleScope(config.employeeTeamScheduleScope),
    showShiftTimes: config.employeeTeamShowShiftTimes !== false,
    showOffDays: config.employeeTeamShowOffDays !== false,
    showLeave: config.employeeTeamShowLeave === true,
    showSickLeave: config.employeeTeamShowSickLeave === true,
  };
}

export type ScheduleDay = {
  date: string;
  /** 0 = Sunday through 6 = Saturday. */
  weekday: number;
  label: string;
  shiftId: string | null;
  shiftName: string;
  startTime: string;
  endTime: string;
  isOff: boolean;
  isLeave: boolean;
  isSick: boolean;
  /** True when the day comes from the standing pattern, not a filled-in grid. */
  fromPattern: boolean;
};

export type ScheduleTeammate = {
  employeeId: string;
  name: string;
  departmentName: string;
  isSelf: boolean;
  days: ScheduleDay[];
};

export type MyScheduleResult = {
  dateFrom: string;
  dateTo: string;
  weekStartDay: number;
  employeeId: string | null;
  departmentName: string;
  days: ScheduleDay[];
  teamVisible: boolean;
  teamScope: TeamScheduleScope;
  /** Colleagues for the same week, grouped by department name. */
  team: { department: string; members: ScheduleTeammate[] }[];
};

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDay(date: Date): Date {
  return new Date(`${dayKey(date)}T00:00:00.000Z`);
}

/** The week containing `reference`, aligned to the configured start weekday. */
export function weekRangeFor(reference: Date, weekStartDay: number): { dateFrom: Date; dateTo: Date } {
  const start = parseWeekStartDay(weekStartDay);
  const day = utcDay(reference);
  const shift = (day.getUTCDay() - start + 7) % 7;
  const dateFrom = new Date(day.getTime() - shift * 86400000);
  return { dateFrom, dateTo: new Date(dateFrom.getTime() + 6 * 86400000) };
}

function datesBetween(dateFrom: Date, dateTo: Date): Date[] {
  const out: Date[] = [];
  for (let d = utcDay(dateFrom); d <= utcDay(dateTo); d = new Date(d.getTime() + 86400000)) {
    out.push(new Date(d));
  }
  return out;
}

function emptyDay(date: Date): ScheduleDay {
  return {
    date: dayKey(date),
    weekday: date.getUTCDay(),
    label: '',
    shiftId: null,
    shiftName: '',
    startTime: '',
    endTime: '',
    isOff: false,
    isLeave: false,
    isSick: false,
    fromPattern: false,
  };
}

function dayFromGridLine(date: Date, line: ShiftGridLine & { shift?: Shift | null }): ScheduleDay {
  return {
    date: dayKey(date),
    weekday: date.getUTCDay(),
    label: formatGridCellLabel(line),
    shiftId: line.shiftId,
    shiftName: line.shift?.name ?? '',
    startTime: line.shift?.startTime ?? '',
    endTime: line.shift?.endTime ?? '',
    isOff: line.isOff,
    isLeave: line.isAnnualLeave,
    isSick: line.isSick,
    fromPattern: false,
  };
}

function dayFromPattern(date: Date, shift: Shift | null, isOff: boolean): ScheduleDay {
  return {
    date: dayKey(date),
    weekday: date.getUTCDay(),
    label: isOff ? 'off' : shift ? `${shift.code ?? ''} - ${shift.name}`.trim() : '',
    shiftId: shift?.id ?? null,
    shiftName: shift?.name ?? '',
    startTime: shift?.startTime ?? '',
    endTime: shift?.endTime ?? '',
    isOff,
    isLeave: false,
    isSick: false,
    fromPattern: true,
  };
}

/**
 * Grid lines for a set of employees over a range, one per employee and day.
 *
 * A date can be covered by more than one grid now that weekly grids get merged
 * into a monthly one, so the newest grid wins. The merged grid is created after
 * its sources, which makes it the winner without needing a flag.
 *
 * Blank lines are dropped before that contest. Adding an employee to a grid,
 * generating one, or merging weeks all write a row per day up front, so a row
 * usually exists long before HR fills the week in. Such a row carries no
 * roster decision, and letting it win would state "no shift" over both the
 * standing pattern and a filled row in an older grid.
 */
async function resolveGridLines(
  employeeIds: string[],
  dateFrom: Date,
  dateTo: Date,
): Promise<Map<string, ShiftGridLine & { shift?: Shift | null }>> {
  if (employeeIds.length === 0) return new Map();
  const lines = await prisma.shiftGridLine.findMany({
    where: {
      employeeId: { in: employeeIds },
      date: { gte: utcDay(dateFrom), lte: utcDay(dateTo) },
    },
    include: { shift: true, grid: { select: { createdAt: true } } },
  });

  const byKey = new Map<string, ShiftGridLine & { shift?: Shift | null; grid: { createdAt: Date } }>();
  for (const line of lines) {
    if (!lineHasAssignment(line)) continue;
    const key = `${line.employeeId}:${dayKey(line.date)}`;
    const existing = byKey.get(key);
    if (!existing || line.grid.createdAt > existing.grid.createdAt) {
      byKey.set(key, line);
    }
  }
  return byKey;
}

async function buildDays(
  employeeId: string,
  dates: Date[],
  gridLines: Map<string, ShiftGridLine & { shift?: Shift | null }>,
  assignments: Awaited<ReturnType<typeof prisma.shiftAssignment.findMany>>,
  shiftsById: Map<string, Shift>,
): Promise<ScheduleDay[]> {
  return dates.map((date) => {
    const line = gridLines.get(`${employeeId}:${dayKey(date)}`);
    if (line) return dayFromGridLine(date, line);

    const own = assignments.filter((a) => a.employeeId === employeeId);
    if (own.length === 0) return emptyDay(date);
    const resolved = getEmployeeShiftForDate(own, date, shiftsById);
    if (!resolved.shift && !resolved.isOff) return emptyDay(date);
    return dayFromPattern(date, resolved.shift, resolved.isOff);
  });
}

/**
 * A teammate's day as colleagues may see it, under HR's policy.
 *
 * formatGridCellLabel spells out إجازة مرضية, اصابه عمل, استقاله and
 * انقطاع عن العمل. Those are health, employment and disciplinary details, so
 * each category is revealed only when HR has switched it on. Anything still
 * hidden collapses to the same marker as a rest day, which keeps it
 * indistinguishable rather than merely unlabelled.
 *
 * fromPattern is flattened as well. It tells an employee that their own day is a
 * projection rather than a posted roster, which is useful to them and meaningless
 * about someone else: left as-is it would separate a grid-entered hidden absence
 * from an ordinary pattern rest day, and that difference is the absence.
 */
export function redactTeammateDay(
  day: ScheduleDay,
  policy: TeamVisibilityPolicy = DEFAULT_TEAM_VISIBILITY,
): ScheduleDay {
  const working = Boolean(day.shiftId) && !day.isOff;
  if (working) {
    return {
      ...day,
      label: day.shiftName || day.label,
      startTime: policy.showShiftTimes ? day.startTime : '',
      endTime: policy.showShiftTimes ? day.endTime : '',
      isOff: false,
      isLeave: false,
      isSick: false,
      fromPattern: false,
    };
  }

  if (day.isSick && policy.showSickLeave) return { ...day, fromPattern: false };
  if (day.isLeave && policy.showLeave) return { ...day, fromPattern: false };

  // Not working, and the reason is not shared. An empty day and a hidden reason
  // must look the same, otherwise the absence itself becomes readable.
  return {
    date: day.date,
    weekday: day.weekday,
    label: policy.showOffDays ? 'off' : '',
    shiftId: null,
    shiftName: '',
    startTime: '',
    endTime: '',
    isOff: policy.showOffDays,
    isLeave: false,
    isSick: false,
    fromPattern: false,
  };
}

/**
 * The `where` for colleagues under a scope, or null when nobody is visible.
 *
 * The null-field guard has to vary by scope: a department scope needs both a
 * department and a branch, a branch scope needs only a branch. Without it Prisma
 * turns a missing field into IS NULL and quietly matches everyone else who is
 * also missing it, which is a common state here rather than a rare one.
 */
export function teammateScopeWhere(
  me: { id: string; departmentId: string | null; locationId: string | null },
  scope: TeamScheduleScope,
): Prisma.EmployeeProfileWhereInput | null {
  if (scope === 'none') return null;
  const base: Prisma.EmployeeProfileWhereInput = {
    id: { not: me.id },
    active: true,
    archivedAt: null,
  };

  if (scope === 'all') return base;

  if (scope === 'branch') {
    if (!me.locationId) return null;
    return { ...base, locationId: me.locationId };
  }

  if (!me.departmentId || !me.locationId) return null;
  return { ...base, departmentId: me.departmentId, locationId: me.locationId };
}

export async function getMySchedule(params: {
  userId: string;
  dateFrom?: Date;
  dateTo?: Date;
  /** When true, never expand to teammates (EMPLOYEE self-service). */
  forceSelfOnly?: boolean;
}): Promise<MyScheduleResult> {
  const config = await prisma.bioTimeConfig.findFirst();
  const visibility = params.forceSelfOnly
    ? { ...teamVisibilityFromConfig(config), scope: 'none' as const }
    : teamVisibilityFromConfig(config);
  const weekStartDay = parseWeekStartDay(config?.gridWeekStartDay);

  const range =
    params.dateFrom && params.dateTo
      ? { dateFrom: utcDay(params.dateFrom), dateTo: utcDay(params.dateTo) }
      : weekRangeFor(params.dateFrom ?? new Date(), weekStartDay);

  const spanDays =
    Math.round((range.dateTo.getTime() - range.dateFrom.getTime()) / 86400000) + 1;
  if (spanDays > MAX_SCHEDULE_DAYS) {
    throw new AppError(
      `أقصى مدة للجدول ${MAX_SCHEDULE_DAYS} يوم`,
      400,
      'VALIDATION',
    );
  }
  const dates = datesBetween(range.dateFrom, range.dateTo);

  const me = await prisma.employeeProfile.findFirst({
    where: { userId: params.userId },
    include: { department: { select: { name: true } } },
  });

  // A user with no employee profile is a valid state (admin accounts), so this
  // answers with an empty week rather than an error.
  if (!me) {
    return {
      dateFrom: dayKey(range.dateFrom),
      dateTo: dayKey(range.dateTo),
      weekStartDay,
      employeeId: null,
      departmentName: '',
      days: dates.map(emptyDay),
      teamVisible: false,
      teamScope: visibility.scope,
      team: [],
    };
  }

  const teamWhere = teammateScopeWhere(me, visibility.scope);
  const teamVisible = teamWhere !== null;
  const teammates = teamWhere
    ? await prisma.employeeProfile.findMany({
        where: teamWhere,
        include: { department: { select: { name: true } } },
        orderBy: [{ displayName: 'asc' }, { name: 'asc' }],
      })
    : [];

  const everyone = [me, ...teammates];
  const employeeIds = everyone.map((e) => e.id);
  const [gridLines, assignments, shifts] = await Promise.all([
    resolveGridLines(employeeIds, range.dateFrom, range.dateTo),
    prisma.shiftAssignment.findMany({ where: { employeeId: { in: employeeIds }, active: true } }),
    prisma.shift.findMany(),
  ]);
  const shiftsById = new Map(shifts.map((s) => [s.id, s]));

  const myDays = await buildDays(me.id, dates, gridLines, assignments, shiftsById);

  const members: ScheduleTeammate[] = [];
  for (const emp of everyone) {
    members.push({
      employeeId: emp.id,
      name: emp.displayName?.trim() || emp.name,
      departmentName: emp.department?.name ?? '',
      isSelf: emp.id === me.id,
      days:
        emp.id === me.id
          ? myDays
          : (await buildDays(emp.id, dates, gridLines, assignments, shiftsById)).map((day) =>
              redactTeammateDay(day, visibility),
            ),
    });
  }

  const byDepartment = new Map<string, ScheduleTeammate[]>();
  for (const member of members) {
    const key = member.departmentName || 'بدون قسم';
    const list = byDepartment.get(key) ?? [];
    list.push(member);
    byDepartment.set(key, list);
  }

  return {
    dateFrom: dayKey(range.dateFrom),
    dateTo: dayKey(range.dateTo),
    weekStartDay,
    employeeId: me.id,
    departmentName: me.department?.name ?? '',
    days: myDays,
    teamVisible,
    teamScope: visibility.scope,
    team: teamVisible
      ? [...byDepartment.entries()].map(([department, list]) => ({ department, members: list }))
      : [],
  };
}
