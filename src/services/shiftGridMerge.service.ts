/**
 * Merging weekly shift grids into one monthly grid (دمج الجداول).
 *
 * The branch fills the schedule in weekly, because the sheet goes out to
 * employees every week, but payroll is monthly. Rather than teaching payroll to
 * read several grids (Payroll.shiftGridId is a single FK, and every payroll
 * path, export and report follows it), the merge produces a real grid covering
 * the whole period. Payroll then works on it unchanged.
 *
 * Source weeks are marked with mergedIntoGridId so they cannot be merged again,
 * and a later week can be appended into the same monthly target.
 */
import { ShiftGridState, type Prisma, type ShiftGrid, type ShiftGridLine } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { utcDateOnly } from '../utils/payrollPeriod';
import {
  findPeriodMovers,
  loadOptionAMergeLines,
} from './shiftGridCrossLocationMerge.service';

/** What to do when two source grids schedule the same employee on the same day. */
export const MERGE_CONFLICT_STRATEGIES = ['latest_grid', 'earliest_grid', 'fail'] as const;
export type MergeConflictStrategy = (typeof MERGE_CONFLICT_STRATEGIES)[number];

export function parseMergeConflictStrategy(value: unknown): MergeConflictStrategy {
  const raw = String(value ?? '').trim();
  return (MERGE_CONFLICT_STRATEGIES as readonly string[]).includes(raw)
    ? (raw as MergeConflictStrategy)
    : 'latest_grid';
}

export type MergeShiftGridsOptions = {
  sourceGridIds: string[];
  /** Append into an existing monthly merge instead of creating a new one. */
  targetGridId?: string;
  name?: string;
  conflictStrategy?: MergeConflictStrategy;
  /** Leave the merged grid editable instead of confirming it straight away. */
  state?: Extract<ShiftGridState, 'grid' | 'confirmed'>;
  /**
   * Payroll period to clamp the merged grid to. Weeks rarely line up with a
   * period that closes mid-month, so without this the merged grid would span
   * the outer edges of the boundary weeks and payroll created from it would
   * inherit that wider range.
   */
  periodFrom?: Date;
  periodTo?: Date;
};

export type MergeConflict = {
  employeeId: string;
  date: string;
  keptGridId: string;
  discardedGridIds: string[];
};

export type MergeResult = {
  gridId: string;
  name: string;
  dateFrom: string;
  dateTo: string;
  sourceGridIds: string[];
  targetGridId?: string;
  appended: boolean;
  employeeCount: number;
  lineCount: number;
  /** Source days dropped for falling outside the requested period. */
  outOfPeriodLineCount: number;
  conflicts: MergeConflict[];
  /** Option A: days pulled from other branches’ weekly grids. */
  crossLocationLineCount?: number;
  crossLocationEmployeeCount?: number;
  excludedEmployeeCount?: number;
  crossLocationMode?: 'last_week';
};

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function inclusiveDayCount(dateFrom: Date, dateTo: Date): number {
  return Math.floor((utcDateOnly(dateTo).getTime() - utcDateOnly(dateFrom).getTime()) / 86400000) + 1;
}

function isMergeProduct(grid: { mergedFromGridIds: string[] }): boolean {
  return grid.mergedFromGridIds.length > 0;
}

