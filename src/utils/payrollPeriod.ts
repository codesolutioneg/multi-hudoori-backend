/**
 * Date-only values (@db.Date, birthdays, "today", year bounds) are UTC midnight.
 * Build with Date.UTC / utcDateOnly and read with getUTC* — never setHours(0,0,0,0)
 * or new Date(y, m, d), which bind to the server's local zone and shift the day.
 */

export function utcDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Inclusive end of a UTC calendar day (23:59:59.999Z). */
export function utcEndOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/** Add whole calendar days on the UTC date (safe across DST). */
export function addUtcDays(d: Date, days: number): Date {
  const base = utcDateOnly(d);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days));
}

/** YYYY-MM-DD from a UTC calendar day / @db.Date. */
export function utcCalendarKey(d: Date): string {
  return utcDateOnly(d).toISOString().slice(0, 10);
}

/** Business calendar day in Africa/Cairo, stored as UTC midnight. */
export function cairoDateOnly(now = new Date()): Date {
  const key = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Inclusive Cairo calendar month containing `ref`. */
export function cairoMonthRange(ref = new Date()): { dateFrom: Date; dateTo: Date } {
  const today = cairoDateOnly(ref);
  const dateFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const dateTo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return { dateFrom, dateTo };
}

/** Inclusive number of calendar days between two UTC dates. */
export function periodDays(dateFrom: Date, dateTo: Date): number {
  const ms = utcDateOnly(dateTo).getTime() - utcDateOnly(dateFrom).getTime();
  return Math.max(1, Math.floor(ms / 86400000) + 1);
}

export type PayrollCutoffEmployee = {
  active: boolean;
  archivedAt?: Date | null;
  departureDate?: Date | null;
};

/**
 * Effective inclusive end date of the payable period for an employee.
 * Returns null when the employee was archived/departed before the period
 * starts and must be skipped entirely.
 */
export function effectivePayrollEnd(
  payrollDateFrom: Date,
  payrollDateTo: Date,
  emp: PayrollCutoffEmployee,
): Date | null {
  const end = utcDateOnly(payrollDateTo);

  // restoreEmployee() keeps archivedAt as an audit trail and only clears
  // departureDate, so a stale archive stamp must never cut a rehired
  // employee's pay. Only a genuine departure closes the period.
  const hasDeparted = !emp.active || Boolean(emp.departureDate);
  if (!hasDeparted) return end;

  const cutoff = emp.archivedAt
    ? utcDateOnly(emp.archivedAt)
    : emp.departureDate
      ? utcDateOnly(emp.departureDate)
      : null;
  if (!cutoff) return end;

  if (cutoff < utcDateOnly(payrollDateFrom)) return null;
  return cutoff < end ? cutoff : end;
}
