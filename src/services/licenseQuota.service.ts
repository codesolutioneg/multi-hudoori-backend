import { PrismaClient, UserRole } from '@prisma/client';
import { AppError } from '../utils/errors';

/**
 * SaaS seats per company. The DB triggers (migration 20260930120000) are the hard lock;
 * these helpers give a friendly error before the insert and let bulk flows pre-check.
 */

export const EMPLOYEE_QUOTA_EXCEEDED = 'EMPLOYEE_QUOTA_EXCEEDED';
export const USER_QUOTA_EXCEEDED = 'USER_QUOTA_EXCEEDED';

/** Roles that never take a dashboard seat. */
export const SEATLESS_ROLES: ReadonlySet<string> = new Set([
  UserRole.EMPLOYEE,
  UserRole.PLATFORM_ADMIN,
]);

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
        ? `وصلت الشركة للحد الأقصى للموظفين (${max}). الأرشفة لا تحرّر مقعداً — راجع مدير المنصة.`
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
  const { prismaBase } = await import('../prisma/client');
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
    client.employeeProfile.count({ where: { companyId } }),
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

/** Remaining employee seats, or null when unlimited. */
export async function remainingEmployeeSeats(companyId: string, db?: Db): Promise<number | null> {
  return (await getQuotaSnapshot(companyId, db)).employeesRemaining;
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
