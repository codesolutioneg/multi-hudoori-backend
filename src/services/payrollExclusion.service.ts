/**
 * Keep employees removed from a payroll off later punch-report rebuilds.
 */

export function mergePayrollExcludedIds(
  current: string[] | null | undefined,
  toAdd: Iterable<string> = [],
  toRemove: Iterable<string> = [],
): string[] {
  const set = new Set((current ?? []).filter(Boolean));
  for (const id of toAdd) {
    if (id) set.add(id);
  }
  for (const id of toRemove) {
    if (id) set.delete(id);
  }
  return [...set];
}

export function shouldSkipPunchRebuild(
  employeeId: string,
  manualIds: Set<string>,
  excludedIds: Set<string>,
): boolean {
  return manualIds.has(employeeId) || excludedIds.has(employeeId);
}
