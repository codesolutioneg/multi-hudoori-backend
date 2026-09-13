import type { EmployeeProfile, Shift, ShiftGridLine } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { applyEmployeeLocation } from './location.service';
import { sortShiftsForDisplay } from './shiftCalculations.service';

const DAY_NAMES_AR = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type CellFlags = {
  shiftId: string | null;
  isOff: boolean;
  isSick: boolean;
  isAnnualLeave: boolean;
  isExcluded: boolean;
  isBusDelay: boolean;
  isPresent: boolean;
  isFinished: boolean;
  isResignation: boolean;
  isWorkAbsence: boolean;
  isWorkInjury: boolean;
  isMarriageLeave: boolean;
};

import {
  compareForGrouping,
  DEFAULT_GRID_GROUPING,
  groupKeyFor,
  type GridGrouping,
} from './shiftGridGrouping.service';

export function formatGridCellLabel(
  line: Pick<
    ShiftGridLine,
    | 'isOff'
    | 'isSick'
    | 'isAnnualLeave'
    | 'isExcluded'
    | 'isBusDelay'
    | 'isPresent'
    | 'isFinished'
    | 'isResignation'
    | 'isWorkAbsence'
    | 'isWorkInjury'
    | 'isMarriageLeave'
    | 'shiftId'
  > & { shift?: Shift | null },
): string {
  if (line.isExcluded) return 'عدم احتساب يوم';
  if (line.isSick) return 'إجازة مرضية';
  if (line.isAnnualLeave) return 'إجازة سنوية';
  if (line.isOff) return 'off';
  if (line.isFinished) return 'انهاء';
  if (line.isResignation) return 'استقاله';
  if (line.isWorkAbsence) return 'انقطاع عن العمل';
  if (line.isWorkInjury) return 'اصابه عمل';
  if (line.isMarriageLeave) return 'إجازة جواز';
  if (line.isPresent && !line.shiftId) return 'حاضر';
  if (line.shift) {
    const label = `${line.shift.code ?? ''} - ${line.shift.name ?? ''}`.trim();
    if (line.isPresent) return `حاضر ${label}`;
    if (line.isBusDelay) return `تأخير باص ${label}`;
    return label;
  }
  if (line.isBusDelay) return 'تأخير باص';
  return '';
}

export function parseCellFlags(params: Record<string, unknown>, currentShiftId?: string | null): CellFlags {
  const value = params.cellValue;
  if (value != null && value !== '') {
    const v = String(value);
    let shiftId: string | null = null;
    let isOff = false;
    let isSick = false;
    let isAnnualLeave = false;
    let isExcluded = false;
    let isBusDelay = false;
    let isPresent = false;
    let isFinished = false;
    let isResignation = false;
    let isWorkAbsence = false;
    let isWorkInjury = false;
    let isMarriageLeave = false;

    // Explicit clear from the grid cell editor.
    if (v === 'clear' || v === 'none' || v === 'empty') {
      return {
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
      };
    }

    if (v === 'off') isOff = true;
    else if (v === 'present') {
      isPresent = true;
      shiftId = currentShiftId ?? null;
    } else if (v === 'sick') isSick = true;
    else if (v === 'annual') isAnnualLeave = true;
    else if (v === 'excluded') isExcluded = true;
    else if (v === 'bus_delay') {
      isBusDelay = true;
      shiftId = currentShiftId ?? null;
    } else if (v === 'finished') {
      isFinished = true;
    } else if (v === 'resignation') {
      isResignation = true;
    } else if (v === 'work_absence') {
      isWorkAbsence = true;
    } else if (v === 'work_injury') {
      isWorkInjury = true;
    } else if (v === 'marriage' || v === 'marriage_leave') {
      isMarriageLeave = true;
      isPresent = true;
    } else if (v.startsWith('bus_')) {
      isBusDelay = true;
      shiftId = v.slice(4) || null;
    } else {
      shiftId = v;
    }

    return {
      shiftId,
      isOff,
      isSick,
      isAnnualLeave,
      isExcluded,
      isBusDelay,
      isPresent,
      isFinished,
      isResignation,
      isWorkAbsence,
      isWorkInjury,
      isMarriageLeave,
    };
  }

  // Empty cellValue (or omitted flags) clears the assignment.
  return {
    shiftId: params.shiftId != null && params.shiftId !== '' ? String(params.shiftId) : null,
    isOff: Boolean(params.isOff),
    isSick: Boolean(params.isSick),
    isAnnualLeave: Boolean(params.isAnnualLeave),
    isExcluded: Boolean(params.isExcluded),
    isBusDelay: Boolean(params.isBusDelay),
    isPresent: Boolean(params.isPresent) || Boolean(params.isMarriageLeave),
    isFinished: Boolean(params.isFinished),
    isResignation: Boolean(params.isResignation),
    isWorkAbsence: Boolean(params.isWorkAbsence),
    isWorkInjury: Boolean(params.isWorkInjury),
    isMarriageLeave: Boolean(params.isMarriageLeave),
  };
}

