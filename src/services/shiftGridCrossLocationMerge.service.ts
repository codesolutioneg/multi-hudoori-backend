/**
 * Option A — «the employee card’s branch owns the month».
 *
 * At merge time, each employee’s home branch is `employeeProfile.locationId`
 * (archived employees keep their card location). When merging branch B’s
 * weeks, **all** of that employee’s days in period P are collected into B’s
 * monthly grid — including days from other branches’ weeks. Employees whose
 * card location is not B are excluded from B’s merge.
 */
import type { ShiftGrid, ShiftGridLine } from '@prisma/client';
import { prisma } from '../prisma/client';

export type PeriodMover = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  homeLocationId: string;
  homeLocationName: string;
  locationIds: string[];
  locationNames: string[];
};

export type EmployeeHomeBranch = {
  employeeId: string;
  homeLocationId: string;
  homeGridId: string;
  homeGridDateFrom: Date;
};

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWeeklyGrid(grid: Pick<ShiftGrid, 'mergedFromGridIds'>): boolean {
  return grid.mergedFromGridIds.length === 0;
}

/** Pure helper — card location at merge time wins, archived included. */
export function resolveEmployeeHomeBranchesFromCards(
  employees: { id: string; locationId: string | null }[],
): Map<string, EmployeeHomeBranch> {
  const home = new Map<string, EmployeeHomeBranch>();
  for (const employee of employees) {
    const locationId = String(employee.locationId ?? '').trim();
    if (!locationId) continue;
    home.set(employee.id, {
      employeeId: employee.id,
      homeLocationId: locationId,
      homeGridId: '',
      homeGridDateFrom: new Date(0),
    });
  }
  return home;
}

export function filterLinesForHomeLocation(params: {
  lines: ShiftGridLine[];
  homeByEmployee: Map<string, EmployeeHomeBranch>;
  targetLocationId: string;
  dateFrom: Date;
  dateTo: Date;
  sourceGridIds?: Set<string>;
}): {
  lines: ShiftGridLine[];
  excludedEmployeeIds: string[];
  importedEmployeeIds: string[];
} {
  const fromKey = dayKey(params.dateFrom);
  const toKey = dayKey(params.dateTo);
  const target = params.targetLocationId ?? '';
  const excluded = new Set<string>();
  const imported = new Set<string>();

  const filtered = params.lines.filter((line) => {
    const key = dayKey(line.date);
    if (key < fromKey || key > toKey) return false;
    const home = params.homeByEmployee.get(line.employeeId);
    if (!home) return false;
    if (home.homeLocationId !== target) {
      if (params.sourceGridIds?.has(line.gridId)) excluded.add(line.employeeId);
      return false;
    }
    return true;
  });

  if (params.sourceGridIds) {
    for (const line of filtered) {
      if (!params.sourceGridIds.has(line.gridId)) imported.add(line.employeeId);
    }
  }

  return {
    lines: filtered,
    excludedEmployeeIds: [...excluded],
    importedEmployeeIds: [...imported],
  };
}

