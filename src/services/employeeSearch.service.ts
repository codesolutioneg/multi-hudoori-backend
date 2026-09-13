import { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';

const employeeInclude = {
  department: true,
  mapping: true,
  workLocation: true,
} as const;

type EmployeeRow = Prisma.EmployeeProfileGetPayload<{ include: typeof employeeInclude }>;

/** Shared OR clauses for employee picker search (name, code, Odoo/biotime code). */
export function employeeSearchOrConditions(search: string): Prisma.EmployeeProfileWhereInput[] {
  return [
    { name: { contains: search, mode: 'insensitive' } },
    { displayName: { contains: search, mode: 'insensitive' } },
    { code: { contains: search, mode: 'insensitive' } },
    { identificationId: { contains: search, mode: 'insensitive' } },
    { nationalIdConfirm: { contains: search } },
    { workPhone: { contains: search } },
    { mobilePhone: { contains: search } },
    { workEmail: { contains: search, mode: 'insensitive' } },
    { mapping: { firstName: { contains: search, mode: 'insensitive' } } },
    { mapping: { lastName: { contains: search, mode: 'insensitive' } } },
    { mapping: { biotimeEmpCode: { contains: search, mode: 'insensitive' } } },
    { mapping: { mobile: { contains: search } } },
  ];
}

function employeeCodes(emp: EmployeeRow): string[] {
  return [emp.code, emp.mapping?.biotimeEmpCode, emp.identificationId]
    .map((c) => c?.trim() ?? '')
    .filter(Boolean);
}

/** Higher = better match. Exact code first, then prefix, then substring. */
export function rankEmployeeSearchMatch(emp: EmployeeRow, search: string): number {
  const q = search.trim();
  if (!q) return 0;
  const qLower = q.toLowerCase();
  for (const code of employeeCodes(emp)) {
    const c = code.toLowerCase();
    if (c === qLower) return 1000;
    if (c.startsWith(qLower)) return 500;
    if (c.includes(qLower)) return 200;
  }
  const name = (emp.displayName ?? emp.name ?? '').toLowerCase();
  if (name.startsWith(qLower)) return 80;
  if (name.includes(qLower)) return 40;
  return 1;
}

/**
 * List employees for HR pickers — exact Odoo/code match first when query looks numeric.
 */
export async function listEmployeesForSearch(params: {
  where: Prisma.EmployeeProfileWhereInput;
  search: string;
  limit: number;
  offset: number;
}): Promise<{ employees: EmployeeRow[]; total: number }> {
  const search = params.search.trim();
  const where: Prisma.EmployeeProfileWhereInput = { ...params.where };
  if (search) {
    where.OR = employeeSearchOrConditions(search);
  }

  const total = await prisma.employeeProfile.count({ where });
  if (!search) {
    const employees = await prisma.employeeProfile.findMany({
      where,
      include: employeeInclude,
      orderBy: [{ displayName: 'asc' }, { name: 'asc' }],
      skip: params.offset,
      take: params.limit,
    });
    return { employees, total };
  }

  const isNumericCode = /^\d+$/.test(search);
  const fetchCap = isNumericCode
    ? Math.min(Math.max(params.limit + params.offset, 120), 500)
    : params.limit + params.offset;

  let employees = await prisma.employeeProfile.findMany({
    where,
    include: employeeInclude,
    orderBy: [{ displayName: 'asc' }, { name: 'asc' }],
    take: fetchCap,
  });

  if (isNumericCode) {
    employees = [...employees].sort(
      (a, b) => rankEmployeeSearchMatch(b, search) - rankEmployeeSearchMatch(a, search),
    );
  }

  const page = employees.slice(params.offset, params.offset + params.limit);
  return { employees: page, total };
}
