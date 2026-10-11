import { prisma } from '../prisma/client';
import { deleteEmployee } from './employeeDelete.service';

const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidEmployeeCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

export type EmployeeCodeConflict = {
  id: string;
  name: string | null;
  code: string | null;
  active: boolean;
  archivedAt: Date | null;
};

function codeMatchWhere(code: string, excludeEmployeeId?: string) {
  const normalized = code.trim();
  return {
    ...(excludeEmployeeId ? { id: { not: excludeEmployeeId } } : {}),
    OR: [
      { code: { equals: normalized, mode: 'insensitive' as const } },
      { identificationId: { equals: normalized, mode: 'insensitive' as const } },
      { barcode: { equals: normalized, mode: 'insensitive' as const } },
      { mapping: { biotimeEmpCode: { equals: normalized, mode: 'insensitive' as const } } },
    ],
  };
}

export function isArchivedEmployeeConflict(row: EmployeeCodeConflict): boolean {
  return !row.active || row.archivedAt != null;
}

/** Active (non-archived) holder of this fingerprint/employee code, if any. */
export async function findActiveEmployeeCodeConflict(
  code: string,
  excludeEmployeeId?: string,
): Promise<EmployeeCodeConflict | null> {
  const normalized = code.trim();
  if (!normalized) return null;
  return prisma.employeeProfile.findFirst({
    where: {
      AND: [
        codeMatchWhere(normalized, excludeEmployeeId),
        { active: true, archivedAt: null },
      ],
    },
    select: { id: true, name: true, code: true, active: true, archivedAt: true },
  });
}

/** Archived holder of this code (for confirm-to-take flow). */
export async function findArchivedEmployeeCodeConflict(
  code: string,
  excludeEmployeeId?: string,
): Promise<EmployeeCodeConflict | null> {
  const normalized = code.trim();
  if (!normalized) return null;
  return prisma.employeeProfile.findFirst({
    where: {
      AND: [
        codeMatchWhere(normalized, excludeEmployeeId),
        { OR: [{ active: false }, { archivedAt: { not: null } }] },
      ],
    },
    select: { id: true, name: true, code: true, active: true, archivedAt: true },
    orderBy: { archivedAt: 'desc' },
  });
}

/** Permanently remove archived profiles that still hold this code so it can be reused. */
export async function deleteArchivedEmployeesHoldingCode(
  code: string,
  excludeEmployeeId?: string,
): Promise<{ deletedIds: string[]; deletedNames: string[] }> {
  const normalized = code.trim();
  if (!normalized) return { deletedIds: [], deletedNames: [] };
  const rows = await prisma.employeeProfile.findMany({
    where: {
      AND: [
        codeMatchWhere(normalized, excludeEmployeeId),
        { OR: [{ active: false }, { archivedAt: { not: null } }] },
      ],
    },
    select: { id: true, name: true },
  });
  const deletedIds: string[] = [];
  const deletedNames: string[] = [];
  for (const row of rows) {
    await deleteEmployee(row.id);
    deletedIds.push(row.id);
    deletedNames.push(row.name || row.id);
  }
  return { deletedIds, deletedNames };
}

/** Next unique code: E1001, E1002, … (matches common BioTime emp_code style). */
export async function generateUniqueEmployeeCode(nameHint?: string): Promise<string> {
  const [profiles, mappings] = await Promise.all([
    prisma.employeeProfile.findMany({ where: { code: { not: null } }, select: { code: true } }),
    prisma.employeeMapping.findMany({
      where: { biotimeEmpCode: { not: null } },
      select: { biotimeEmpCode: true },
    }),
  ]);

  const used = new Set<string>();
  for (const row of profiles) {
    if (row.code) used.add(row.code.toUpperCase());
  }
  for (const row of mappings) {
    if (row.biotimeEmpCode) used.add(row.biotimeEmpCode.toUpperCase());
  }

  let maxNum = 1000;
  for (const c of used) {
    const m = c.match(/^E(\d+)$/i);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }
  for (let n = maxNum + 1; n < maxNum + 50_000; n++) {
    const candidate = `E${n}`;
    if (!used.has(candidate)) return candidate;
  }

  const base =
    (nameHint ?? '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/[^\w\u0600-\u06FF]/g, '')
      .toUpperCase()
      .slice(0, 8) || 'EMP';

  for (let i = 1; i < 50_000; i++) {
    const candidate = `${base}${i}`;
    if (!used.has(candidate)) return candidate;
  }

  throw new Error('تعذر توليد كود فريد للموظف');
}