export function flagsToLineData(flags: CellFlags) {
  return {
    shiftId: flags.shiftId,
    isOff: flags.isOff,
    isSick: flags.isSick,
    isAnnualLeave: flags.isAnnualLeave,
    isExcluded: flags.isExcluded,
    isBusDelay: flags.isBusDelay,
    isPresent: flags.isPresent,
    isFinished: flags.isFinished,
    isResignation: flags.isResignation,
    isWorkAbsence: flags.isWorkAbsence,
    isWorkInjury: flags.isWorkInjury,
    isMarriageLeave: flags.isMarriageLeave,
  };
}

function employeeDisplayCode(
  emp: EmployeeProfile & { mapping?: { biotimeEmpCode: string | null } | null },
): string {
  return emp.mapping?.biotimeEmpCode?.trim() || emp.code?.trim() || '';
}

function employeeDisplayJob(emp: EmployeeProfile): string {
  return emp.jobTitle?.trim() || '';
}

function buildGridDates(dateFrom: Date, dateTo: Date) {
  const dates: Record<string, unknown>[] = [];
  let d = new Date(dateFrom);
  while (d <= dateTo) {
    const weekday = d.getDay();
    const odooWeekday = weekday === 0 ? 6 : weekday - 1;
    dates.push({
      date: d.toISOString().slice(0, 10),
      day_name: DAY_NAMES_AR[odooWeekday] ?? '',
      day_num: d.getDate(),
      month_name: MONTH_NAMES[d.getMonth()] ?? '',
      weekday: odooWeekday,
      is_friday: odooWeekday === 4,
    });
    d = new Date(d.getTime() + 86400000);
  }
  return dates;
}

async function getShiftOptions() {
  const shifts = sortShiftsForDisplay(
    await prisma.shift.findMany({ where: { active: true } }),
  );
  return shifts.map((s) => ({
    id: s.id,
    name: s.name,
    code: s.code ?? '',
    startTime: s.startTime,
  }));
}

type GridEmployee = EmployeeProfile & {
  mapping?: { biotimeEmpCode: string | null } | null;
  department?: { name: string | null } | null;
};

function sortEmployees(
  employees: GridEmployee[],
  grouping: GridGrouping = DEFAULT_GRID_GROUPING,
) {
  return employees.sort((a, b) => compareForGrouping(a, b, grouping));
}

function buildEmployeeRow(
  emp: GridEmployee,
  empLines: (ShiftGridLine & { shift?: Shift | null })[],
) {
  const cells: Record<string, Record<string, unknown>> = {};
  for (const line of empLines) {
    const dateKey = line.date.toISOString().slice(0, 10);
    cells[dateKey] = gridCellFromLine(line);
  }

  return {
    employee_id: emp.id,
    name: emp.name,
    code: employeeDisplayCode(emp),
    job_title: employeeDisplayJob(emp),
    department_id: emp.departmentId ?? '',
    department_name: emp.department?.name?.trim() ?? '',
    can_remove: employeeCanRemoveFromGrid(empLines),
    cells,
  };
}

export function gridCellFromLine(line: ShiftGridLine & { shift?: Shift | null }) {
  return {
    line_id: line.id,
    shift_id: line.shiftId ?? false,
    shift_code: line.shift?.code ?? '',
    is_off: line.isOff,
    is_sick: line.isSick,
    is_annual_leave: line.isAnnualLeave,
    is_excluded: line.isExcluded,
    is_bus_delay: line.isBusDelay,
    is_present: line.isPresent,
    is_finished: line.isFinished,
    is_resignation: line.isResignation,
    is_work_absence: line.isWorkAbsence,
    is_work_injury: line.isWorkInjury,
    is_marriage_leave: line.isMarriageLeave,
    display_label: formatGridCellLabel(line),
  };
}

