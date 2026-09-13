import { prisma } from '../prisma/client';

const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidEmployeeCode(code: string): boolean {
  return CODE_PATTERN.test(code);
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
