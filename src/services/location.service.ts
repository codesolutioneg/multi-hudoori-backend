import { Location, Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import { NotFoundError } from '../utils/errors';

export async function resolveLocation(id: string): Promise<Location> {
  const loc = await prisma.location.findUnique({ where: { id } });
  if (!loc) throw new NotFoundError('الموقع غير موجود');
  return loc;
}

export async function resolveLocationByName(name: string): Promise<Location | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return prisma.location.findFirst({
    where: {
      active: true,
      OR: [
        { name: { equals: trimmed, mode: 'insensitive' } },
        { code: { equals: trimmed, mode: 'insensitive' } },
      ],
    },
  });
}

export async function applyEmployeeLocation(
  locationId: string | null | undefined,
): Promise<{ locationId: string | null; location: string }> {
  if (locationId === undefined) {
    return { locationId: null, location: '' };
  }
  if (locationId === null || locationId === '') {
    return { locationId: null, location: '' };
  }
  const loc = await resolveLocation(locationId);
  return { locationId: loc.id, location: loc.name };
}

export async function employeesForLocation(locationId: string, activeOnly = true) {
  const where: Prisma.EmployeeProfileWhereInput = { locationId };
  if (activeOnly) where.active = true;
  return prisma.employeeProfile.findMany({
    where,
    include: { department: true, mapping: true, workLocation: true },
    orderBy: [{ displayName: 'asc' }, { name: 'asc' }],
  });
}

export async function assertEmployeeMatchesGridLocation(
  employeeId: string,
  gridLocationId: string | null | undefined,
): Promise<void> {
  if (!gridLocationId) return;
  const emp = await prisma.employeeProfile.findUnique({ where: { id: employeeId } });
  if (!emp) throw new NotFoundError('Employee not found');
  if (emp.locationId !== gridLocationId) {
    throw new Error('الموظف لا ينتمي لموقع هذا الجدول — كل موظف مربوط بفرع واحد فقط');
  }
}

/** Move employee to grid location when different; returns true if updated. */
export async function relocateEmployeeToGridLocation(
  employeeId: string,
  gridLocationId: string | null | undefined,
): Promise<boolean> {
  if (!gridLocationId) return false;
  const emp = await prisma.employeeProfile.findUnique({ where: { id: employeeId } });
  if (!emp) throw new NotFoundError('Employee not found');
  if (emp.locationId === gridLocationId) return false;
  const loc = await applyEmployeeLocation(gridLocationId);
  await prisma.employeeProfile.update({
    where: { id: employeeId },
    data: { locationId: loc.locationId, location: loc.location },
  });
  return true;
}

export async function relocateEmployeesToGridLocation(
  employeeIds: string[],
  gridLocationId: string | null | undefined,
): Promise<number> {
  let moved = 0;
  for (const id of employeeIds) {
    if (await relocateEmployeeToGridLocation(id, gridLocationId)) moved++;
  }
  return moved;
}
