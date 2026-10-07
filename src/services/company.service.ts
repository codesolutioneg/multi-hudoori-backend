import { prismaBase } from '../prisma/client';
import { hashPassword } from './auth.service';
import { ensureHomeMembership } from './companyMembership.service';
import { UserRole } from '@prisma/client';
import { ensureBioTimeConfigFromEnv } from '../bootstrap/biotimeConfig';
import { ensureOdooConfigFromEnv } from '../bootstrap/odooConfig';
import { getQuotaSnapshot } from './licenseQuota.service';

function normalizeCompanyCode(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Null/empty = unlimited; otherwise a non-negative integer. */
export function parseQuota(raw: unknown, label: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw Object.assign(new Error(`${label} must be a whole number ≥ 0`), {
      errorCode: 'VALIDATION_ERROR',
    });
  }
  return n;
}

const COMPANY_SELECT = {
  id: true,
  code: true,
  name: true,
  active: true,
  maxEmployees: true,
  maxUsers: true,
  subscriptionPlanId: true,
  planNameAr: true,
  planNameEn: true,
  parentCompanyId: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function assertValidParentCompany(companyId: string | null, parentId: string | null): Promise<void> {
  if (!parentId) return;
  if (companyId && parentId === companyId) {
    throw Object.assign(new Error('Company cannot be its own parent'), { errorCode: 'VALIDATION_ERROR' });
  }
  const parent = await prismaBase.company.findFirst({ where: { id: parentId, active: true } });
  if (!parent) {
    throw Object.assign(new Error('Parent company not found'), { errorCode: 'NOT_FOUND' });
  }
  if (!companyId) return;
  let cursor: string | null = parentId;
  for (let depth = 0; depth < 32 && cursor; depth++) {
    const row = await prismaBase.company.findUnique({
      where: { id: cursor },
      select: { parentCompanyId: true },
    });
    if (!row?.parentCompanyId) break;
    if (row.parentCompanyId === companyId) {
      throw Object.assign(new Error('Parent would create a cycle in the company tree'), {
        errorCode: 'VALIDATION_ERROR',
      });
    }
    cursor = row.parentCompanyId;
  }
}

export async function listCompanies() {
  const rows = await prismaBase.company.findMany({
    orderBy: { createdAt: 'desc' },
    select: { ...COMPANY_SELECT, _count: { select: { users: true, employees: true } } },
  });
  const parentIds = [...new Set(rows.map((r) => r.parentCompanyId).filter(Boolean))] as string[];
  const parents =
    parentIds.length === 0
      ? []
      : await prismaBase.company.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, code: true, name: true },
        });
  const parentById = new Map(parents.map((p) => [p.id, p]));
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      parentCompany: row.parentCompanyId ? parentById.get(row.parentCompanyId) ?? null : null,
      quota: await getQuotaSnapshot(row.id, prismaBase),
    })),
  );
}

export async function getCompany(id: string) {
  const company = await prismaBase.company.findUnique({ where: { id }, select: COMPANY_SELECT });
  if (!company) return null;
  return { ...company, quota: await getQuotaSnapshot(id, prismaBase) };
}

type GroupCount = { id: string | null; name: string; count: number };

/** Active employees per bucket; buckets with no employees are kept so empty branches stay visible. */
function groupCounts(
  buckets: Array<{ id: string; name: string }>,
  grouped: Array<{ key: string | null; count: number }>,
): GroupCount[] {
  const byKey = new Map(grouped.map((g) => [g.key, g.count]));
  const rows: GroupCount[] = buckets.map((b) => ({ id: b.id, name: b.name, count: byKey.get(b.id) ?? 0 }));
  const known = new Set(buckets.map((b) => b.id));
  const orphan = grouped
    .filter((g) => g.key == null || !known.has(g.key))
    .reduce((sum, g) => sum + g.count, 0);
  if (orphan > 0) rows.push({ id: null, name: '', count: orphan });
  return rows.sort((a, b) => b.count - a.count);
}

export async function getCompanyStats(companyId: string) {
  const exists = await prismaBase.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!exists) return null;

  const where = { companyId };
  const [quota, active, archived, locations, departments, byLocation, byDepartment] = await Promise.all([
    getQuotaSnapshot(companyId, prismaBase),
    prismaBase.employeeProfile.count({ where: { ...where, active: true } }),
    prismaBase.employeeProfile.count({ where: { ...where, active: false } }),
    prismaBase.location.findMany({ where: { ...where, active: true }, select: { id: true, name: true } }),
    prismaBase.department.findMany({ where: { ...where, active: true }, select: { id: true, name: true } }),
    prismaBase.employeeProfile.groupBy({
      by: ['locationId'],
      where: { ...where, active: true },
      _count: { _all: true },
    }),
    prismaBase.employeeProfile.groupBy({
      by: ['departmentId'],
      where: { ...where, active: true },
      _count: { _all: true },
    }),
  ]);

  return {
    quota,
    employees: { active, archived, total: active + archived },
    locations: groupCounts(
      locations,
      byLocation.map((g) => ({ key: g.locationId, count: g._count._all })),
    ),
    departments: groupCounts(
      departments,
      byDepartment.map((g) => ({ key: g.departmentId, count: g._count._all })),
    ),
  };
}