export function lineHasAssignment(line: ShiftGridLine): boolean {
  return Boolean(
    line.shiftId
      || line.isOff
      || line.isSick
      || line.isAnnualLeave
      || line.isExcluded
      || line.isBusDelay
      || line.isPresent
      || line.isFinished
      || line.isResignation
      || line.isWorkAbsence
      || line.isWorkInjury
      || line.isMarriageLeave,
  );
}

export function employeeCanRemoveFromGrid(lines: ShiftGridLine[]): boolean {
  return lines.length > 0 && lines.every((line) => !lineHasAssignment(line));
}

/**
 * Section map for the client. The key stays `job_groups` in the response
 * whatever the grouping is, so the grid renders sections without caring which
 * field produced them.
 */
function employeesToGroups(
  employees: Record<string, unknown>[],
  grouping: GridGrouping = DEFAULT_GRID_GROUPING,
) {
  const groups: Record<string, Record<string, unknown>[]> = {};
  for (const row of employees) {
    const key = groupKeyFor(
      {
        jobTitle: (row.job_title as string) ?? null,
        department: { name: (row.department_name as string) ?? null },
      },
      grouping,
    );
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  return groups;
}

export async function getShiftGridMeta(
  gridId: string,
  grouping: GridGrouping = DEFAULT_GRID_GROUPING,
) {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) throw new Error('Grid not found');

  const summary = await countGridSummary(gridId);
  const dates = buildGridDates(grid.dateFrom, grid.dateTo);
  const shifts = await getShiftOptions();

  return {
    dates,
    shifts,
    grouping,
    job_groups: {},
    date_from: grid.dateFrom.toISOString().slice(0, 10),
    date_to: grid.dateTo.toISOString().slice(0, 10),
    employee_count: summary.employeeCount,
    days_count: dates.length,
  };
}

export async function getShiftGridDataPaged(
  gridId: string,
  limit: number,
  offset: number,
  grouping: GridGrouping = DEFAULT_GRID_GROUPING,
) {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) throw new Error('Grid not found');

  const dates = buildGridDates(grid.dateFrom, grid.dateTo);
  const shifts = await getShiftOptions();

  const lineEmployees = await prisma.shiftGridLine.groupBy({
    by: ['employeeId'],
    where: { gridId },
  });
  const allEmployeeIds = lineEmployees.map((e) => e.employeeId);
  const total = allEmployeeIds.length;

  if (total === 0) {
    return {
      dates,
      shifts,
      job_groups: {},
      date_from: grid.dateFrom.toISOString().slice(0, 10),
      date_to: grid.dateTo.toISOString().slice(0, 10),
      employee_count: 0,
      days_count: dates.length,
      pagination: { total: 0, limit, offset, count: 0, hasMore: false },
    };
  }

  const employees = await prisma.employeeProfile.findMany({
    where: { id: { in: allEmployeeIds } },
    include: { mapping: true, department: { select: { name: true } } },
  });
  // Keep archived employees visible on grids they already belong to
  // (auto-archive on «انهاء» must not hide the row mid-week).
  const sorted = sortEmployees(employees, grouping);
  const totalActive = sorted.length;
  const pageEmployees = sorted.slice(offset, offset + limit);
  const pageIds = pageEmployees.map((e) => e.id);

  const lines = await prisma.shiftGridLine.findMany({
    where: { gridId, employeeId: { in: pageIds } },
    include: { shift: true },
    orderBy: [{ employeeId: 'asc' }, { date: 'asc' }],
  });

  const linesByEmployee = new Map<string, (ShiftGridLine & { shift?: Shift | null })[]>();
  for (const line of lines) {
    const arr = linesByEmployee.get(line.employeeId) ?? [];
    arr.push(line);
    linesByEmployee.set(line.employeeId, arr);
  }

  const employeeRows = pageEmployees.map((emp) =>
    buildEmployeeRow(emp, linesByEmployee.get(emp.id) ?? []),
  );

  const returned = employeeRows.length;
  return {
    dates,
    shifts,
    grouping,
    job_groups: employeesToGroups(employeeRows, grouping),
    date_from: grid.dateFrom.toISOString().slice(0, 10),
    date_to: grid.dateTo.toISOString().slice(0, 10),
    employee_count: totalActive,
    days_count: dates.length,
    pagination: {
      total: totalActive,
      limit,
      offset,
      count: returned,
      hasMore: offset + returned < totalActive,
    },
  };
}