export async function findPeriodMovers(params: {
  dateFrom: Date;
  dateTo: Date;
  locationId?: string | null;
}): Promise<PeriodMover[]> {
  const fromKey = dayKey(params.dateFrom);
  const toKey = dayKey(params.dateTo);
  const locationFilter = params.locationId ? { locationId: params.locationId } : {};

  const weeklyGrids = await prisma.shiftGrid.findMany({
    where: {
      dateFrom: { lte: params.dateTo },
      dateTo: { gte: params.dateFrom },
      mergedFromGridIds: { isEmpty: true },
      ...locationFilter,
    },
    include: { location: { select: { id: true, name: true, actualName: true } } },
    orderBy: { dateFrom: 'asc' },
  });
  if (!weeklyGrids.length) return [];

  const lines = await prisma.shiftGridLine.findMany({
    where: { gridId: { in: weeklyGrids.map((g) => g.id) } },
    select: { employeeId: true, gridId: true, date: true },
  });
  const employeeIds = [...new Set(lines.map((l) => l.employeeId))];
  const cards = employeeIds.length
    ? await prisma.employeeProfile.findMany({
        where: { id: { in: employeeIds } },
        select: {
          id: true,
          locationId: true,
          workLocation: { select: { id: true, name: true, actualName: true } },
        },
      })
    : [];
  const homeByEmployee = resolveEmployeeHomeBranchesFromCards(cards);
  const cardById = new Map(cards.map((e) => [e.id, e]));

  const gridMeta = new Map(
    weeklyGrids.map((g) => [
      g.id,
      {
        locationId: g.locationId ?? '',
        locationName: g.location?.actualName?.trim() || g.location?.name?.trim() || '',
      },
    ]),
  );

  const locsByEmployee = new Map<string, Set<string>>();
  for (const line of lines) {
    const key = dayKey(line.date);
    if (key < fromKey || key > toKey) continue;
    const meta = gridMeta.get(line.gridId);
    if (!meta) continue;
    const set = locsByEmployee.get(line.employeeId) ?? new Set<string>();
    set.add(meta.locationId);
    locsByEmployee.set(line.employeeId, set);
  }

  const movers = [...locsByEmployee.entries()].filter(([, locs]) => locs.size > 1);
  if (!movers.length) return [];

  const employees = await prisma.employeeProfile.findMany({
    where: { id: { in: movers.map(([id]) => id) } },
    select: { id: true, code: true, name: true },
  });
  const empById = new Map(employees.map((e) => [e.id, e]));

  return movers.map(([employeeId, locSet]) => {
    const home = homeByEmployee.get(employeeId);
    const homeLocId = home?.homeLocationId ?? '';
    const card = cardById.get(employeeId);
    const homeName =
      card?.workLocation?.actualName?.trim() ||
      card?.workLocation?.name?.trim() ||
      'فرع غير محدد';
    const locationIds = [...locSet];
    const locationNames = locationIds.map((id) => {
      const g = weeklyGrids.find((x) => x.locationId === id);
      return g?.location?.actualName?.trim() || g?.location?.name?.trim() || id;
    });
    const emp = empById.get(employeeId);
    return {
      employeeId,
      employeeCode: emp?.code ?? '',
      employeeName: emp?.name ?? '',
      homeLocationId: homeLocId,
      homeLocationName: homeName,
      locationIds,
      locationNames,
    };
  });
}

/** Load all lines for Option A merge into targetLocationId within period P. */
export async function loadOptionAMergeLines(params: {
  targetLocationId: string;
  sourceGridIds: string[];
  dateFrom: Date;
  dateTo: Date;
}): Promise<{
  lines: ShiftGridLine[];
  grids: { id: string; dateFrom: Date }[];
  homeByEmployee: Map<string, EmployeeHomeBranch>;
  excludedEmployeeIds: string[];
  importedEmployeeIds: string[];
  crossLocationLineCount: number;
  outOfPeriodLineCount: number;
}> {
  const fromKey = dayKey(params.dateFrom);
  const toKey = dayKey(params.dateTo);
  const weeklyGrids = await prisma.shiftGrid.findMany({
    where: {
      dateFrom: { lte: params.dateTo },
      dateTo: { gte: params.dateFrom },
      mergedFromGridIds: { isEmpty: true },
    },
    orderBy: { dateFrom: 'asc' },
  });

  const allLines = await prisma.shiftGridLine.findMany({
    where: { gridId: { in: weeklyGrids.map((g) => g.id) } },
    orderBy: [{ employeeId: 'asc' }, { date: 'asc' }],
  });

  const employeeIds = [...new Set(allLines.map((l) => l.employeeId))];
  const cards = employeeIds.length
    ? await prisma.employeeProfile.findMany({
        where: { id: { in: employeeIds } },
        select: { id: true, locationId: true },
      })
    : [];
  const homeByEmployee = resolveEmployeeHomeBranchesFromCards(cards);

  const sourceSet = new Set(params.sourceGridIds);
  const { lines, excludedEmployeeIds, importedEmployeeIds } = filterLinesForHomeLocation({
    lines: allLines,
    homeByEmployee,
    targetLocationId: params.targetLocationId,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    sourceGridIds: sourceSet,
  });

  const crossLocationLineCount = lines.filter((l) => !sourceSet.has(l.gridId)).length;
  const outOfPeriodLineCount = allLines.filter((line) => {
    const home = homeByEmployee.get(line.employeeId);
    if (!home || home.homeLocationId !== params.targetLocationId) return false;
    const key = dayKey(line.date);
    return key < fromKey || key > toKey;
  }).length;
  const gridIds = [...new Set(lines.map((l) => l.gridId))];
  const grids = weeklyGrids
    .filter((g) => gridIds.includes(g.id))
    .map((g) => ({ id: g.id, dateFrom: g.dateFrom }));

  return {
    lines,
    grids,
    homeByEmployee,
    excludedEmployeeIds,
    importedEmployeeIds,
    crossLocationLineCount,
    outOfPeriodLineCount,
  };
}

export function isWeeklyGridProduct(grid: Pick<ShiftGrid, 'mergedFromGridIds'>): boolean {
  return isWeeklyGrid(grid);
}
