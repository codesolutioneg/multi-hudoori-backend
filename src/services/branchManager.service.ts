/**
 * Who acts as «مدير الفرع» for a branch.
 *
 * The advance-request flow needs somebody at every site to vouch for a request
 * before HR sees it, but only one of the eighteen branches has a user carrying the
 * `BRANCH_MANAGER` role. So the answer is resolved rather than read off a role:
 *
 *   1. the employee explicitly set on the location («مدير الفرع» in settings), else
 *   2. the most senior person the org chart derives for that site, else
 *   3. nobody — and the branch cannot raise advance requests until HR sets one.
 *
 * A resolved manager still needs a login to act, so the resolution carries the
 * user id when the employee has one.
 */
import { UserRole } from '@prisma/client';
import { prisma } from '../prisma/client';
import { computeEffectiveParents, loadRankResolver } from './orgChart.service';

export type BranchManager = {
  locationId: string;
  employeeId: string;
  employeeName: string;
  userId: string | null;
  /** How we arrived at this person, so the UI can say whether it was a choice. */
  source: 'explicit' | 'derived';
};

type EmpRow = {
  id: string;
  name: string;
  userId: string | null;
  jobTitle: string | null;
  locationId: string | null;
  departmentId: string | null;
  managerId: string | null;
};

const EMP_SELECT = {
  id: true,
  name: true,
  userId: true,
  jobTitle: true,
  locationId: true,
  departmentId: true,
  managerId: true,
} as const;

/**
 * The head of a site: the one person the derived tree leaves without a parent.
 * A site with several roots (or none, like a pool of drivers with no lead) has no
 * single head, and this returns null rather than picking one arbitrarily.
 */
export function deriveSiteHead(
  employees: EmpRow[],
  parents: Map<string, string | null>,
): EmpRow | null {
  const roots = employees.filter((e) => !parents.get(e.id));
  return roots.length === 1 ? roots[0] : null;
}

export async function resolveBranchManager(
  locationId: string | null | undefined,
): Promise<BranchManager | null> {
  if (!locationId) return null;

  const location = await prisma.location.findUnique({
    where: { id: locationId },
    select: {
      id: true,
      managerEmployeeId: true,
      manager: { select: EMP_SELECT },
    },
  });
  if (!location) return null;

  if (location.manager) {
    return {
      locationId: location.id,
      employeeId: location.manager.id,
      employeeName: location.manager.name,
      userId: location.manager.userId,
      source: 'explicit',
    };
  }

  const [employees, rankOf] = await Promise.all([
    prisma.employeeProfile.findMany({
      where: { active: true, locationId },
      select: EMP_SELECT,
      orderBy: [{ name: 'asc' }],
    }),
    loadRankResolver(),
  ]);
  if (!employees.length) return null;

  const head = deriveSiteHead(employees, computeEffectiveParents(employees, rankOf));
  if (!head) return null;

  return {
    locationId: location.id,
    employeeId: head.id,
    employeeName: head.name,
    userId: head.userId,
    source: 'derived',
  };
}

/**
 * Every branch this user signs off for. Usually one, but an explicit designation
 * can put the same person over more than one site.
 */
export async function locationsManagedBy(userId: string): Promise<string[]> {
  const profile = await prisma.employeeProfile.findFirst({
    where: { userId },
    select: { id: true, locationId: true },
  });

  const explicit = await prisma.location.findMany({
    where: profile ? { managerEmployeeId: profile.id } : { id: '' },
    select: { id: true },
  });
  const managed = new Set(explicit.map((l) => l.id));

  // A user carrying the role is a manager of the branch on their account, and the
  // derived head of their own site is one too — but only while no one is set
  // explicitly, which `resolveBranchManager` already decides.
  if (profile?.locationId && !managed.has(profile.locationId)) {
    const resolved = await resolveBranchManager(profile.locationId);
    if (resolved?.employeeId === profile.id) managed.add(profile.locationId);
  }

  return [...managed];
}

/** Does this user sign off advance requests for that branch? */
export async function isBranchManagerOf(
  user: { id: string; role: UserRole; locationId?: string | null },
  locationId: string | null | undefined,
): Promise<boolean> {
  if (!locationId) return false;
  // A user given the role outright manages the branch on their account, whatever
  // the org chart says.
  if (user.role === UserRole.BRANCH_MANAGER && user.locationId === locationId) {
    return true;
  }
  const resolved = await resolveBranchManager(locationId);
  return Boolean(resolved?.userId && resolved.userId === user.id);
}

export function branchManagerJson(manager: BranchManager | null) {
  if (!manager) return null;
  return {
    employeeId: manager.employeeId,
    employeeName: manager.employeeName,
    userId: manager.userId,
    source: manager.source,
    /** Without a login the designation is decorative — they cannot approve. */
    canApprove: manager.userId != null,
  };
}
