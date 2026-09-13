/**
 * Single source of truth for the late deduction policy.
 *
 * The ladder and the excused-days allowance used to be duplicated in
 * punchReport.service (payroll) and punchReportLine.service (تقرير البصمات),
 * and the two copies disagreed: payroll excused the two smallest late days by
 * minutes while the report excused the two earliest by date. Identical punches
 * could therefore produce a different deduction on the payslip than on the
 * report HR hands to the employee. Both paths now read this module.
 *
 * The policy lives in biotime_config so HR owns it without a deployment.
 */
import type { BioTimeConfig } from '@prisma/client';
import { prisma } from '../prisma/client';

/** Which late days the allowance consumes. */
export const LATE_FORGIVEN_SELECTIONS = ['oldest', 'largest', 'smallest'] as const;
export type LateForgivenSelection = (typeof LATE_FORGIVEN_SELECTIONS)[number];

/** Whose grace wins when a shift carries its own gracePeriodIn. */
export const LATE_GRACE_PRECEDENCES = ['longest', 'policy', 'shift'] as const;
export type LateGracePrecedence = (typeof LATE_GRACE_PRECEDENCES)[number];

export type LatePolicy = {
  /** Minutes late that carry no deduction at all. */
  graceMinutes: number;
  /** Up to this many minutes late costs a quarter day. */
  quarterDayMaxMinutes: number;
  /** Up to this many minutes late costs half a day; anything above costs a full day. */
  halfDayMaxMinutes: number;
  /** Late days excused per period before the ladder applies. 0 disables the allowance. */
  forgivenDaysCount: number;
  forgivenDaysSelection: LateForgivenSelection;
  gracePrecedence: LateGracePrecedence;
  /** Cap on bus-delay permissions reported per period; null means uncapped. */
  permissionCap: number | null;
};

/** Matches the policy HR confirmed: 20 free, 21-30 quarter, 31-60 half, 60+ full. */
export const DEFAULT_LATE_POLICY: LatePolicy = {
  graceMinutes: 20,
  quarterDayMaxMinutes: 30,
  halfDayMaxMinutes: 60,
  forgivenDaysCount: 2,
  forgivenDaysSelection: 'oldest',
  gracePrecedence: 'longest',
  permissionCap: 2,
};

export function parseLateForgivenSelection(value: unknown): LateForgivenSelection {
  const raw = String(value ?? '').trim();
  return (LATE_FORGIVEN_SELECTIONS as readonly string[]).includes(raw)
    ? (raw as LateForgivenSelection)
    : DEFAULT_LATE_POLICY.forgivenDaysSelection;
}

export function parseLateGracePrecedence(value: unknown): LateGracePrecedence {
  const raw = String(value ?? '').trim();
  return (LATE_GRACE_PRECEDENCES as readonly string[]).includes(raw)
    ? (raw as LateGracePrecedence)
    : DEFAULT_LATE_POLICY.gracePrecedence;
}