export type CreateCompanyInput = {
  code: string;
  name: string;
  maxEmployees: number | null;
  maxUsers: number | null;
  parentCompanyId?: string | null;
  hrManagerName?: string;
  hrManagerLogin?: string;
  hrManagerPassword?: string;
};

export async function createCompany(input: CreateCompanyInput) {
  const code = normalizeCompanyCode(input.code);
  const name = input.name.trim();
  if (!code || !name) {
    throw Object.assign(new Error('Code and name are required'), { errorCode: 'VALIDATION_ERROR' });
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(code)) {
    throw Object.assign(
      new Error('Company code must be 2–63 chars: lowercase letters, digits, _ or -'),
      { errorCode: 'VALIDATION_ERROR' },
    );
  }

  const existing = await prismaBase.company.findFirst({
    where: { code: { equals: code, mode: 'insensitive' } },
  });
  if (existing) {
    throw Object.assign(new Error('Company code already exists'), { errorCode: 'DUPLICATE' });
  }

  const parentCompanyId = input.parentCompanyId?.trim() || null;
  await assertValidParentCompany(null, parentCompanyId);

  const hrLoginRequested = Boolean((input.hrManagerLogin ?? '').trim() && input.hrManagerPassword);
  if (hrLoginRequested) {
    if (input.maxUsers === 0) {
      throw Object.assign(new Error('Max users must be at least 1 to create the first HR manager'), {
        errorCode: 'VALIDATION_ERROR',
      });
    }
    if (input.maxEmployees === 0) {
      throw Object.assign(
        new Error('Max employees must be at least 1 to create the first HR manager profile'),
        { errorCode: 'VALIDATION_ERROR' },
      );
    }
  }

  const company = await prismaBase.company.create({
    data: {
      code,
      name,
      active: true,
      maxEmployees: input.maxEmployees,
      maxUsers: input.maxUsers,
      parentCompanyId,
    },
  });

  await ensureBioTimeConfigFromEnv(company.id);
  await ensureOdooConfigFromEnv(company.id);

  let hrManager: { id: string; login: string } | null = null;
  const hrLogin = (input.hrManagerLogin ?? '').trim();
  const hrPassword = input.hrManagerPassword ?? '';
  const hrName = (input.hrManagerName ?? '').trim() || 'HR Manager';

  if (hrLogin && hrPassword) {
    const passwordHash = await hashPassword(hrPassword);
    const user = await prismaBase.user.create({
      data: {
        companyId: company.id,
        login: hrLogin,
        email: hrLogin.includes('@') ? hrLogin : null,
        name: hrName,
        passwordHash,
        initialPassword: hrPassword,
        role: UserRole.HR_MANAGER,
      },
    });
    await prismaBase.employeeProfile.create({
      data: {
        companyId: company.id,
        userId: user.id,
        name: hrName,
        displayName: hrName,
        workEmail: hrLogin.includes('@') ? hrLogin : undefined,
      },
    });
    hrManager = { id: user.id, login: user.login };
    await ensureHomeMembership(user);
  }

  return { company, hrManager };
}

export async function updateCompany(
  id: string,
  data: {
    name?: string;
    active?: boolean;
    maxEmployees?: number | null;
    maxUsers?: number | null;
    parentCompanyId?: string | null;
  },
) {
  const patch: {
    name?: string;
    active?: boolean;
    maxEmployees?: number | null;
    maxUsers?: number | null;
    parentCompanyId?: string | null;
  } = {};
  if (data.name != null) patch.name = data.name.trim();
  if (data.active != null) patch.active = data.active;
  // Lowering below current usage is allowed: it only blocks new rows, never deletes data.
  if (data.maxEmployees !== undefined) patch.maxEmployees = data.maxEmployees;
  if (data.maxUsers !== undefined) patch.maxUsers = data.maxUsers;
  if (data.parentCompanyId !== undefined) {
    const parentId = data.parentCompanyId?.trim() || null;
    await assertValidParentCompany(id, parentId);
    patch.parentCompanyId = parentId;
  }
  return prismaBase.company.update({ where: { id }, data: patch, select: COMPANY_SELECT });
}