/** Copies every scheduling flag, so a merged day behaves exactly like its source. */
function lineFlags(line: ShiftGridLine) {
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

/**
 * The merged grid's own period. An explicit payroll period wins, because weeks
 * straddle a month that closes mid-month; otherwise it spans the sources.
 */
function resolveMergeRange(
  grids: { dateFrom: Date; dateTo: Date }[],
  periodFrom?: Date,
  periodTo?: Date,
): { dateFrom: Date; dateTo: Date } {
  if (periodFrom && periodTo) {
    const from = utcDateOnly(periodFrom);
    const to = utcDateOnly(periodTo);
    if (from.getTime() > to.getTime()) {
      throw new AppError('تاريخ بداية الفترة بعد تاريخ النهاية', 400, 'VALIDATION');
    }
    return { dateFrom: from, dateTo: to };
  }
  if (periodFrom || periodTo) {
    throw new AppError('لازم تحدد بداية ونهاية الفترة مع بعض', 400, 'VALIDATION');
  }
  return {
    dateFrom: utcDateOnly(
      grids.reduce((min, g) => (g.dateFrom < min ? g.dateFrom : min), grids[0].dateFrom),
    ),
    dateTo: utcDateOnly(
      grids.reduce((max, g) => (g.dateTo > max ? g.dateTo : max), grids[0].dateTo),
    ),
  };
}

type ChosenBundle = {
  chosen: Map<string, ShiftGridLine>;
  conflicts: MergeConflict[];
  outOfPeriodLineCount: number;
  dateFrom: Date;
  dateTo: Date;
};

function resolveChosenLines(params: {
  grids: { id: string }[];
  lines: ShiftGridLine[];
  dateFrom: Date;
  dateTo: Date;
  strategy: MergeConflictStrategy;
}): ChosenBundle {
  const { grids, lines: allLines, dateFrom, dateTo, strategy } = params;
  const fromKey = dayKey(dateFrom);
  const toKey = dayKey(dateTo);
  const lines = allLines.filter((l) => {
    const key = dayKey(l.date);
    return key >= fromKey && key <= toKey;
  });
  const outOfPeriodLineCount = allLines.length - lines.length;
  if (lines.length === 0) {
    throw new AppError('لا توجد أيام في الفترة المحددة', 400, 'VALIDATION');
  }

  const gridOrder = new Map(grids.map((g, index) => [g.id, index]));
  const chosen = new Map<string, ShiftGridLine>();
  const conflictsByKey = new Map<string, Set<string>>();
  for (const line of lines) {
    const key = `${line.employeeId}:${dayKey(line.date)}`;
    const existing = chosen.get(key);
    if (!existing) {
      chosen.set(key, line);
      continue;
    }

    const seen = conflictsByKey.get(key) ?? new Set<string>([existing.gridId]);
    seen.add(line.gridId);
    conflictsByKey.set(key, seen);

    if (strategy === 'fail') continue;
    const keepNew =
      strategy === 'latest_grid'
        ? (gridOrder.get(line.gridId) ?? 0) >= (gridOrder.get(existing.gridId) ?? 0)
        : (gridOrder.get(line.gridId) ?? 0) < (gridOrder.get(existing.gridId) ?? 0);
    if (keepNew) chosen.set(key, line);
  }

  const conflicts: MergeConflict[] = [...conflictsByKey.entries()].map(([key, gridIds]) => {
    const [employeeId, date] = key.split(':');
    const kept = chosen.get(key)!;
    return {
      employeeId,
      date,
      keptGridId: kept.gridId,
      discardedGridIds: [...gridIds].filter((id) => id !== kept.gridId),
    };
  });

  if (strategy === 'fail' && conflicts.length > 0) {
    throw new AppError(
      `فيه ${conflicts.length} يوم متكرر لنفس الموظف في أكثر من جدول`,
      400,
      'VALIDATION',
    );
  }

  return { chosen, conflicts, outOfPeriodLineCount, dateFrom, dateTo };
}

async function loadSourceWeeks(sourceGridIds: string[]) {
  const grids = await prisma.shiftGrid.findMany({
    where: { id: { in: sourceGridIds } },
    orderBy: { dateFrom: 'asc' },
  });
  if (grids.length !== sourceGridIds.length) {
    throw new NotFoundError('واحد أو أكثر من الجداول المحددة غير موجود');
  }

  const locationIds = new Set(grids.map((g) => g.locationId ?? ''));
  if (locationIds.size > 1) {
    throw new AppError('كل الجداول لازم تكون لنفس الموقع', 400, 'VALIDATION');
  }

  const mergeProduct = grids.find((g) => isMergeProduct(g));
  if (mergeProduct) {
    throw new AppError(
      `الجدول "${mergeProduct.name}" ناتج عن دمج، فاختره كهدف لا كمصدر`,
      400,
      'VALIDATION',
    );
  }

  const alreadyUsed = grids.find((g) => g.mergedIntoGridId);
  if (alreadyUsed) {
    throw new AppError(
      `الجدول "${alreadyUsed.name}" أُضيف من قبل إلى جدول شهري`,
      400,
      'VALIDATION',
    );
  }

  return grids;
}

export async function mergeShiftGrids(options: MergeShiftGridsOptions): Promise<MergeResult> {
  const sourceGridIds = [...new Set(options.sourceGridIds.filter(Boolean))];
  const targetGridId = options.targetGridId?.trim() || undefined;
  const strategy = options.conflictStrategy ?? 'latest_grid';

  if (targetGridId) {
    if (sourceGridIds.length < 1) {
      throw new AppError('لازم تختار جدول أسبوعي على الأقل للإضافة', 400, 'VALIDATION');
    }
  } else if (sourceGridIds.length < 2) {
    throw new AppError('لازم تختار جدولين على الأقل للدمج', 400, 'VALIDATION');
  }

  const grids = await loadSourceWeeks(sourceGridIds);

  if (targetGridId) {
    return appendIntoExistingTarget({
      grids,
      sourceGridIds,
      targetGridId,
      strategy,
      periodFrom: options.periodFrom,
      periodTo: options.periodTo,
    });
  }

  const { dateFrom, dateTo } = resolveMergeRange(grids, options.periodFrom, options.periodTo);
  const useOptionA = Boolean(options.periodFrom && options.periodTo);
  const targetLocationId = grids[0].locationId ?? '';

  let allLines: ShiftGridLine[];
  let mergeGrids: { id: string; dateFrom?: Date }[];
  let crossLocationLineCount = 0;
  let crossLocationEmployeeCount = 0;
  let excludedEmployeeCount = 0;
  let optionOutOfPeriod = 0;

  if (useOptionA) {
    const option = await loadOptionAMergeLines({
      targetLocationId,
      sourceGridIds,
      dateFrom,
      dateTo,
    });
    allLines = option.lines;
    mergeGrids = option.grids;
    crossLocationLineCount = option.crossLocationLineCount;
    crossLocationEmployeeCount = option.importedEmployeeIds.length;
    excludedEmployeeCount = option.excludedEmployeeIds.length;
    optionOutOfPeriod = option.outOfPeriodLineCount;
  } else {
    allLines = await prisma.shiftGridLine.findMany({
      where: { gridId: { in: sourceGridIds } },
      orderBy: [{ employeeId: 'asc' }, { date: 'asc' }],
    });
    mergeGrids = grids;
  }

  if (allLines.length === 0) {
    throw new AppError('الجداول المحددة مفيهاش أيام للدمج', 400, 'VALIDATION');
  }

  const resolved = resolveChosenLines({
    grids: mergeGrids,
    lines: allLines,
    dateFrom,
    dateTo,
    strategy,
  });

  const employeeIds = [...new Set([...resolved.chosen.values()].map((l) => l.employeeId))];
  const mergedName =
    options.name?.trim() || `دمج ${dayKey(dateFrom)} إلى ${dayKey(dateTo)}`;

  const created = await prisma.$transaction(async (tx) => {
    const grid = await tx.shiftGrid.create({
      data: {
        name: mergedName,
        dateFrom,
        dateTo,
        state: options.state ?? ShiftGridState.grid,
        selectionMethod: 'manual',
        conflictAction: 'replace',
        employeeIds,
        departmentIds: [...new Set(grids.flatMap((g) => g.departmentIds))],
        locationId: grids[0].locationId,
        deviceId: grids[0].deviceId,
        gridLocation: grids[0].gridLocation,
        mergedFromGridIds: sourceGridIds,
        mergedAt: new Date(),
      },
    });

    const data: Prisma.ShiftGridLineCreateManyInput[] = [...resolved.chosen.values()].map((line) => ({
      gridId: grid.id,
      employeeId: line.employeeId,
      date: line.date,
      ...lineFlags(line),
    }));
    await tx.shiftGridLine.createMany({ data });

    await tx.shiftGrid.updateMany({
      where: { id: { in: sourceGridIds } },
      data: { mergedIntoGridId: grid.id },
    });

    return grid;
  });

  return {
    gridId: created.id,
    name: created.name,
    dateFrom: dayKey(created.dateFrom),
    dateTo: dayKey(created.dateTo),
    sourceGridIds,
    appended: false,
    employeeCount: employeeIds.length,
    lineCount: resolved.chosen.size,
    outOfPeriodLineCount: useOptionA ? optionOutOfPeriod : resolved.outOfPeriodLineCount,
    conflicts: resolved.conflicts,
    ...(useOptionA
      ? {
          crossLocationMode: 'last_week' as const,
          crossLocationLineCount,
          crossLocationEmployeeCount,
          excludedEmployeeCount,
        }
      : {}),
  };
}

async function appendIntoExistingTarget(params: {
  grids: ShiftGrid[];
  sourceGridIds: string[];
  targetGridId: string;
  strategy: MergeConflictStrategy;
  periodFrom?: Date;
  periodTo?: Date;
}): Promise<MergeResult> {
  const { grids, sourceGridIds, targetGridId, strategy } = params;
  const target = await prisma.shiftGrid.findUnique({ where: { id: targetGridId } });
  if (!target) throw new NotFoundError('الجدول الشهري المستهدف غير موجود');
  if (!isMergeProduct(target)) {
    throw new AppError('الهدف لازم يكون جدول ناتج عن دمج شهري', 400, 'VALIDATION');
  }
  if (sourceGridIds.includes(targetGridId)) {
    throw new AppError('مينفعش تضيف الجدول على نفسه', 400, 'VALIDATION');
  }
  if ((target.locationId ?? '') !== (grids[0].locationId ?? '')) {
    throw new AppError('كل الجداول لازم تكون لنفس الموقع', 400, 'VALIDATION');
  }

  const periodFrom = params.periodFrom ?? target.dateFrom;
  const periodTo = params.periodTo ?? target.dateTo;
  const { dateFrom, dateTo } = resolveMergeRange([target, ...grids], periodFrom, periodTo);
  const useOptionA = Boolean(params.periodFrom && params.periodTo);
  const targetLocationId = grids[0].locationId ?? '';

  let crossLocationLineCount = 0;
  let crossLocationEmployeeCount = 0;
  let excludedEmployeeCount = 0;
  let resolved: ChosenBundle;

  if (useOptionA) {
    const option = await loadOptionAMergeLines({
      targetLocationId,
      sourceGridIds: [...new Set([...target.mergedFromGridIds, ...sourceGridIds])],
      dateFrom,
      dateTo,
    });
    if (option.lines.length === 0) {
      throw new AppError('الجداول المحددة مفيهاش أيام للدمج', 400, 'VALIDATION');
    }
    crossLocationLineCount = option.crossLocationLineCount;
    crossLocationEmployeeCount = option.importedEmployeeIds.length;
    excludedEmployeeCount = option.excludedEmployeeIds.length;
    resolved = resolveChosenLines({
      grids: option.grids,
      lines: option.lines,
      dateFrom,
      dateTo,
      strategy,
    });
  } else {
    const [sourceLines, targetLines] = await Promise.all([
      prisma.shiftGridLine.findMany({
        where: { gridId: { in: sourceGridIds } },
        orderBy: [{ employeeId: 'asc' }, { date: 'asc' }],
      }),
      prisma.shiftGridLine.findMany({
        where: { gridId: targetGridId },
        orderBy: [{ employeeId: 'asc' }, { date: 'asc' }],
      }),
    ]);
    if (sourceLines.length === 0) {
      throw new AppError('الجداول المحددة مفيهاش أيام للدمج', 400, 'VALIDATION');
    }
    const ordered = [{ id: targetGridId }, ...grids.map((g) => ({ id: g.id }))];
    resolved = resolveChosenLines({
      grids: ordered,
      lines: [...targetLines, ...sourceLines],
      dateFrom,
      dateTo,
      strategy,
    });
  }

  const fromSources = useOptionA
    ? [...resolved.chosen.values()]
    : [...resolved.chosen.values()].filter((l) => sourceGridIds.includes(l.gridId));
  const employeeIds = [
    ...new Set([
      ...target.employeeIds,
      ...grids.flatMap((g) => g.employeeIds),
      ...employeeIdsFrom(resolved.chosen),
    ]),
  ];
  const departmentIds = [...new Set([...target.departmentIds, ...grids.flatMap((g) => g.departmentIds)])];
  const mergedFromGridIds = [...new Set([...target.mergedFromGridIds, ...sourceGridIds])];

  await prisma.$transaction(async (tx) => {
    if (useOptionA) {
      await tx.shiftGridLine.deleteMany({ where: { gridId: targetGridId } });
      if (fromSources.length > 0) {
        await tx.shiftGridLine.createMany({
          data: fromSources.map((line) => ({
            gridId: targetGridId,
            employeeId: line.employeeId,
            date: line.date,
            ...lineFlags(line),
          })),
        });
      }
    } else {
      // Replace contested days that the new week won, then insert new source days.
      for (const line of fromSources) {
        await tx.shiftGridLine.deleteMany({
          where: {
            gridId: targetGridId,
            employeeId: line.employeeId,
            date: line.date,
          },
        });
      }
      if (fromSources.length > 0) {
        await tx.shiftGridLine.createMany({
          data: fromSources.map((line) => ({
            gridId: targetGridId,
            employeeId: line.employeeId,
            date: line.date,
            ...lineFlags(line),
          })),
        });
      }
    }

    await tx.shiftGrid.update({
      where: { id: targetGridId },
      data: {
        dateFrom,
        dateTo,
        employeeIds,
        departmentIds,
        mergedFromGridIds,
        mergedAt: new Date(),
      },
    });

    await tx.shiftGrid.updateMany({
      where: { id: { in: sourceGridIds } },
      data: { mergedIntoGridId: targetGridId },
    });
  });

  const lineCount = await prisma.shiftGridLine.count({ where: { gridId: targetGridId } });
  const employeeCount = (
    await prisma.shiftGridLine.findMany({
      where: { gridId: targetGridId },
      distinct: ['employeeId'],
      select: { employeeId: true },
    })
  ).length;

  return {
    gridId: targetGridId,
    name: target.name,
    dateFrom: dayKey(dateFrom),
    dateTo: dayKey(dateTo),
    sourceGridIds,
    targetGridId,
    appended: true,
    employeeCount,
    lineCount,
    outOfPeriodLineCount: resolved.outOfPeriodLineCount,
    conflicts: resolved.conflicts,
    ...(useOptionA
      ? {
          crossLocationMode: 'last_week' as const,
          crossLocationLineCount,
          crossLocationEmployeeCount,
          excludedEmployeeCount,
        }
      : {}),
  };
}

function employeeIdsFrom(chosen: Map<string, ShiftGridLine>): string[] {
  return [...new Set([...chosen.values()].map((l) => l.employeeId))];
}

/**
 * Dry run of a merge: the same validation and conflict detection without
 * writing anything, so HR can see what a merge would do first.
 */
export async function previewShiftGridMerge(options: MergeShiftGridsOptions) {
  const sourceGridIds = [...new Set(options.sourceGridIds.filter(Boolean))];
  const targetGridId = options.targetGridId?.trim() || undefined;

  if (targetGridId) {
    if (sourceGridIds.length < 1) {
      throw new AppError('لازم تختار جدول أسبوعي على الأقل للإضافة', 400, 'VALIDATION');
    }
  } else if (sourceGridIds.length < 2) {
    throw new AppError('لازم تختار جدولين على الأقل للدمج', 400, 'VALIDATION');
  }

  const grids = await prisma.shiftGrid.findMany({
    where: { id: { in: sourceGridIds } },
    orderBy: { dateFrom: 'asc' },
    include: { _count: { select: { lines: true } }, mergedInto: { select: { id: true, name: true } } },
  });
  if (grids.length !== sourceGridIds.length) {
    throw new NotFoundError('واحد أو أكثر من الجداول المحددة غير موجود');
  }

  let target: ShiftGrid | null = null;
  if (targetGridId) {
    target = await prisma.shiftGrid.findUnique({ where: { id: targetGridId } });
    if (!target) throw new NotFoundError('الجدول الشهري المستهدف غير موجود');
    if (!isMergeProduct(target)) {
      throw new AppError('الهدف لازم يكون جدول ناتج عن دمج شهري', 400, 'VALIDATION');
    }
  }

  const rangeGrids = target ? [target, ...grids] : grids;
  const { dateFrom, dateTo } = resolveMergeRange(
    rangeGrids,
    options.periodFrom ?? target?.dateFrom,
    options.periodTo ?? target?.dateTo,
  );
  const fromKey = dayKey(dateFrom);
  const toKey = dayKey(dateTo);
  const useOptionA = Boolean(options.periodFrom && options.periodTo);
  const targetLocationId = (target?.locationId ?? grids[0]?.locationId) ?? '';

  let allLines: { employeeId: string; date: Date; gridId: string }[];
  let crossLocationLineCount = 0;
  let crossLocationEmployeeCount = 0;
  let excludedEmployeeCount = 0;
  let optionOutOfPeriod = 0;

  if (useOptionA && targetLocationId) {
    const option = await loadOptionAMergeLines({
      targetLocationId,
      sourceGridIds: targetGridId
        ? [...new Set([...target!.mergedFromGridIds, ...sourceGridIds])]
        : sourceGridIds,
      dateFrom,
      dateTo,
    });
    allLines = option.lines;
    crossLocationLineCount = option.crossLocationLineCount;
    crossLocationEmployeeCount = option.importedEmployeeIds.length;
    excludedEmployeeCount = option.excludedEmployeeIds.length;
    optionOutOfPeriod = option.outOfPeriodLineCount;
  } else {
    allLines = await prisma.shiftGridLine.findMany({
      where: { gridId: { in: targetGridId ? [...sourceGridIds, targetGridId] : sourceGridIds } },
      select: { employeeId: true, date: true, gridId: true },
    });
  }

  const lines = allLines.filter((l) => {
    const key = dayKey(l.date);
    return key >= fromKey && key <= toKey;
  });
  const seen = new Map<string, string[]>();
  const dateCoverage = new Map<string, Set<string>>();
  for (const line of lines) {
    const date = dayKey(line.date);
    const key = `${line.employeeId}:${date}`;
    const list = seen.get(key) ?? [];
    list.push(line.gridId);
    seen.set(key, list);

    const dateGridIds = dateCoverage.get(date) ?? new Set<string>();
    dateGridIds.add(line.gridId);
    dateCoverage.set(date, dateGridIds);
  }
  const overlapping = [...seen.entries()].filter(([, gridIds]) => gridIds.length > 1);
  const overlappingDates = [...dateCoverage.entries()].filter(([, gridIds]) => gridIds.size > 1);

  const covered = new Set(lines.map((l) => dayKey(l.date)));
  const missingDates: string[] = [];
  for (let d = new Date(dateFrom); d <= dateTo; d = new Date(d.getTime() + 86400000)) {
    const key = dayKey(d);
    if (!covered.has(key)) missingDates.push(key);
  }

  return {
    sourceGrids: grids.map((g) => ({
      id: g.id,
      name: g.name,
      dateFrom: dayKey(g.dateFrom),
      dateTo: dayKey(g.dateTo),
      state: g.state,
      lineCount: g._count.lines,
      dayCount: inclusiveDayCount(g.dateFrom, g.dateTo),
      isMerged: isMergeProduct(g),
      mergedIntoGridId: g.mergedIntoGridId,
      mergedIntoName: g.mergedInto?.name ?? null,
    })),
    targetGrid: target
      ? {
          id: target.id,
          name: target.name,
          dateFrom: dayKey(target.dateFrom),
          dateTo: dayKey(target.dateTo),
          mergedFromGridIds: target.mergedFromGridIds,
        }
      : null,
    dateFrom: dayKey(dateFrom),
    dateTo: dayKey(dateTo),
    employeeCount: new Set(lines.map((l) => l.employeeId)).size,
    lineCount: lines.length,
    coveredDayCount: covered.size,
    overlappingDayCount: overlappingDates.length,
    overlappingEmployeeDayCount: overlapping.length,
    missingDates,
    outOfPeriodLineCount: useOptionA ? optionOutOfPeriod : allLines.length - lines.length,
    sameLocation:
      new Set([
        ...(target ? [target.locationId ?? ''] : []),
        ...grids.map((g) => g.locationId ?? ''),
      ]).size === 1,
    ...(useOptionA
      ? {
          crossLocationMode: 'last_week' as const,
          crossLocationLineCount,
          crossLocationEmployeeCount,
          excludedEmployeeCount,
        }
      : {}),
  };
}

/**
 * The payroll month for a given day, honouring a start day other than the 1st.
 * A start day of 26 makes 26 Jan to 25 Feb one period.
 */
export function payrollMonthRange(
  reference: Date,
  monthStartDay: number,
): { dateFrom: Date; dateTo: Date } {
  const requestedDay = Math.min(31, Math.max(1, Math.round(monthStartDay) || 1));
  const ref = utcDateOnly(reference);

  // Clamped per month rather than globally: a branch closing on the 31st wants
  // the 31st in the months that have one, and the last day in the months that
  // do not. Clamping to 28 everywhere would shift the period by up to 3 days.
  const startOfMonth = (year: number, month: number): Date => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(requestedDay, lastDay)));
  };

  const thisMonthStart = startOfMonth(ref.getUTCFullYear(), ref.getUTCMonth());
  const start =
    ref.getTime() >= thisMonthStart.getTime()
      ? thisMonthStart
      : startOfMonth(ref.getUTCFullYear(), ref.getUTCMonth() - 1);
  const nextStart = startOfMonth(start.getUTCFullYear(), start.getUTCMonth() + 1);
  const end = new Date(nextStart.getTime() - 86400000);
  return { dateFrom: start, dateTo: end };
}

