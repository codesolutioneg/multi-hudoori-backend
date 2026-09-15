/**
 * Payable-period and unpaid-absence policy from biotime_config.
 * Fixed month days (e.g. 30) and forgiven absences before «غياب بدون إذن».
 */
import type { BioTimeConfig } from '@prisma/client';
import { prisma } from '../prisma/client';
import { cairoDateOnly, utcDateOnly } from '../utils/payrollPeriod';

export type PayablePeriodPolicy = {
  fixedMonthDaysEnabled: boolean;
  fixedMonthDays: number;
  absentForgivenDaysCount: number;
};

export const DEFAULT_PAYABLE_PERIOD_POLICY: PayablePeriodPolicy = {
  fixedMonthDaysEnabled: false,
  fixedMonthDays: 30,
  absentForgivenDaysCount: 4,
};

export function payablePeriodPolicyFromConfig(
  config: Partial<BioTimeConfig> | null | undefined,
): PayablePeriodPolicy {
  const fixedDays = Number(config?.payrollFixedMonthDays ?? 30);
  const forgiven = Number(config?.absentForgivenDaysCount ?? 4);
  return {
    fixedMonthDaysEnabled: config?.payrollFixedMonthDaysEnabled === true,
    fixedMonthDays:
      Number.isFinite(fixedDays) && fixedDays >= 1 && fixedDays <= 31
        ? Math.round(fixedDays)
        : 30,
    absentForgivenDaysCount:
      Number.isFinite(forgiven) && forgiven >= 0 ? Math.round(forgiven) : 4,
  };
}

/** Calendar inclusive day count between two dates. */
export function calendarPeriodDays(dateFrom: Date, dateTo: Date): number {
  const from = Date.UTC(
    dateFrom.getUTCFullYear(),
    dateFrom.getUTCMonth(),
    dateFrom.getUTCDate(),
  );
  const to = Date.UTC(dateTo.getUTCFullYear(), dateTo.getUTCMonth(), dateTo.getUTCDate());
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

/**
 * True when the requested window looks like a full payroll month (≈28–31 days),
 * not a weekly shift-grid export (~7 days). Fixed-30 must not apply to weeks.
 */
export function isPayrollLengthSpan(scheduledSpanDays: number, fixedMonthDays: number): boolean {
  const threshold = Math.min(28, Math.max(1, fixedMonthDays - 2));
  return scheduledSpanDays >= threshold;
}

/**
 * Days used as the payable base for «أيام العمل الفعلية».
 * Fixed mode on a full payroll month → fixedMonthDays once the cycle ends;
 * mid-cycle → elapsed calendar days (26→today).
 * Short windows (weekly punch report) → calendar length of that window only.
 * Otherwise → calendar length capped at today while the period is still open.
 */
export function resolvePayablePeriodDays(
  dateFrom: Date,
  dateTo: Date,
  policy: PayablePeriodPolicy = DEFAULT_PAYABLE_PERIOD_POLICY,
  asOf: Date = cairoDateOnly(),
): number {
  const from = utcDateOnly(dateFrom);
  const scheduledEnd = utcDateOnly(dateTo);
  const today = utcDateOnly(asOf);
  const effectiveEnd =
    today.getTime() < scheduledEnd.getTime() ? today : scheduledEnd;
  const scheduledSpan = calendarPeriodDays(from, scheduledEnd);

  if (policy.fixedMonthDaysEnabled) {
    if (effectiveEnd.getTime() < scheduledEnd.getTime()) {
      return calendarPeriodDays(from, effectiveEnd);
    }
    if (isPayrollLengthSpan(scheduledSpan, policy.fixedMonthDays)) {
      return Math.max(1, policy.fixedMonthDays);
    }
    return Math.max(1, scheduledSpan);
  }
  return calendarPeriodDays(from, effectiveEnd);
}

/** Full period length for summaries: fixed 30 only for payroll-length windows. */
export function resolveFullPayrollPeriodDays(
  dateFrom: Date,
  dateTo: Date,
  policy: PayablePeriodPolicy = DEFAULT_PAYABLE_PERIOD_POLICY,
): number {
  const span = calendarPeriodDays(dateFrom, dateTo);
  if (policy.fixedMonthDaysEnabled && isPayrollLengthSpan(span, policy.fixedMonthDays)) {
    return Math.max(1, policy.fixedMonthDays);
  }
  return Math.max(1, span);
}

export function payablePeriodConfigJson(config: Partial<BioTimeConfig> | null | undefined) {
  const policy = payablePeriodPolicyFromConfig(config);
  return {
    payrollFixedMonthDaysEnabled: policy.fixedMonthDaysEnabled,
    payrollFixedMonthDays: policy.fixedMonthDays,
    absentForgivenDaysCount: policy.absentForgivenDaysCount,
  };
}

export async function getPayablePeriodPolicy(): Promise<PayablePeriodPolicy> {
  const config = await prisma.bioTimeConfig.findFirst();
  return payablePeriodPolicyFromConfig(config);
}
