import type { Shift } from '@prisma/client';
import { utcDateOnly } from '../utils/payrollPeriod';
import { computeTotalHours, parseTimeToFloat } from './shiftCalculations.service';

export const CHECK_IN_STATES = new Set(['0', '2', '4', 'I']);
export const CHECK_OUT_STATES = new Set(['1', '3', '5', 'O']);

export function isCheckInState(state: string | null | undefined): boolean {
  return state != null && CHECK_IN_STATES.has(state);
}

export function isCheckOutState(state: string | null | undefined): boolean {
  return state != null && CHECK_OUT_STATES.has(state);
}

/** Weekday from a UTC calendar day / wall-clock-as-UTC instant (Mon=0 … Sun=6). */
export function jsToOdooWeekday(d: Date): number {
  const wd = d.getUTCDay();
  return wd === 0 ? 6 : wd - 1;
}

function wallClockHour(d: Date): number {
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

export function shiftStartFloat(shift: Shift): number {
  return parseTimeToFloat(shift.startTime);
}

export function shiftEndFloat(shift: Shift): number {
  return parseTimeToFloat(shift.endTime);
}

export function shiftExpectedHours(shift: Shift): number {
  return computeTotalHours(
    shiftStartFloat(shift),
    shiftEndFloat(shift),
    shift.breakDuration ?? 0,
    shift.isOvernight,
  );
}

export const MIN_OVERTIME_HOURS = 0.25;

/**
 * Soft minutes past end+late_checkout_threshold still counted on the overnight
 * shift. Covers device seconds (e.g. end 01:00 + 4h → window 05:00, punch 05:03).
 */
export const OVERNIGHT_CHECKOUT_SOFT_GRACE_HOURS = 15 / 60;

/** Company-wide fallback when a shift has no usable late-checkout threshold. */
export const DEFAULT_LATE_CHECKOUT_HOURS = 4;
export const DEFAULT_EARLY_CHECKIN_HOURS = 2;

export function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

export function resolveLateCheckoutHours(
  shift: { lateCheckoutThreshold?: number | null } | null | undefined,
  companyDefault: number = DEFAULT_LATE_CHECKOUT_HOURS,
): number {
  const raw = shift?.lateCheckoutThreshold;
  if (raw != null && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw);
  return companyDefault > 0 ? companyDefault : DEFAULT_LATE_CHECKOUT_HOURS;
}

export function resolveEarlyCheckinHours(
  shift: { earlyCheckinThreshold?: number | null } | null | undefined,
  companyDefault: number = DEFAULT_EARLY_CHECKIN_HOURS,
): number {
  const raw = shift?.earlyCheckinThreshold;
  if (raw != null && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw);
  return companyDefault > 0 ? companyDefault : DEFAULT_EARLY_CHECKIN_HOURS;
}

export type OvernightCheckoutWindowOptions = {
  /** Effective hours after end_time (shift or company default). */
  lateCheckoutHours?: number;
  softGraceHours?: number;
  /**
   * When the next calendar day has a daytime shift, do not claim punches that
   * fall in that shift's early-check-in zone (start − earlyCheckinHours) —
   * same idea as Odoo punch-report ordering.
   */
  nextShiftStartHour?: number | null;
  nextShiftEarlyCheckinHours?: number;
};

/**
 * True when an early-morning punch-hour still belongs to an overnight shift
 * that ended after midnight (end + dynamic late window, inclusive + soft grace),
 * capped so we do not steal the next shift's early check-in punches.
 */
export function isWithinOvernightCheckoutWindow(
  punchHour: number,
  shift: { endTime: string; lateCheckoutThreshold?: number | null },
  options: OvernightCheckoutWindowOptions = {},
): boolean {
  const endH = parseTimeToFloat(shift.endTime);
  const threshold =
    options.lateCheckoutHours != null && Number.isFinite(options.lateCheckoutHours)
      ? Number(options.lateCheckoutHours)
      : resolveLateCheckoutHours(shift);
  const softGrace =
    options.softGraceHours != null ? Math.max(0, options.softGraceHours) : OVERNIGHT_CHECKOUT_SOFT_GRACE_HOURS;
  let cutoff = endH + threshold + softGrace;

  if (options.nextShiftStartHour != null && Number.isFinite(options.nextShiftStartHour)) {
    const early = options.nextShiftEarlyCheckinHours ?? DEFAULT_EARLY_CHECKIN_HOURS;
    const nextEarlyBound = Number(options.nextShiftStartHour) - early;
    // Stay strictly before the next shift's early-check-in window.
    cutoff = Math.min(cutoff, nextEarlyBound - 1 / 60);
  }

  return punchHour <= cutoff;
}

/** Day context used when deciding which work-date owns a morning punch. */
export type PunchDayShiftContext = {
  shift: {
    startTime: string;
    endTime: string;
    isOvernight: boolean;
    lateCheckoutThreshold?: number | null;
    earlyCheckinThreshold?: number | null;
  } | null;
  isOff?: boolean;
  isSick?: boolean;
  isAnnual?: boolean;
  isExcluded?: boolean;
};

export type OvernightMorningAttribution = {
  /** True when this helper decided the work-date (caller should not fall through). */
  handled: boolean;
  usePreviousDay: boolean;
  reason:
    | 'overnight_window'
    | 'leave_or_empty_follow_day'
    | 'proximity_prev'
    | 'proximity_today'
    | 'early_checkin'
    | 'calendar'
    | 'skipped';
};

function isNonWorkDayContext(day: PunchDayShiftContext): boolean {
  return Boolean(day.isOff || day.isSick || day.isAnnual || day.isExcluded || !day.shift);
}

/**
 * Day shift ends before midnight (e.g. 21:30) but late checkout may spill past
 * 00:00. Return true when punchHour (on the next calendar morning) is still
 * inside end + late window wrapped past midnight — capped so we do not steal
 * today's early check-in.
 */
export function isWithinDayShiftPastMidnightCheckoutWindow(
  punchHour: number,
  shift: { endTime: string; lateCheckoutThreshold?: number | null },
  options: OvernightCheckoutWindowOptions = {},
): boolean {
  const endH = parseTimeToFloat(shift.endTime);
  // Overnight ends are already handled by isWithinOvernightCheckoutWindow.
  if (endH < 12) return false;

  const threshold =
    options.lateCheckoutHours != null && Number.isFinite(options.lateCheckoutHours)
      ? Number(options.lateCheckoutHours)
      : resolveLateCheckoutHours(shift);
  const softGrace =
    options.softGraceHours != null ? Math.max(0, options.softGraceHours) : OVERNIGHT_CHECKOUT_SOFT_GRACE_HOURS;
  // Hours after midnight still belonging to yesterday's day shift.
  let pastMidnightCutoff = endH + threshold + softGrace - 24;
  if (pastMidnightCutoff <= 0) return false;

  if (options.nextShiftStartHour != null && Number.isFinite(options.nextShiftStartHour)) {
    const early = options.nextShiftEarlyCheckinHours ?? DEFAULT_EARLY_CHECKIN_HOURS;
    const nextEarlyBound = Number(options.nextShiftStartHour) - early;
    pastMidnightCutoff = Math.min(pastMidnightCutoff, nextEarlyBound - 1 / 60);
  }

  return punchHour <= pastMidnightCutoff;
}

function distanceToPrevExpectedOut(
  punchHour: number,
  prevShift: { startTime: string; endTime: string; isOvernight: boolean },
  lateCheckoutHours: number,
): number {
  const endH = parseTimeToFloat(prevShift.endTime);
  if (prevShift.isOvernight || endH < 12) {
    return Math.abs(punchHour - endH);
  }
  // Day shift ended yesterday evening; expected late out sits just after midnight.
  const expectedOnNextMorning = endH + lateCheckoutHours - 24;
  return Math.abs(punchHour - expectedOnNextMorning);
}

/**
 * Decide whether an early-morning punch belongs to yesterday's shift
 * (overnight OR day shift that spilled past midnight) or to today's schedule.
 *
 * Beyond the formal late-checkout window (end + threshold), HR still wants:
 * - following **إجازة / no shift** → keep the punch on yesterday
 *   (07:20 after a 16:00→01:00 C.4 must not sit alone on the leave day);
 * - following **day shift** → nearest of (prev expected out, today expected in).
 */
export function resolveOvernightMorningAttribution(params: {
  punchHour: number;
  prev: PunchDayShiftContext;
  today: PunchDayShiftContext;
  lateCheckoutHours: number;
  earlyCheckinHours: number;
  /** When true, a morning punch on a day-shift day stays on that calendar day. */
  isCheckIn?: boolean;
}): OvernightMorningAttribution {
  const { punchHour, prev, today, lateCheckoutHours, earlyCheckinHours, isCheckIn } = params;
  const todayNonWork = isNonWorkDayContext(today);
  const todayDayShift = today.shift && !today.shift.isOvernight ? today.shift : null;
  const todayStart = todayDayShift ? parseTimeToFloat(todayDayShift.startTime) : null;
  const prevShift = prev.shift;

  // HR: check-in on the same calendar day as a scheduled day shift counts for that day
  // (e.g. 06:00 IN for a 16:00 shift), even when yesterday was overnight / late spill.
  if (
    isCheckIn === true &&
    todayDayShift &&
    todayStart != null &&
    punchHour < todayStart
  ) {
    return { handled: true, usePreviousDay: false, reason: 'early_checkin' };
  }

  const prevLateBand = prevShift?.isOvernight
    ? parseTimeToFloat(prevShift.endTime) + lateCheckoutHours + 0.25
    : prevShift && !prevShift.isOvernight
      ? Math.max(6, parseTimeToFloat(prevShift.endTime) + lateCheckoutHours + 0.25 - 24)
      : 6;
  const morningGate = Math.max(6, prevLateBand);

  const morningish =
    punchHour < morningGate ||
    (todayNonWork && punchHour < 12) ||
    (isCheckIn !== true && todayStart != null && punchHour < todayStart);

  const considerPrevLateOut = !!prevShift && morningish;

  if (!considerPrevLateOut || !prevShift) {
    if (punchHour < morningGate && todayDayShift) {
      return { handled: true, usePreviousDay: false, reason: 'early_checkin' };
    }
    if (punchHour < morningGate && todayNonWork) {
      return { handled: true, usePreviousDay: true, reason: 'leave_or_empty_follow_day' };
    }
    return { handled: false, usePreviousDay: false, reason: 'skipped' };
  }

  const inLateWindow = prevShift.isOvernight
    ? isWithinOvernightCheckoutWindow(punchHour, prevShift, {
        lateCheckoutHours,
        nextShiftStartHour: todayStart,
        nextShiftEarlyCheckinHours: earlyCheckinHours,
      })
    : isWithinDayShiftPastMidnightCheckoutWindow(punchHour, prevShift, {
        lateCheckoutHours,
        nextShiftStartHour: todayStart,
        nextShiftEarlyCheckinHours: earlyCheckinHours,
      });

  if (inLateWindow) {
    return { handled: true, usePreviousDay: true, reason: 'overnight_window' };
  }

  if (todayNonWork) {
    return { handled: true, usePreviousDay: true, reason: 'leave_or_empty_follow_day' };
  }

  if (todayDayShift && todayStart != null) {
    const distPrev = distanceToPrevExpectedOut(punchHour, prevShift, lateCheckoutHours);
    const distToday = Math.abs(punchHour - todayStart);
    if (distPrev <= distToday) {
      return { handled: true, usePreviousDay: true, reason: 'proximity_prev' };
    }
    return { handled: true, usePreviousDay: false, reason: 'proximity_today' };
  }

  // Today is another overnight (or unknown working shift): prefer previous out.
  return { handled: true, usePreviousDay: true, reason: 'leave_or_empty_follow_day' };
}

/** Odoo attendance summary: ignore overtime under 15 minutes */
export function finalizeOvertimeHours(overtime: number): number {
  return overtime >= MIN_OVERTIME_HOURS ? roundHours(overtime) : 0;
}

/** Odoo punch report: overtime only when shift has expected hours */
export function computeOvertimeHours(netWorkedHours: number, expectedHours: number): number {
  if (expectedHours <= 0 || netWorkedHours <= expectedHours) return 0;
  return finalizeOvertimeHours(netWorkedHours - expectedHours);
}

/**
 * Manual OT days for punch-report summary «الإضافي»:
 * (net worked − shift duration) / hoursPerDay. Default 9h = 1 day.
 */
export const MANUAL_OT_HOURS_PER_DAY = 9;

export function computeManualOtDays(
  netWorkedHours: number,
  expectedHours: number,
  hoursPerDay: number = MANUAL_OT_HOURS_PER_DAY,
): number {
  if (hoursPerDay <= 0 || expectedHours <= 0 || netWorkedHours <= expectedHours) return 0;
  const excess = netWorkedHours - expectedHours;
  if (excess < MIN_OVERTIME_HOURS) return 0;
  return Math.round((excess / hoursPerDay) * 100) / 100;
}

/** Odoo biotime.shift.get_work_date — punch times are wall-clock stored as UTC. */
export function getWorkDateForPunch(shift: Shift, punchTime: Date): Date {
  const punchDate = utcDateOnly(punchTime);
  const punchHour = wallClockHour(punchTime);
  const start = shiftStartFloat(shift);
  const earlyThreshold = shift.earlyCheckinThreshold ?? 2;

  if (!shift.isOvernight) return punchDate;

  if (shift.workDateReference === 'start') {
    if (isWithinOvernightCheckoutWindow(punchHour, shift)) {
      return new Date(punchDate.getTime() - 86400000);
    }
    if (punchHour >= start - earlyThreshold) return punchDate;
    return new Date(punchDate.getTime() - 86400000);
  }

  if (isWithinOvernightCheckoutWindow(punchHour, shift)) return punchDate;
  if (punchHour >= start - earlyThreshold) {
    return new Date(punchDate.getTime() + 86400000);
  }
  return punchDate;
}

/** Odoo biotime.shift.get_expected_times_for_date — times on a UTC calendar day. */
export function getExpectedTimesForDate(shift: Shift, workDate: Date): { checkIn: Date; checkOut: Date } {
  const day = utcDateOnly(workDate);
  const start = shiftStartFloat(shift);
  const end = shiftEndFloat(shift);
  const startHour = Math.floor(start);
  const startMin = Math.round((start - startHour) * 60);
  const endHour = Math.floor(end);
  const endMin = Math.round((end - endHour) * 60);

  let checkInDate: Date;
  let checkOutDate: Date;

  if (shift.workDateReference === 'start') {
    checkInDate = new Date(day);
    checkOutDate = shift.isOvernight
      ? new Date(day.getTime() + 86400000)
      : new Date(day);
  } else {
    checkInDate = shift.isOvernight
      ? new Date(day.getTime() - 86400000)
      : new Date(day);
    checkOutDate = new Date(day);
  }

  const checkIn = new Date(checkInDate);
  checkIn.setUTCHours(startHour, startMin, 0, 0);
  const checkOut = new Date(checkOutDate);
  checkOut.setUTCHours(endHour, endMin, 0, 0);
  return { checkIn, checkOut };
}

export function parseRestDays(restDays: string | null | undefined): Set<number> {
  const set = new Set<number>();
  if (!restDays?.trim()) return set;
  for (const part of restDays.split(/[,;\s]+/)) {
    const n = parseInt(part.trim(), 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 6) set.add(n);
  }
  return set;
}

export function isRestDay(shift: Shift | null, workDate: Date): boolean {
  if (!shift?.restDays) return false;
  return parseRestDays(shift.restDays).has(jsToOdooWeekday(workDate));
}

const PUNCH_REPORT_MIN_CHECK_IN_GRACE = 20;

function netLateMinutes(lateDeltaMinutes: number, shift: Shift | null): number {
  const grace = Math.max(PUNCH_REPORT_MIN_CHECK_IN_GRACE, shift?.gracePeriodIn ?? PUNCH_REPORT_MIN_CHECK_IN_GRACE);
  return lateDeltaMinutes <= grace ? 0 : Math.round(lateDeltaMinutes);
}

/** Odoo punch report + attendance: late/early grace, overtime guard */
export function computeAttendanceMetrics(
  shift: Shift | null,
  firstCheckIn: Date | null,
  lastCheckOut: Date | null,
  options?: { ignoreLate?: boolean },
): {
  workedHours: number;
  netWorkedHours: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeHours: number;
  expectedHours: number;
} {
  const expectedHours = shift ? shiftExpectedHours(shift) : 0;

  if (!firstCheckIn || !lastCheckOut) {
    return {
      workedHours: 0,
      netWorkedHours: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeHours: 0,
      expectedHours,
    };
  }

  const workedHours = roundHours((lastCheckOut.getTime() - firstCheckIn.getTime()) / 3600000);
  const breakDuration = shift?.breakDuration ?? 0;
  const netWorkedHours = roundHours(Math.max(0, workedHours - breakDuration));

  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;

  if (shift) {
    const workDate = utcDateOnly(firstCheckIn);
    const { checkIn, checkOut } = getExpectedTimesForDate(shift, workDate);

    if (!options?.ignoreLate && firstCheckIn > checkIn) {
      const lateDelta = (firstCheckIn.getTime() - checkIn.getTime()) / 60000;
      lateMinutes = netLateMinutes(lateDelta, shift);
    }
    if (lastCheckOut < checkOut) {
      const earlyDelta = (checkOut.getTime() - lastCheckOut.getTime()) / 60000;
      if (earlyDelta > (shift.gracePeriodOut ?? 0)) {
        earlyLeaveMinutes = Math.round(earlyDelta);
      }
    }
  }

  const overtimeHours = computeOvertimeHours(netWorkedHours, expectedHours);

  return {
    workedHours,
    netWorkedHours,
    lateMinutes,
    earlyLeaveMinutes,
    overtimeHours,
    expectedHours,
  };
}

export function calculateAttendanceStatus(
  firstCheckIn: Date | null,
  lateMinutes: number,
  earlyLeaveMinutes: number,
  gridStatus?: string,
): string {
  if (gridStatus && ['leave', 'sick', 'off', 'excluded', 'rest_day'].includes(gridStatus)) {
    return gridStatus;
  }
  if (!firstCheckIn) return 'absent';
  const isLate = lateMinutes > 0;
  const isEarly = earlyLeaveMinutes > 0;
  if (isLate && isEarly) return 'late_early';
  if (isLate) return 'late';
  if (isEarly) return 'early_leave';
  return 'present';
}
