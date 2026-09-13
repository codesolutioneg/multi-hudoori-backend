import type { Shift } from '@prisma/client';
import { prisma } from '../prisma/client';
import { ForbiddenError } from '../utils/errors';
import { sortShiftsForDisplay } from './shiftCalculations.service';

async function shiftIdsForLocation(locationId: string): Promise<string[]> {
  const [lines, assignments] = await Promise.all([
    prisma.shiftGridLine.findMany({
      where: { grid: { locationId }, shiftId: { not: null } },
      select: { shiftId: true },
      distinct: ['shiftId'],
    }),
    prisma.shiftAssignment.findMany({
      where: { employee: { locationId }, active: true },
      select: {
        shiftId: true,
        saturdayShiftId: true,
        sundayShiftId: true,
        mondayShiftId: true,
        tuesdayShiftId: true,
        wednesdayShiftId: true,
        thursdayShiftId: true,
        fridayShiftId: true,
      },
    }),
  ]);

  const ids = new Set<string>();
  for (const line of lines) {
    if (line.shiftId) ids.add(line.shiftId);
  }
  for (const row of assignments) {
    for (const id of [
      row.shiftId,
      row.saturdayShiftId,
      row.sundayShiftId,
      row.mondayShiftId,
      row.tuesdayShiftId,
      row.wednesdayShiftId,
      row.thursdayShiftId,
      row.fridayShiftId,
    ]) {
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export async function listShiftsForLocationScope(locationScope: string | null): Promise<Shift[]> {
  if (!locationScope) {
    return sortShiftsForDisplay(await prisma.shift.findMany());
  }
  const ids = await shiftIdsForLocation(locationScope);
  if (ids.length === 0) return [];
  return sortShiftsForDisplay(await prisma.shift.findMany({ where: { id: { in: ids } } }));
}

export async function assertShiftLocationAccess(
  locationScope: string | null,
  shiftId: string,
): Promise<void> {
  if (!locationScope) return;
  const allowed = await shiftIdsForLocation(locationScope);
  if (!allowed.includes(shiftId)) {
    throw new ForbiddenError('Access denied for this shift', 'ACCESS_DENIED');
  }
}
