import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import { ForbiddenError } from '../utils/errors';

/** Branch-level HR and branch managers only — HR_MANAGER / HR_SUPERVISOR see all locations. */
const SCOPED_HR_ROLES: UserRole[] = [UserRole.HR_USER, UserRole.BRANCH_MANAGER];

export function isLocationScopedHrRole(role: UserRole): boolean {
  return SCOPED_HR_ROLES.includes(role);
}

function isGlobalHrRole(role: UserRole): boolean {
  return role === UserRole.PLATFORM_ADMIN || role === UserRole.HR_MANAGER || role === UserRole.HR_SUPERVISOR;
}

export function hasUnrestrictedLocationAccess(role: UserRole): boolean {
  return isGlobalHrRole(role);
}

export function isBranchManagerRole(role: UserRole): boolean {
  return role === UserRole.BRANCH_MANAGER;
}

/** Returns assigned location for scoped HR users; null means no restriction (see all locations). */
export async function getHrLocationScope(userId: string, role: UserRole): Promise<string | null> {
  if (isGlobalHrRole(role)) return null;
  if (!isLocationScopedHrRole(role)) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { locationId: true },
  });
  return user?.locationId ?? null;
}

export function assertGridLocationAccess(scope: string | null, gridLocationId: string | null | undefined): void {
  if (!scope) return;
  if (gridLocationId !== scope) {
    throw new ForbiddenError('Access denied for this location', 'ACCESS_DENIED');
  }
}

export async function getHrLocationScopeFromReq(req: Request): Promise<string | null> {
  if (!req.user) return null;
  if (isGlobalHrRole(req.user.role)) return null;
  if (req.user.locationId) return req.user.locationId;
  return getHrLocationScope(req.user.id, req.user.role);
}

export async function applyHrLocationScopeToEmployeeWhere(
  req: Request,
  where: Prisma.EmployeeProfileWhereInput,
): Promise<void> {
  const scope = await getHrLocationScopeFromReq(req);
  if (scope) where.locationId = scope;
}

export function assertEmployeeLocationAccess(
  scope: string | null,
  employeeLocationId: string | null | undefined,
): void {
  if (!scope) return;
  if (employeeLocationId !== scope) {
    throw new ForbiddenError('Access denied for this location', 'ACCESS_DENIED');
  }
}
