/**
 * How shift grid rows are grouped into sections.
 *
 * The grid has always grouped by job title. The branch also splits into
 * departments (operation and kitchen), and the weekly sheet gets sent out per
 * department, so the grouping key is a choice rather than a fixed rule.
 *
 * Both the on-screen grid and the Excel export read this module so a grid and
 * its export can never disagree about which sections exist.
 */
export const GRID_GROUPINGS = ['job', 'department'] as const;
export type GridGrouping = (typeof GRID_GROUPINGS)[number];

export const DEFAULT_GRID_GROUPING: GridGrouping = 'job';

/** Section label for rows with nothing to group on. */
export const UNGROUPED_JOB_LABEL = 'بدون وظيفة';
export const UNGROUPED_DEPARTMENT_LABEL = 'بدون قسم';

export function parseGridGrouping(value: unknown): GridGrouping {
  const raw = String(value ?? '').trim();
  return (GRID_GROUPINGS as readonly string[]).includes(raw)
    ? (raw as GridGrouping)
    : DEFAULT_GRID_GROUPING;
}

export function ungroupedLabelFor(grouping: GridGrouping): string {
  return grouping === 'department' ? UNGROUPED_DEPARTMENT_LABEL : UNGROUPED_JOB_LABEL;
}

export type GroupableEmployee = {
  jobTitle?: string | null;
  department?: { name: string | null } | null;
  name?: string | null;
  code?: string | null;
  identificationId?: string | null;
  barcode?: string | null;
  mapping?: { biotimeEmpCode?: string | null } | null;
};

/** The section an employee belongs to under the given grouping. */
export function groupKeyFor(emp: GroupableEmployee, grouping: GridGrouping): string {
  if (grouping === 'department') {
    return emp.department?.name?.trim() || UNGROUPED_DEPARTMENT_LABEL;
  }
  return emp.jobTitle?.trim() || UNGROUPED_JOB_LABEL;
}

/**
 * Same code the grid / Excel show in the «كود» column — BioTime code first,
 * then HR profile fallbacks.
 */
export function employeeSortCode(emp: GroupableEmployee): string {
  return (
    emp.mapping?.biotimeEmpCode?.trim() ||
    emp.identificationId?.trim() ||
    emp.code?.trim() ||
    emp.barcode?.trim() ||
    ''
  );
}

/** Numeric-aware code order (11019 before 11028; 8017 before 11006). */
export function compareEmployeeCodes(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * Sorts so sections come out in a stable order with the ungrouped bucket last,
 * then by employee code (ascending) inside each section. Name is only a
 * tie-breaker. Used by both the on-screen grid and Excel export.
 */
export function compareForGrouping<T extends GroupableEmployee>(
  a: T,
  b: T,
  grouping: GridGrouping,
): number {
  const ungrouped = ungroupedLabelFor(grouping);
  const ka = groupKeyFor(a, grouping);
  const kb = groupKeyFor(b, grouping);
  if (ka !== kb) {
    if (ka === ungrouped) return 1;
    if (kb === ungrouped) return -1;
    return ka.localeCompare(kb, 'ar');
  }
  const codeCmp = compareEmployeeCodes(employeeSortCode(a), employeeSortCode(b));
  if (codeCmp !== 0) return codeCmp;
  return (a.name ?? '').localeCompare(b.name ?? '', 'ar');
}