export async function getShiftGridData(
  gridId: string,
  grouping: GridGrouping = DEFAULT_GRID_GROUPING,
) {
  const grid = await prisma.shiftGrid.findUnique({
    where: { id: gridId },
    include: {
      lines: {
        include: { shift: true, employee: { include: { mapping: true } } },
        orderBy: [{ employeeId: 'asc' }, { date: 'asc' }],
      },
    },
  });
  if (!grid) throw new Error('Grid not found');

  const dates = buildGridDates(grid.dateFrom, grid.dateTo);
  const shifts = await getShiftOptions();

  const employeeIds = [...new Set(grid.lines.map((l) => l.employeeId))];
  const employees = await prisma.employeeProfile.findMany({
    where: { id: { in: employeeIds } },
    include: { mapping: true, department: { select: { name: true } } },
  });

  const sortedEmployees = sortEmployees(employees, grouping);
  const employeeRows = sortedEmployees.map((emp) => {
    const empLines = grid.lines.filter((l) => l.employeeId === emp.id);
    return buildEmployeeRow(emp, empLines);
  });

  return {
    dates,
    shifts,
    grouping,
    job_groups: employeesToGroups(employeeRows, grouping),
    date_from: grid.dateFrom.toISOString().slice(0, 10),
    date_to: grid.dateTo.toISOString().slice(0, 10),
    employee_count: employeeIds.length,
    days_count: dates.length,
  };
}

export async function countGridSummary(gridId: string) {
  const grid = await prisma.shiftGrid.findUnique({
    where: { id: gridId },
    include: { _count: { select: { lines: true } } },
  });
  if (!grid) return { lineCount: 0, employeeCount: 0, daysCount: 0, hasAssignedShift: false };

  const [employees, assignedShiftCells] = await Promise.all([
    prisma.shiftGridLine.groupBy({
      by: ['employeeId'],
      where: { gridId },
    }),
    prisma.shiftGridLine.count({
      where: { gridId, shiftId: { not: null } },
    }),
  ]);

  const dayMs = 86400000;
  let days = 0;
  let d = new Date(grid.dateFrom);
  while (d <= grid.dateTo) {
    days++;
    d = new Date(d.getTime() + dayMs);
  }

  return {
    lineCount: grid._count.lines,
    employeeCount: employees.length,
    daysCount: days,
    hasAssignedShift: assignedShiftCells > 0,
  };
}

export async function getLatestSyncStatus(gridId: string) {
  let job = await prisma.syncJob.findFirst({
    where: { gridId },
    orderBy: { createdAt: 'desc' },
  });
  if (!job) {
    return {
      syncState: 'idle',
      syncProgress: 0,
      syncMessage: '',
      syncSyncedCount: 0,
      syncTotalCount: 0,
      syncErrorsCount: 0,
    };
  }

  // Stale running jobs (e.g. server restart mid-sync) block the UI forever at 0%.
  if (job.status === 'running') {
    const started = job.startedAt?.getTime() ?? job.createdAt.getTime();
    const age = Date.now() - started;
    // Clear orphaned jobs (server restart / old blocking sync) so UI does not stay at 0% forever.
    if (age > 30 * 60 * 1000 || (age > 90_000 && (job.progress ?? 0) === 0)) {
      job = await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'cancelled',
          message: 'انتهت مهلة المزامنة',
          finishedAt: new Date(),
        },
      });
    }
  }

  const parsed = parseSyncJobMessage(job.message);
  const syncState =
    job.status === 'running'
      ? 'syncing'
      : job.status === 'done'
        ? 'done'
        : job.status === 'failed'
          ? 'error'
          : 'idle';

  return {
    syncState,
    syncProgress: job.progress ?? 0,
    syncMessage: parsed.displayMessage || job.message || '',
    syncSyncedCount: parsed.syncedCount,
    syncTotalCount: parsed.totalCount,
    syncErrorsCount: job.status === 'failed' ? 1 : 0,
    jobId: job.id,
  };
}

