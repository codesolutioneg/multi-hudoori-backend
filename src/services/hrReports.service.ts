/**
 * HR compliance reports (تقارير المتابعة).
 *
 * These answer "who is missing what": no punches in a period, no Fawry card,
 * no insurance, incomplete paperwork, expired health certificate.
 *
 * Every axis HR asked about is an option rather than a baked-in choice, because
 * the same report gets used for different questions week to week.
 *
 * Employees with no national ID can be skipped across the reports that depend
 * on one. HR's reason: staff without an Egyptian national ID have neither
 * insurance nor a Fawry card nor local paperwork, so they are noise in those
 * lists rather than findings.
 */
import { prisma } from '../prisma/client';
import type { EmployeeProfile, Prisma } from '@prisma/client';

export type EmployeeScopeFilters = {
  locationId?: string;
  departmentId?: string;
  /** Limit the report population to these employee IDs when provided. */
  employeeIds?: string[];
  /** Skip employees with no Egyptian national ID on file. */
  requireNationalId?: boolean;
  /** Include employees already archived. Off by default. */
  includeArchived?: boolean;
  /** Include employees flagged inactive but not archived. On by default. */
  includeInactive?: boolean;
};

export type EmployeeWithReportRelations = EmployeeProfile & {
  department?: { name: string; nameEn: string | null } | null;
  workLocation?: { name: string } | null;
  mapping?: { biotimeEmpCode: string | null; mobile: string | null } | null;
  insuranceCompany?: { name: string } | null;
  medicalInsuranceCompany?: { name: string } | null;
};

export const REPORT_EMPLOYEE_INCLUDE = {
  department: { select: { name: true, nameEn: true } },
  workLocation: { select: { name: true } },
  mapping: { select: { biotimeEmpCode: true, mobile: true } },
  insuranceCompany: { select: { name: true } },
  medicalInsuranceCompany: { select: { name: true } },
} satisfies Prisma.EmployeeProfileInclude;

export function hasNationalId(emp: Pick<EmployeeProfile, 'nationalIdConfirm'>): boolean {
  return Boolean(emp.nationalIdConfirm?.trim());
}

/** Shared `where` so every report scopes its population identically. */
export function employeeScopeWhere(filters: EmployeeScopeFilters): Prisma.EmployeeProfileWhereInput {
  const where: Prisma.EmployeeProfileWhereInput = {};
  if (filters.locationId) where.locationId = filters.locationId;
  if (filters.departmentId) where.departmentId = filters.departmentId;
  if (filters.employeeIds?.length) where.id = { in: filters.employeeIds };
  if (!filters.includeArchived) where.archivedAt = null;
  if (filters.includeInactive === false) where.active = true;
  if (filters.requireNationalId) {
    where.nationalIdConfirm = { not: null };
  }
  return where;
}

/**
 * Applies the national-ID gate in code as well as SQL. The column stores empty
 * strings as well as nulls, and a `not: null` filter alone would let those
 * through.
 */
export function applyNationalIdGate<T extends Pick<EmployeeProfile, 'nationalIdConfirm'>>(
  employees: T[],
  requireNationalId?: boolean,
): T[] {
  if (!requireNationalId) return employees;
  return employees.filter(hasNationalId);
}

export async function findReportEmployees(
  filters: EmployeeScopeFilters,
): Promise<EmployeeWithReportRelations[]> {
  const employees = await prisma.employeeProfile.findMany({
    where: employeeScopeWhere(filters),
    include: REPORT_EMPLOYEE_INCLUDE,
    orderBy: [{ displayName: 'asc' }, { name: 'asc' }],
  });
  return applyNationalIdGate(employees, filters.requireNationalId);
}

export function reportEmployeeCode(emp: EmployeeWithReportRelations): string {
  return (
    emp.code?.trim() ||
    emp.mapping?.biotimeEmpCode?.trim() ||
    emp.identificationId?.trim() ||
    ''
  );
}

export function reportEmployeeName(emp: EmployeeWithReportRelations): string {
  return emp.displayName?.trim() || emp.name?.trim() || reportEmployeeCode(emp) || '—';
}

/** Common leading columns, so the reports read the same way side by side. */
export const IDENTITY_HEADERS = ['الموقع', 'القسم', 'الكود', 'الاسم', 'الرقم القومي'] as const;

export function identityCells(emp: EmployeeWithReportRelations): string[] {
  return [
    emp.workLocation?.name ?? emp.location ?? '',
    emp.department?.name ?? '',
    reportEmployeeCode(emp),
    reportEmployeeName(emp),
    emp.nationalIdConfirm?.trim() ?? '',
  ];
}

export function yesNo(value: boolean): string {
  return value ? 'نعم' : 'لا';
}

export function dateOnly(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : '';
}