function positiveInt(value: unknown, fallback: number): number {
  const num = Math.round(Number(value));
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

/**
 * Reads a stored config row into a coherent ladder. Rungs are clamped so a
 * mis-edited config (half day below quarter day) can never invert the ladder.
 */
export function latePolicyFromConfig(config: Partial<BioTimeConfig> | null): LatePolicy {
  if (!config) return DEFAULT_LATE_POLICY;
  const graceMinutes = positiveInt(config.lateGraceMinutes, DEFAULT_LATE_POLICY.graceMinutes);
  const quarterDayMaxMinutes = Math.max(
    graceMinutes,
    positiveInt(config.lateQuarterDayMaxMinutes, DEFAULT_LATE_POLICY.quarterDayMaxMinutes),
  );
  const halfDayMaxMinutes = Math.max(
    quarterDayMaxMinutes,
    positiveInt(config.lateHalfDayMaxMinutes, DEFAULT_LATE_POLICY.halfDayMaxMinutes),
  );
  return {
    graceMinutes,
    quarterDayMaxMinutes,
    halfDayMaxMinutes,
    forgivenDaysCount: positiveInt(
      config.lateForgivenDaysCount,
      DEFAULT_LATE_POLICY.forgivenDaysCount,
    ),
    forgivenDaysSelection: parseLateForgivenSelection(config.lateForgivenDaysSelection),
    gracePrecedence: parseLateGracePrecedence(config.lateGracePrecedence),
    permissionCap:
      config.latePermissionCapEnabled === false
        ? null
        : positiveInt(config.latePermissionCap, DEFAULT_LATE_POLICY.permissionCap ?? 2),
  };
}

export async function getLatePolicy(): Promise<LatePolicy> {
  const config = await prisma.bioTimeConfig.findFirst();
  return latePolicyFromConfig(config);
}

/**
 * API shape for the settings payload. Keys keep the `late` prefix so they read
 * unambiguously alongside the unrelated `duplicateGraceMinutes` setting.
 */
export function latePolicyConfigJson(config: Partial<BioTimeConfig> | null) {
  const policy = latePolicyFromConfig(config);
  return {
    lateGraceMinutes: policy.graceMinutes,
    lateQuarterDayMaxMinutes: policy.quarterDayMaxMinutes,
    lateHalfDayMaxMinutes: policy.halfDayMaxMinutes,
    lateForgivenDaysCount: policy.forgivenDaysCount,
    lateForgivenDaysSelection: policy.forgivenDaysSelection,
    lateGracePrecedence: policy.gracePrecedence,
    latePermissionCap: policy.permissionCap ?? DEFAULT_LATE_POLICY.permissionCap ?? 2,
    latePermissionCapEnabled: policy.permissionCap !== null,
  };
}

/**
 * Grace for one shift. A shift may carry its own gracePeriodIn; which value wins
 * is an HR decision rather than a hardcoded rule.
 */
export function effectiveGraceMinutes(
  policy: LatePolicy,
  shiftGraceMinutes: number | null | undefined,
): number {
  if (shiftGraceMinutes == null) return policy.graceMinutes;
  switch (policy.gracePrecedence) {
    case 'policy':
      return policy.graceMinutes;
    case 'shift':
      return Math.max(0, shiftGraceMinutes);
    default:
      return Math.max(policy.graceMinutes, shiftGraceMinutes);
  }
}

/** Bus-delay permissions reported for a period, capped when the cap is enabled. */
export function cappedPermissionCount(rawCount: number, policy: LatePolicy): number {
  if (policy.permissionCap == null) return rawCount;
  return Math.min(rawCount, policy.permissionCap);
}

/**
 * Deduction in days for a single late day, before the excused-days allowance.
 * Boundaries are inclusive: with the default ladder, exactly 60 minutes costs
 * half a day and 61 costs a full day.
 */
export function lateDayFraction(mins: number, policy: LatePolicy = DEFAULT_LATE_POLICY): number {
  if (!(mins > policy.graceMinutes)) return 0;
  if (mins <= policy.quarterDayMaxMinutes) return 0.25;
  if (mins <= policy.halfDayMaxMinutes) return 0.5;
  return 1;
}

/** The minimum shape both report lines and payroll lines satisfy. */
export type LateCandidateLine = {
  punchDate: Date;
  lateMinutes: number;
  isOffDay: boolean;
  isAbsent: boolean;
  firstCheckIn?: Date | null;
};

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A late day only counts if the employee was actually expected to work it. */
function isLateCandidate(line: LateCandidateLine): boolean {
  return !line.isOffDay && !line.isAbsent && line.lateMinutes > 0;
}

/**
 * Splits the period's late days into the ones the allowance excuses and the
 * ones that get charged. Ordering is fully deterministic so the report and the
 * payslip always excuse the same days.
 */
export function splitForgivenLateDays<T extends LateCandidateLine>(
  lines: T[],
  policy: LatePolicy = DEFAULT_LATE_POLICY,
): { forgiven: T[]; charged: T[] } {
  const candidates = lines.filter(isLateCandidate);
  if (policy.forgivenDaysCount <= 0) return { forgiven: [], charged: candidates };

  const byDateThenCheckIn = (a: T, b: T): number => {
    const dk = dayKey(a.punchDate).localeCompare(dayKey(b.punchDate));
    if (dk !== 0) return dk;
    const ta = a.firstCheckIn?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const tb = b.firstCheckIn?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return ta - tb;
  };

  const ordered = [...candidates].sort((a, b) => {
    if (policy.forgivenDaysSelection === 'largest') {
      if (b.lateMinutes !== a.lateMinutes) return b.lateMinutes - a.lateMinutes;
    } else if (policy.forgivenDaysSelection === 'smallest') {
      if (a.lateMinutes !== b.lateMinutes) return a.lateMinutes - b.lateMinutes;
    }
    return byDateThenCheckIn(a, b);
  });

  return {
    forgiven: ordered.slice(0, policy.forgivenDaysCount),
    charged: ordered.slice(policy.forgivenDaysCount),
  };
}