function parseSyncJobMessage(message: string | null | undefined): {
  syncedCount: number;
  totalCount: number;
  displayMessage: string;
} {
  const msg = message ?? '';
  if (!msg) return { syncedCount: 0, totalCount: 0, displayMessage: '' };

  const syncedDone = msg.match(/^Synced (\d+)/i);
  if (syncedDone) {
    const n = parseInt(syncedDone[1]!, 10);
    return { syncedCount: n, totalCount: n, displayMessage: `تمت مزامنة ${n} بصمة` };
  }

  const meta = msg.match(/page=(\d+);pages=(\d+);total=(\d+);new=(\d+)/);
  if (meta) {
    const page = meta[1];
    const pages = meta[2];
    const total = parseInt(meta[3]!, 10);
    const synced = parseInt(meta[4]!, 10);
    return {
      syncedCount: synced,
      totalCount: total,
      displayMessage: `جاري جلب البصمات — صفحة $page من $pages (${synced} جديد)`,
    };
  }

  const legacy = msg.match(/\((\d+) new\)/);
  if (legacy) {
    const synced = parseInt(legacy[1]!, 10);
    const pageInfo = msg.match(/page (\d+)\/(\d+)/);
    const total = pageInfo ? parseInt(pageInfo[2]!, 10) * 100 : synced;
    return {
      syncedCount: synced,
      totalCount: total,
      displayMessage: msg,
    };
  }

  return { syncedCount: 0, totalCount: 0, displayMessage: msg };
}

function lineToCellFlags(line: ShiftGridLine): CellFlags {
  return {
    shiftId: line.shiftId,
    isOff: line.isOff,
    isSick: line.isSick,
    isAnnualLeave: line.isAnnualLeave,
    isExcluded: line.isExcluded,
    isBusDelay: line.isBusDelay,
    isPresent: line.isPresent,
    isFinished: line.isFinished,
    isResignation: line.isResignation,
    isWorkAbsence: line.isWorkAbsence,
    isWorkInjury: line.isWorkInjury,
    isMarriageLeave: line.isMarriageLeave,
  };
}

/** Move employee from one shift grid to another (updates location if needed). */
export async function transferEmployeeBetweenGrids(
  fromGridId: string,
  toGridId: string,
  employeeId: string,
) {
  if (fromGridId === toGridId) {
    throw new AppError('لا يمكن النقل لنفس الجدول', 400, 'VALIDATION');
  }

  const [fromGrid, toGrid] = await Promise.all([
    prisma.shiftGrid.findUnique({ where: { id: fromGridId } }),
    prisma.shiftGrid.findUnique({ where: { id: toGridId } }),
  ]);
  if (!fromGrid || !toGrid) throw new AppError('الجدول غير موجود', 404, 'NOT_FOUND');
  if (fromGrid.state === 'confirmed') {
    throw new AppError('الجدول الحالي مؤكد — افتحه للتعديل أولاً', 400, 'VALIDATION');
  }
  if (toGrid.state === 'confirmed') {
    throw new AppError('الجدول المستهدف مؤكد — افتحه للتعديل أولاً', 400, 'VALIDATION');
  }

  const sourceLines = await prisma.shiftGridLine.findMany({
    where: { gridId: fromGridId, employeeId },
  });
  if (!sourceLines.length) {
    throw new AppError('الموظف غير موجود في الجدول الحالي', 400, 'VALIDATION');
  }

  if (toGrid.locationId && toGrid.locationId !== fromGrid.locationId) {
    const loc = await applyEmployeeLocation(toGrid.locationId);
    await prisma.employeeProfile.update({
      where: { id: employeeId },
      data: { locationId: loc.locationId, location: loc.location },
    });
  }

  const sourceByDate = new Map(
    sourceLines.map((l) => [l.date.toISOString().slice(0, 10), l]),
  );

  let d = new Date(toGrid.dateFrom);
  const end = new Date(toGrid.dateTo);
  while (d <= end) {
    const day = new Date(d);
    const key = day.toISOString().slice(0, 10);
    const src = sourceByDate.get(key);
    const cellData = src ? flagsToLineData(lineToCellFlags(src)) : {};
    await prisma.shiftGridLine.upsert({
      where: { gridId_employeeId_date: { gridId: toGridId, employeeId, date: day } },
      create: { gridId: toGridId, employeeId, date: day, ...cellData },
      update: cellData,
    });
    d = new Date(d.getTime() + 86400000);
  }

  await prisma.shiftGridLine.deleteMany({ where: { gridId: fromGridId, employeeId } });

  return {
    fromGridId,
    toGridId,
    employeeId,
    locationChanged: Boolean(toGrid.locationId && toGrid.locationId !== fromGrid.locationId),
  };
}
