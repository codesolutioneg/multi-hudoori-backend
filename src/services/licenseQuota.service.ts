import { PrismaClient, UserRole } from '@prisma/client';
import { AppError } from '../utils/errors';

/**
 * SaaS seats per company. The DB triggers are the hard lock;
 * these helpers give a friendly error before insert/restore and let bulk flows pre-check.
 *
 * Employee seats count **active** profiles only (`active: true`). Archiving frees a seat;
 * restoring from archive consumes one again. `archivedAt` can remain as audit after restore.
 */

export const EMPLOYEE_QUOTA_EXCEEDED = 'EMPLOYEE_QUOTA_EXCEEDED';
export const USER_QUOTA_EXCEEDED = 'USER_QUOTA_EXCEEDED';

/** Roles that never take a dashboard seat. */
export const SEATLESS_ROLES: ReadonlySet<string> = new Set([
  UserRole.EMPLOYEE,
  UserRole.PLATFORM_ADMIN,
]);

/** Prisma where-clause: profiles that consume an employee seat. */
export const EMPLOYEE_SEAT_WHERE = { active: true } as const;

export function roleTakesSeat(role: string | null | undefined): boolean {
  return !SEATLESS_ROLES.has(role ?? UserRole.EMPLOYEE);
}

export type QuotaSnapshot = {
  employeesUsed: number;
  employeesMax: number | null;
  employeesRemaining: number | null;
  usersUsed: number;
  usersMax: number | null;
  usersRemaining: number | null;
};

export class QuotaExceededError extends AppError {
  constructor(
    public readonly kind: 'employees' | 'users',
    public readonly used: number,
    public readonly max: number,
  ) {
    super(
      kind === 'employees'
        ? `وصلت الشركة للحد الأقصى للموظفين النشطين (${max}). الأرشفة تحرّر مقعداً، والاستعادة تتطلب مقعداً متاحاً — راجع مدير المنصة.`
        : `وصلت الشركة للحد الأقصى للمستخدمين (${max}). راجع مدير المنصة.`,
      400,
      kind === 'employees' ? EMPLOYEE_QUOTA_EXCEEDED : USER_QUOTA_EXCEEDED,
    );
  }

  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
}

type Db = Pick<PrismaClient, 'company' | 'employeeProfile' | 'user'>;

async function defaultDb(): Promise<Db> {
  // Lazy: prisma/client imports the tenant extension, which imports this module.
  const { prismaBase } = await import('../prisma/client.js');
  return prismaBase;
}

function remaining(used: number, max: number | null): number | null {
  return max == null ? null : Math.max(0, max - used);
}

export async function getQuotaSnapshot(companyId: string, db?: Db): Promise<QuotaSnapshot> {
  const client = db ?? (await defaultDb());
  const [company, employeesUsed, usersUsed] = await Promise.all([
    client.company.findUnique({
      where: { id: companyId },
      select: { maxEmployees: true, maxUsers: true },
    }),
    client.employeeProfile.count({
      where: { companyId, ...EMPLOYEE_SEAT_WHERE },
    }),
    client.user.count({
      where: { companyId, role: { notIn: [...SEATLESS_ROLES] as UserRole[] } },
    }),
  ]);
  const employeesMax = company?.maxEmployees ?? null;
  const usersMax = company?.maxUsers ?? null;
  return {
    employeesUsed,
    employeesMax,
    employeesRemaining: remaining(employeesUsed, employeesMax),
    usersUsed,
    usersMax,
    usersRemaining: remaining(usersUsed, usersMax),
  };
}

/**
 * Remaining employee seats for creates/imports.
 * Null only when both the company and its group root are unlimited.
 * For a child company, returns min(company remaining, parent-group remaining).
 */
export async function remainingEmployeeSeats(companyId: string, db?: Db): Promise<number | null> {
  const local = (await getQuotaSnapshot(companyId, db)).employeesRemaining;
  const {
    getGroupRootCompanyId,
    listGroupCompanyIds,
    countGroupEmployees,
  } = await import('./companyGroupQuota.service.js');
  const rootId = await getGroupRootCompanyId(companyId);
  const { prismaBase } = await import('../prisma/client.js');
  const root = await prismaBase.company.findUnique({
    where: { id: rootId },
    select: { maxEmployees: true },
  });
  if (!root || root.maxEmployees == null) return local;

  const groupIds = await listGroupCompanyIds(rootId);
  const used = await countGroupEmployees(groupIds);
  const groupLeft = Math.max(0, root.maxEmployees - used);
  if (local == null) return groupLeft;
  return Math.min(local, groupLeft);
}

export async function assertCanCreateEmployees(
  companyId: string,
  addCount = 1,
  db?: Db,
): Promise<void> {
  if (addCount <= 0) return;
  const s = await getQuotaSnapshot(companyId, db);
  if (s.employeesMax != null && s.employeesUsed + addCount > s.employeesMax) {
    throw new QuotaExceededError('employees', s.employeesUsed, s.employeesMax);
  }
  const { assertGroupCanAddEmployees } = await import('./companyGroupQuota.service.js');
  await assertGroupCanAddEmployees(companyId, addCount);
}

export async function assertCanCreateDashboardUsers(
  companyId: string,
  addCount = 1,
  db?: Db,
): Promise<void> {
  if (addCount <= 0) return;
  const s = await getQuotaSnapshot(companyId, db);
  if (s.usersMax != null && s.usersUsed + addCount > s.usersMax) {
    throw new QuotaExceededError('users', s.usersUsed, s.usersMax);
  }
  const { assertGroupCanAddDashboardUsers } = await import('./companyGroupQuota.service.js');
  await assertGroupCanAddDashboardUsers(companyId, addCount);
}

const DB_QUOTA_RE = /(EMPLOYEE|USER)_QUOTA_EXCEEDED:(\d+):(\d+)/;

/** Map a trigger RAISE (surfaced through Prisma) to a QuotaExceededError. */
export function quotaErrorFromDb(err: unknown): QuotaExceededError | null {
  if (err instanceof QuotaExceededError) return err;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const m = DB_QUOTA_RE.exec(msg);
  if (!m) return null;
  return new QuotaExceededError(
    m[1] === 'EMPLOYEE' ? 'employees' : 'users',
    Number(m[2]),
    Number(m[3]),
  );
}

export function isQuotaError(err: unknown): boolean {
  return quotaErrorFromDb(err) != null;
}