/** Grids that fall inside a payroll month, as merge candidates and targets. */
export async function findMergeCandidates(params: {
  reference?: Date;
  monthStartDay?: number;
  locationId?: string | null;
}) {
  const config = await prisma.bioTimeConfig.findFirst();
  const monthStartDay = params.monthStartDay ?? config?.payrollMonthStartDay ?? 26;
  const { dateFrom, dateTo } = payrollMonthRange(params.reference ?? new Date(), monthStartDay);
  const locationFilter = params.locationId ? { locationId: params.locationId } : {};

  const movers = await findPeriodMovers({ dateFrom, dateTo, locationId: params.locationId });

  // Overlap, not containment: a period closing mid-month is straddled by its
  // boundary weeks, and leaving those out would drop the days at each end.
  const all = await prisma.shiftGrid.findMany({
    where: {
      dateFrom: { lte: dateTo },
      dateTo: { gte: dateFrom },
      ...locationFilter,
    },
    orderBy: { dateFrom: 'asc' },
    include: {
      _count: { select: { lines: true } },
      mergedInto: { select: { id: true, name: true } },
      location: { select: { id: true, name: true, actualName: true } },
    },
  });

  const locationLabel = (g: (typeof all)[number]) =>
    g.location?.actualName?.trim() || g.location?.name?.trim() || 'فرع غير محدد';

  const available = all.filter((g) => !isMergeProduct(g) && !g.mergedIntoGridId);
  const consumed = all.filter((g) => !isMergeProduct(g) && Boolean(g.mergedIntoGridId));
  const targets = all.filter((g) => isMergeProduct(g));

  const mapWeek = (g: (typeof all)[number]) => ({
    id: g.id,
    name: g.name,
    dateFrom: dayKey(g.dateFrom),
    dateTo: dayKey(g.dateTo),
    state: g.state,
    locationId: g.locationId,
    locationName: locationLabel(g),
    lineCount: g._count.lines,
    dayCount: inclusiveDayCount(g.dateFrom, g.dateTo),
    mergedIntoGridId: g.mergedIntoGridId,
    mergedIntoName: g.mergedInto?.name ?? null,
  });

  const byLocation = new Map<string, { locationId: string; locationName: string; grids: ReturnType<typeof mapWeek>[] }>();
  for (const g of available) {
    const mapped = mapWeek(g);
    const key = g.locationId ?? '';
    const bucket = byLocation.get(key) ?? {
      locationId: key,
      locationName: locationLabel(g),
      grids: [],
    };
    bucket.grids.push(mapped);
    byLocation.set(key, bucket);
  }
  const locationGroups = [...byLocation.values()].sort((a, b) =>
    a.locationName.localeCompare(b.locationName, 'ar'),
  );

  return {
    dateFrom: dayKey(dateFrom),
    dateTo: dayKey(dateTo),
    monthStartDay,
    grids: available.map(mapWeek),
    locationGroups,
    consumed: consumed.map(mapWeek),
    movers,
    targets: targets.map((g) => ({
      id: g.id,
      name: g.name,
      dateFrom: dayKey(g.dateFrom),
      dateTo: dayKey(g.dateTo),
      state: g.state,
      locationId: g.locationId,
      locationName: locationLabel(g),
      lineCount: g._count.lines,
      dayCount: inclusiveDayCount(g.dateFrom, g.dateTo),
      mergedFromGridIds: g.mergedFromGridIds,
      mergedAt: g.mergedAt?.toISOString() ?? null,
    })),
  };
}
