/**
 * Port of Odoo biotime.punch.report.wizard._create_report_lines
 * Builds punch report lines for Excel export (تقرير البصمات).
 */
import type { EmployeeProfile, EmployeeMapping, Shift, ShiftGridLine, Transaction } from '@prisma/client';
import { prisma } from '../prisma/client';
import { getEmployeeShiftForDate } from './shiftGridAssignment.service';
import { earnedLeaveFromBaseDays } from './punchReport.service';
import {
  computeOvertimeHours,
  computeManualOtDays,
  roundHours,
  shiftExpectedHours,
  resolveOvernightMorningAttribution,
  resolveLateCheckoutHours,
  resolveEarlyCheckinHours,
  DEFAULT_LATE_CHECKOUT_HOURS,
  DEFAULT_EARLY_CHECKIN_HOURS,
} from './shiftTime.service';
import { loadManualOtKeySet } from './shiftGridManualOt.service';
import { payrollMonthRange } from './shiftGridMerge.service';
import { wallClockHour } from '../utils/biotimeTimezone';
import {
  DEFAULT_LATE_POLICY,
  effectiveGraceMinutes,
  latePolicyFromConfig,
  lateDayFraction,
  splitForgivenLateDays,
  type LatePolicy,
} from './latePolicy.service';
import {
  calendarPeriodDays,
  resolvePayablePeriodDays,
  payablePeriodPolicyFromConfig,
  type PayablePeriodPolicy,
  DEFAULT_PAYABLE_PERIOD_POLICY,
} from './payablePeriod.service';

/** Odoo punch_state filters — biotime.punch.report.wizard phase 2 */
const CHECK_IN_STATES = new Set(['0', '2', '4']);
const CHECK_OUT_STATES = new Set(['1', '3', '5']);
const DEFAULT_SHIFT_THRESHOLD_HOURS = 2;

export type PunchReportExportLine = {
  id: number;
  employeeId: string | null;
  employeeCode: string;
  employeeName: string;
  jobTitle: string;
  punchDate: Date;
  deviceName: string;
  deviceSn: string;
  firstCheckIn: Date | null;
  lastCheckOut: Date | null;
  punchCount: number;
  checkInCount: number;
  checkOutCount: number;
  shiftId: string | null;
  shiftName: string;
  expectedCheckIn: Date | null;
  expectedCheckOut: Date | null;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  netWorkedHours: number;
  overtimeHours: number;
  isOffDay: boolean;
  isAbsent: boolean;
  isAnnualLeave: boolean;
  isBusDelay: boolean;
  basicSalary: number;
};

type EmpRow = EmployeeProfile & { mapping?: EmployeeMapping | null };
type ShiftInfo = {
  shift: Shift | null;
  isOff: boolean;
  isSick: boolean;
  isAnnual: boolean;
  isExcluded: boolean;
  isBusDelay: boolean;
  isPresent: boolean;
};

type TxRow = Transaction & { employee?: EmpRow | null };

let lineIdSeq = 1_000_000;

function nextLineId(): number {
  return lineIdSeq++;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDay(d: Date): Date {
  return new Date(`${dateKey(d)}T00:00:00.000Z`);
}

function timeStrToHours(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) + (m ?? 0) / 60;
}

function getExpectedTimesForDate(shift: Shift, workDate: Date): [Date, Date] {
  const startH = timeStrToHours(shift.startTime);
  const endH = timeStrToHours(shift.endTime);
  const startHour = Math.floor(startH);
  const startMin = Math.round((startH - startHour) * 60);
  const endHour = Math.floor(endH);
  const endMin = Math.round((endH - endHour) * 60);

  const checkInDate = new Date(workDate);
  const checkOutDate = shift.isOvernight ? new Date(workDate.getTime() + 86400000) : new Date(workDate);

  const expectedIn = new Date(checkInDate);
  expectedIn.setUTCHours(startHour, startMin, 0, 0);
  const expectedOut = new Date(checkOutDate);
  expectedOut.setUTCHours(endHour, endMin, 0, 0);
  return [expectedIn, expectedOut];
}

/**
 * Zero inside the grace window, otherwise the full delta (not delta minus
 * grace). Which grace applies when the shift sets its own is configured.
 */
function computeNetLateMinutes(
  lateDeltaMinutes: number,
  shift: Shift | null,
  policy: LatePolicy,
): number {
  const grace = effectiveGraceMinutes(policy, shift?.gracePeriodIn);
  return lateDeltaMinutes <= grace ? 0 : lateDeltaMinutes;
}

function shiftTotalHours(shift: Shift): number {
  return shiftExpectedHours(shift);
}

function nearestTo(punches: Date[], target: Date): Date {
  return punches.reduce((best, cur) =>
    Math.abs(cur.getTime() - target.getTime()) < Math.abs(best.getTime() - target.getTime())
      ? cur
      : best,
  );
}

/**
 * Picks the day's check-in and check-out out of its punches.
 *
 * Taking the earliest punch as check-in and the latest as check-out lies twice:
 * a punch left over from a previous shift (07:15 against a 16:00 → 01:00 shift)
 * became a check-in and invented nine hours of early leave, and one event
 * punched twice (01:00 and 01:15 against a 01:00 checkout) became a fifteen
 * minute working day. So punches before the shift's early-check-in window are
 * dropped, and punches that all sit on the same side of the shift are one event
 * — the day then reads as a single punch and the missing-punch rule can see it.
 *
 * When both sides are represented the earliest check-in and latest check-out
 * still win, so genuine overtime and early leaves keep their real times.
 */
export function resolveDayPunches(
  punchTimes: Date[],
  expectedCheckIn: Date,
  expectedCheckOut: Date,
  earlyCheckinHours = DEFAULT_EARLY_CHECKIN_HOURS,
): { checkIn: Date | null; checkOut: Date | null } {
  if (!punchTimes.length) return { checkIn: null, checkOut: null };

  const earliestAllowed = expectedCheckIn.getTime() - Math.max(0, earlyCheckinHours) * 3600000;
  // A day whose every punch predates the window still has to read as a punched
  // day, not an absence.
  const inWindow = punchTimes.filter((p) => p.getTime() >= earliestAllowed);
  const usable = inWindow.length ? inWindow : punchTimes;

  const inSide: Date[] = [];
  const outSide: Date[] = [];
  for (const punch of usable) {
    const distIn = Math.abs(punch.getTime() - expectedCheckIn.getTime());
    const distOut = Math.abs(punch.getTime() - expectedCheckOut.getTime());
    // Strict < so a punch exactly midway (early leave at the shift midpoint)
    // lands on checkout rather than inventing a second check-in.
    if (distIn < distOut) inSide.push(punch);
    else outSide.push(punch);
  }

  if (inSide.length && outSide.length) {
    return {
      checkIn: inSide.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b)),
      checkOut: outSide.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b)),
    };
  }
  if (inSide.length) return { checkIn: nearestTo(inSide, expectedCheckIn), checkOut: null };
  return { checkIn: null, checkOut: nearestTo(outSide, expectedCheckOut) };
}

function shiftThresholdHours(shift: Shift | null | undefined, kind: 'lateCheckout' | 'earlyCheckin'): number {
  if (!shift) return DEFAULT_SHIFT_THRESHOLD_HOURS;
  const raw = kind === 'lateCheckout' ? shift.lateCheckoutThreshold : shift.earlyCheckinThreshold;
  if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
  return DEFAULT_SHIFT_THRESHOLD_HOURS;
}

function employeeCode(emp: EmpRow): string {
  return (
    emp.mapping?.biotimeEmpCode?.trim() ||
    emp.code?.trim() ||
    emp.identificationId?.trim() ||
    emp.barcode?.trim() ||
    ''
  );
}

function isBeforeHireDate(workDate: Date, hireDate: Date | null | undefined): boolean {
  if (!hireDate) return false;
  return dateKey(workDate) < dateKey(hireDate);
}

function formatTimeAmPm(d: Date | null): string {
  if (!d) return '';
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`;
}

function formatTimeShortAmPm(d: Date | null): string {
  if (!d) return '';
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

export { formatTimeAmPm, formatTimeShortAmPm };

export function getSummaryPeriodDays(dateFrom: Date, dateTo: Date): number {
  return calendarPeriodDays(dateFrom, dateTo);
}

/** Payable base days for summaries (respects fixed 30-day setting when enabled). */
export function getPayableSummaryPeriodDays(
  dateFrom: Date,
  dateTo: Date,
  policy: PayablePeriodPolicy = DEFAULT_PAYABLE_PERIOD_POLICY,
): number {
  return resolvePayablePeriodDays(dateFrom, dateTo, policy);
}

const BEFORE_HIRE_SHIFT = 'قبل التعيين';

export function isBeforeHireMarkedDay(line: Pick<PunchReportExportLine, 'shiftName'>): boolean {
  return (line.shiftName ?? '').trim() === BEFORE_HIRE_SHIFT;
}

/**
 * First N unpaid absences (by date) are forgiven for «غياب بدون إذن» penalty only.
 * They still reduce أيام العمل الفعلية via absentNoPunch.
 */
export function splitForgivenAbsences<T extends { punchDate: Date; isAbsent: boolean }>(
  lines: T[],
  forgivenCount: number,
): { forgiven: T[]; charged: T[] } {
  const absents = lines
    .filter((l) => l.isAbsent)
    .slice()
    .sort((a, b) => a.punchDate.getTime() - b.punchDate.getTime());
  const n = Math.max(0, Math.floor(forgivenCount));
  return { forgiven: absents.slice(0, n), charged: absents.slice(n) };
}

export function weightedAbsentPenaltyDays(
  lines: Array<{ punchDate: Date; isAbsent: boolean; shiftId?: string | null; shiftName?: string }>,
  forgivenCount: number,
  requireShiftLabel = true,
): number {
  const candidates = requireShiftLabel
    ? lines.filter((l) => l.isAbsent && (l.shiftId || l.shiftName) && !isBeforeHireMarkedDay(l as PunchReportExportLine))
    : lines.filter((l) => l.isAbsent && !isBeforeHireMarkedDay(l as PunchReportExportLine));
  const { charged } = splitForgivenAbsences(candidates, forgivenCount);
  return charged.reduce((s, l) => {
    const wd = l.punchDate.getUTCDay();
    const odooWd = wd === 0 ? 6 : wd - 1;
    return s + (odooWd === 3 || odooWd === 4 || odooWd === 5 ? 2 : 1);
  }, 0);
}

/** Same payroll cycle as تقرير البصمات / المتابعة, capped at today. */
export function punchFollowUpPeriodDates(
  reference: Date,
  monthStartDay: number,
  today = reference,
): { dateFrom: Date; dateTo: Date } {
  const { dateFrom, dateTo } = payrollMonthRange(reference, monthStartDay);
  const todayDay = parseDay(today);
  return {
    dateFrom,
    dateTo: todayDay.getTime() < dateTo.getTime() ? todayDay : dateTo,
  };
}

export async function punchFollowUpPeriod(
  reference = new Date(),
): Promise<{ dateFrom: Date; dateTo: Date }> {
  const config = await prisma.bioTimeConfig.findFirst({
    select: { payrollMonthStartDay: true },
  });
  return punchFollowUpPeriodDates(
    reference,
    config?.payrollMonthStartDay ?? 26,
    new Date(),
  );
}

export function actualWorkingDaysByEmployeeFromPunchLines(
  lines: PunchReportExportLine[],
  periodDays: number,
): Map<string, number> {
  const byEmp = new Map<string, PunchReportExportLine[]>();
  for (const line of lines) {
    const key = line.employeeId || line.employeeCode;
    if (!key) continue;
    const arr = byEmp.get(key) ?? [];
    arr.push(line);
    byEmp.set(key, arr);
  }
  const out = new Map<string, number>();
  for (const [key, empLines] of byEmp) {
    out.set(key, computeSummaryWorkMetrics(empLines, periodDays).actualWorkingDays);
  }
  return out;
}

function toReportDay(value: Date | string): Date {
  if (typeof value === 'string') {
    return parseDay(new Date(`${value.slice(0, 10)}T00:00:00.000Z`));
  }
  return parseDay(value);
}

export async function punchFollowUpWorkingDaysByEmployeeIds(
  employeeIds: string[],
  options?: {
    dateFrom?: Date | string;
    dateTo?: Date | string;
    includeInactive?: boolean;
  },
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!employeeIds.length) return map;
  const fallback =
    options?.dateFrom && options?.dateTo
      ? null
      : await punchFollowUpPeriod();
  const period = {
    dateFrom: options?.dateFrom
      ? toReportDay(options.dateFrom)
      : fallback!.dateFrom,
    dateTo: options?.dateTo ? toReportDay(options.dateTo) : fallback!.dateTo,
  };
  const dateFrom =
    period.dateFrom.getTime() <= period.dateTo.getTime()
      ? period.dateFrom
      : period.dateTo;
  const dateTo =
    period.dateFrom.getTime() <= period.dateTo.getTime()
      ? period.dateTo
      : period.dateFrom;
  const lines = await generatePunchReportLines({
    dateFrom,
    dateTo,
    employeeIds,
    includeInactive: options?.includeInactive !== false,
  });
  const periodDays = getPayableSummaryPeriodDays(
    dateFrom,
    dateTo,
    payablePeriodPolicyFromConfig(
      await prisma.bioTimeConfig.findFirst({
        select: {
          payrollFixedMonthDaysEnabled: true,
          payrollFixedMonthDays: true,
          absentForgivenDaysCount: true,
        },
      }),
    ),
  );
  const computed = actualWorkingDaysByEmployeeFromPunchLines(lines, periodDays);
  for (const id of employeeIds) {
    map.set(id, computed.get(id) ?? 0);
  }
  return map;
}

/**
 * Tips: count days with a fingerprint or «حاضر» within the selected range only —
 * not payroll «أيام العمل الفعلية» (no fixed 30-day month, no earned-leave top-up).
 */
export function tipsWorkingDaysFromPunchLines(lines: PunchReportExportLine[]): number {
  return lines.filter((l) => {
    if (isBeforeHireMarkedDay(l)) return false;
    const name = (l.shiftName ?? '').trim();
    if (name === 'استقالة') return false;
    if (isPresentMarkedDay(l)) return true;
    return (l.punchCount ?? 0) > 0;
  }).length;
}

export function tipsWorkingDaysByEmployeeFromPunchLines(
  lines: PunchReportExportLine[],
): Map<string, number> {
  const byEmp = new Map<string, PunchReportExportLine[]>();
  for (const line of lines) {
    const key = line.employeeId || line.employeeCode;
    if (!key) continue;
    const arr = byEmp.get(key) ?? [];
    arr.push(line);
    byEmp.set(key, arr);
  }
  const out = new Map<string, number>();
  for (const [key, empLines] of byEmp) {
    out.set(key, tipsWorkingDaysFromPunchLines(empLines));
  }
  return out;
}

export async function tipsWorkingDaysByEmployeeIds(
  employeeIds: string[],
  options: {
    dateFrom: Date | string;
    dateTo: Date | string;
    includeInactive?: boolean;
  },
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!employeeIds.length) return map;
  const period = {
    dateFrom: toReportDay(options.dateFrom),
    dateTo: toReportDay(options.dateTo),
  };
  const dateFrom =
    period.dateFrom.getTime() <= period.dateTo.getTime()
      ? period.dateFrom
      : period.dateTo;
  const dateTo =
    period.dateFrom.getTime() <= period.dateTo.getTime()
      ? period.dateTo
      : period.dateFrom;
  const lines = await generatePunchReportLines({
    dateFrom,
    dateTo,
    employeeIds,
    includeInactive: options.includeInactive !== false,
  });
  const computed = tipsWorkingDaysByEmployeeFromPunchLines(lines);
  for (const id of employeeIds) {
    map.set(id, computed.get(id) ?? 0);
  }
  return map;
}

/** Grid «حاضر» / «حاضر - …» — counts as a worked day even with no fingerprint. */
export function isPresentMarkedDay(line: Pick<PunchReportExportLine, 'shiftName'>): boolean {
  const name = (line.shiftName ?? '').trim();
  return name === 'حاضر' || name.startsWith('حاضر');
}

export function isAnnualLeaveDay(
  line: Pick<PunchReportExportLine, 'isAnnualLeave' | 'shiftName'>,
): boolean {
  return line.isAnnualLeave === true || (line.shiftName ?? '').trim() === 'إجازة سنوية';
}

export function isRegularLeaveDay(
  line: Pick<PunchReportExportLine, 'isOffDay' | 'shiftName'> & { punchCount?: number },
): boolean {
  // A leave cell that still has fingerprints is worked time, not unpaid leave.
  if ((line.punchCount ?? 0) > 0) return false;
  return line.isOffDay === true && (line.shiftName ?? '').trim() === 'إجازة';
}

/** Regular «إجازة» after the first four days (chronological). */
export function excessRegularLeaveLines<
  T extends { punchDate: Date; isOffDay?: boolean; shiftName?: string; id?: number },
>(lines: T[], allowedDays = 4): T[] {
  const regularLeave = lines
    .filter((l) => isRegularLeaveDay(l as Pick<PunchReportExportLine, 'isOffDay' | 'shiftName'>))
    .slice()
    .sort((a, b) => a.punchDate.getTime() - b.punchDate.getTime());
  return regularLeave.slice(Math.max(0, Math.floor(allowedDays)));
}

/**
 * Regular «إجازة» days past the entitlement. Not absence — HR asked for it as a
 * plain unweighted day count that only the payslip deducts.
 */
export function excessRegularLeaveDays(
  lines: Array<{ punchDate: Date; isOffDay?: boolean; shiftName?: string }>,
  allowedDays = 4,
): number {
  return excessRegularLeaveLines(lines, allowedDays).length;
}

/** Grid labels that are outside employment: no work, no pay, no entitlement. */
const OUT_OF_SERVICE_SHIFT_NAMES = new Set([BEFORE_HIRE_SHIFT, 'استقالة']);

/**
 * Period days that earn nothing: regular «إجازة», غياب, and days outside
 * employment. Paid markers win over a stale `isAbsent` flag, so a grid cell HR
 * set to «حاضر» is never charged as an absence.
 */
function countNonWorkDays(lines: PunchReportExportLine[]): number {
  return lines.filter((l) => {
    const name = (l.shiftName ?? '').trim();
    if (isPresentMarkedDay(l) || isAnnualLeaveDay(l) || name === 'إجازة مرضية') return false;
    return isRegularLeaveDay(l) || l.isAbsent || OUT_OF_SERVICE_SHIFT_NAMES.has(name);
  }).length;
}

/** Count earning days from daily rows (handles 31 calendar rows vs 30-day fixed period). */
function countWorkingDays(lines: PunchReportExportLine[], periodDays: number): number {
  if (!lines.length) return 0;
  const payable = Math.max(0, periodDays);
  const nonWork = countNonWorkDays(lines);
  if (lines.length >= payable) {
    return Math.min(payable, Math.max(0, lines.length - nonWork));
  }
  return Math.max(0, payable - nonWork);
}

function calendarSpanFromLines(lines: PunchReportExportLine[]): number {
  if (!lines.length) return 0;
  const dates = lines.map((l) => l.punchDate).sort((a, b) => a.getTime() - b.getTime());
  return calendarPeriodDays(dates[0]!, dates[dates.length - 1]!);
}

/** Fixed 30-day month with 31 calendar rows (26→25) → deduct one actual day. */
function actualDaysCalendarAdjustment(lines: PunchReportExportLine[], payable: number): number {
  if (!lines.length || payable <= 0) return 0;
  const span = calendarSpanFromLines(lines);
  return Math.max(lines.length, span) > payable ? 1 : 0;
}

/**
 * Work days are the payable month minus the days that earn nothing.
 * «أيام العمل الفعلية» = عدد أيام العمل + الإجازة المستحقة (مثلاً 24 + 4 = 28).
 * When the calendar spans 31 days but payable month is 30, deduct one day.
 */
export function computeSummaryWorkMetrics(
  lines: PunchReportExportLine[],
  periodDays: number,
): { workingDays: number; earnedLeaveCapped: number; actualWorkingDays: number } {
  const payable = Math.max(0, periodDays);
  const workingDays = countWorkingDays(lines, payable);
  const earnedLeaveCapped = Math.min(earnedLeaveFromBaseDays(workingDays), 4);
  const calendarAdj = actualDaysCalendarAdjustment(lines, payable);
  const actualWorkingDays =
    lines.length > 0
      ? Math.max(0, Math.min(payable, workingDays + earnedLeaveCapped - calendarAdj))
      : 0;
  return { workingDays, earnedLeaveCapped, actualWorkingDays };
}

/** Ids of the late days the allowance excuses, so the export can grey them out. */
export function getIgnoredLateLineIds(
  lines: PunchReportExportLine[],
  policy: LatePolicy = DEFAULT_LATE_POLICY,
): Set<number> {
  const { forgiven } = splitForgivenLateDays(
    lines.filter((l) => l.punchDate),
    policy,
  );
  return new Set(forgiven.map((l) => l.id));
}

export type EmployeeSummaryRow = {
  workingDays: number;
  earnedLeaveCapped: number;
  actualWorkingDays: number;
  singlePunch: number;
  punchDeduction: number;
  absentCount: number;
  /** Regular leave past the entitlement — deducted on the payslip only. */
  excessLeaveDays: number;
  adminPenalty: number;
  overtime: number;
  lateDeduction: number;
  earlyDeduction: number;
  sickDayCount: number;
  sickDeduction: number;
  /** Odoo punch_report_xlsx: E+F+G+I+J+L on the summary row */
  totalPenalties: number;
};

export function computeEmployeeSummary(
  lines: PunchReportExportLine[],
  periodDays: number,
  penaltyAmount = 0,
  policy: LatePolicy = DEFAULT_LATE_POLICY,
  absentForgivenDaysCount = DEFAULT_PAYABLE_PERIOD_POLICY.absentForgivenDaysCount,
): EmployeeSummaryRow {
  const ignored = getIgnoredLateLineIds(lines, policy);
  const metrics = computeSummaryWorkMetrics(lines, periodDays);

  const singlePunch = lines.filter(
    (l) => l.punchCount === 1 && !l.isOffDay && !l.isAbsent && !isBeforeHireMarkedDay(l),
  ).length;

  const missingOut = lines.filter(
    (l) =>
      !l.isOffDay &&
      !l.isAbsent &&
      !isBeforeHireMarkedDay(l) &&
      l.punchCount === 1 &&
      l.checkInCount > 0 &&
      l.checkOutCount === 0,
  );
  const missingIn = lines.filter(
    (l) =>
      !l.isOffDay &&
      !l.isAbsent &&
      !isBeforeHireMarkedDay(l) &&
      l.punchCount === 1 &&
      l.checkOutCount > 0 &&
      l.checkInCount === 0,
  );
  const punchDeduction = Math.max(0, missingOut.length - 1) * 0.25 + Math.max(0, missingIn.length - 1) * 0.5;

  // Excess leave is deliberately absent from this figure: HR reads «غياب بدون
  // إذن» as days the employee never showed up for.
  const absentCount = weightedAbsentPenaltyDays(lines, absentForgivenDaysCount, true);

  const totalEarly = lines
    .filter((l) => l.netWorkedHours < 9)
    .reduce((s, l) => s + l.earlyLeaveMinutes, 0);
  const earlyDeduction = Math.round((totalEarly / 60 / 9) * 100) / 100;

  const sickDayCount = lines.filter((l) => l.isOffDay && l.shiftName === 'إجازة مرضية').length;
  const sickDeduction = Math.round(sickDayCount * 0.25 * 100) / 100;

  const lateEffective = lines.filter(
    (l) => !l.isOffDay && !l.isAbsent && l.lateMinutes > 0 && !ignored.has(l.id),
  );
  const lateDeduction = Math.round(
    lateEffective.reduce((s, l) => s + lateDayFraction(l.lateMinutes, policy), 0) * 100,
  ) / 100;

  const totalOt =
    lines.filter((l) => !l.isOffDay).reduce((s, l) => s + l.overtimeHours, 0) +
    lines.filter((l) => l.isOffDay && l.punchCount > 0).reduce((s, l) => s + l.overtimeHours, 0);
  const overtime = totalOt > 0 ? Math.round(totalOt * 100) / 100 : 0;

  const totalPenalties =
    Math.round(
      ((Math.round(punchDeduction * 100) / 100) +
        absentCount +
        penaltyAmount +
        lateDeduction +
        earlyDeduction +
        sickDeduction) *
        100,
    ) / 100;

  return {
    workingDays: metrics.workingDays,
    earnedLeaveCapped: metrics.earnedLeaveCapped,
    actualWorkingDays: metrics.actualWorkingDays,
    singlePunch,
    punchDeduction: Math.round(punchDeduction * 100) / 100,
    absentCount,
    excessLeaveDays: excessRegularLeaveDays(lines, 4),
    adminPenalty: penaltyAmount,
    overtime,
    lateDeduction,
    earlyDeduction,
    sickDayCount,
    sickDeduction,
    totalPenalties,
  };
}

export type GeneratePunchReportLinesOptions = {
  dateFrom: Date;
  dateTo: Date;
  employeeIds?: string[];
  /**
   * BioTime emp_code values to include even when no Hudoori EmployeeProfile exists.
   * Used by «كل أكواد BioTime» on the employees punch report.
   */
  empCodes?: string[];
  shiftGridId?: string;
  deviceIds?: string[];
  deviceSns?: string[];
  /** Include archived/inactive employees (payroll needs their punches through the archive date). */
  includeInactive?: boolean;
};

function gridLineToShiftInfo(gl: (ShiftGridLine & { shift?: Shift | null }) | null): ShiftInfo {
  if (!gl) return { shift: null, isOff: false, isSick: false, isAnnual: false, isExcluded: false, isBusDelay: false, isPresent: false };
  if (gl.isExcluded) return { shift: null, isOff: false, isSick: false, isAnnual: false, isExcluded: true, isBusDelay: false, isPresent: false };
  if (gl.isSick) return { shift: null, isOff: true, isSick: true, isAnnual: false, isExcluded: false, isBusDelay: false, isPresent: false };
  if (gl.isAnnualLeave) return { shift: null, isOff: false, isSick: false, isAnnual: true, isExcluded: false, isBusDelay: false, isPresent: false };
  if (gl.isOff) return { shift: null, isOff: true, isSick: false, isAnnual: false, isExcluded: false, isBusDelay: false, isPresent: false };
  if (gl.isMarriageLeave) return { shift: null, isOff: false, isSick: false, isAnnual: false, isExcluded: false, isBusDelay: false, isPresent: true };
  if (gl.isPresent && !gl.shift) return { shift: null, isOff: false, isSick: false, isAnnual: false, isExcluded: false, isBusDelay: gl.isBusDelay, isPresent: true };
  if (gl.shift) {
    return {
      shift: gl.shift,
      isOff: false,
      isSick: false,
      isAnnual: false,
      isExcluded: false,
      isBusDelay: gl.isBusDelay,
      isPresent: gl.isPresent,
    };
  }
  return { shift: null, isOff: false, isSick: false, isAnnual: false, isExcluded: false, isBusDelay: gl.isBusDelay, isPresent: gl.isPresent };
}

export async function generatePunchReportLines(
  options: GeneratePunchReportLinesOptions,
): Promise<PunchReportExportLine[]> {
  const dateFrom = parseDay(options.dateFrom);
  const dateTo = parseDay(options.dateTo);
  // Overnight OUT after midnight belongs to the previous shift day. Load that day's
  // grid/assignment context even when the report range starts mid-week (tips /
  // employee punch summary often start on the 11th, not the grid's dateFrom).
  const shiftContextFrom = new Date(dateFrom.getTime() - 86400000);
  const fetchEnd = new Date(dateTo.getTime() + 86400000);
  fetchEnd.setUTCHours(23, 59, 59, 999);

  const config = await prisma.bioTimeConfig.findFirst();
  const latePolicy = latePolicyFromConfig(config);
  const companyLateCheckoutHours =
    config?.defaultLateCheckoutHours != null && Number.isFinite(Number(config.defaultLateCheckoutHours))
      ? Number(config.defaultLateCheckoutHours)
      : DEFAULT_LATE_CHECKOUT_HOURS;
  const companyEarlyCheckinHours =
    config?.defaultEarlyCheckinHours != null && Number.isFinite(Number(config.defaultEarlyCheckinHours))
      ? Number(config.defaultEarlyCheckinHours)
      : DEFAULT_EARLY_CHECKIN_HOURS;

  const requestedCodes = [
    ...new Set(
      (options.empCodes ?? [])
        .map((c) => String(c ?? '').trim())
        .filter(Boolean),
    ),
  ];

  const empWhere: Record<string, unknown> = options.employeeIds?.length
    ? {
        id: { in: options.employeeIds },
        ...(options.includeInactive ? {} : { active: true }),
      }
    : requestedCodes.length
      ? {
          OR: [
            { code: { in: requestedCodes } },
            { identificationId: { in: requestedCodes } },
            { barcode: { in: requestedCodes } },
            { mapping: { biotimeEmpCode: { in: requestedCodes } } },
          ],
          ...(options.includeInactive ? {} : { active: true }),
        }
      : options.includeInactive
        ? {}
        : { active: true };

  const employees = await prisma.employeeProfile.findMany({
    where: empWhere,
    include: { mapping: true },
  });

  const empById = new Map(employees.map((e) => [e.id, e]));
  const codeToEmp = new Map<string, EmpRow>();
  for (const e of employees) {
    const c = employeeCode(e);
    if (c) codeToEmp.set(c, e);
  }

  const codes = [
    ...new Set([...codeToEmp.keys(), ...requestedCodes]),
  ];
  if (!codes.length && !employees.length) return [];

  const empIds = employees.map((e) => e.id);
  // Prefer BioTime mapping hireDate; fall back to employee profile hiringDate.
  const hireDateByEmpId = new Map(
    employees.map((e) => [e.id, e.mapping?.hireDate ?? e.hiringDate ?? null]),
  );

  let deviceSns: string[] | undefined;
  if (options.deviceSns?.length) {
    deviceSns = options.deviceSns;
  } else if (options.deviceIds?.length) {
    const devices = await prisma.device.findMany({ where: { id: { in: options.deviceIds } } });
    deviceSns = devices.map((d) => d.serialNumber).filter(Boolean) as string[];
  }

  const punchTimeFilter = { gte: dateFrom, lte: fetchEnd };
  const txWhere: Record<string, unknown> = codes.length
    ? { punchTime: punchTimeFilter, empCode: { in: codes }, isDuplicate: false }
    : { punchTime: punchTimeFilter, employeeId: { in: empIds }, isDuplicate: false };
  if (deviceSns?.length) txWhere.terminalSn = { in: deviceSns };

  const transactions = await prisma.transaction.findMany({
    where: txWhere,
    orderBy: [{ empCode: 'asc' }, { punchTime: 'asc' }],
    include: { employee: { include: { mapping: true } } },
  });

  const assignments = empIds.length
    ? await prisma.shiftAssignment.findMany({
        where: { employeeId: { in: empIds }, active: true },
      })
    : [];
  const shifts = await prisma.shift.findMany();
  const shiftsById = new Map(shifts.map((s) => [s.id, s]));
  const assignmentsByEmp = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const list = assignmentsByEmp.get(a.employeeId) ?? [];
    list.push(a);
    assignmentsByEmp.set(a.employeeId, list);
  }

  const gridLineWhere: Record<string, unknown> = {
    employeeId: { in: empIds },
    date: { gte: shiftContextFrom, lte: dateTo },
  };
  if (options.shiftGridId) gridLineWhere.gridId = options.shiftGridId;

  const gridLines = empIds.length
    ? await prisma.shiftGridLine.findMany({
        where: gridLineWhere,
        include: { shift: true },
        orderBy: { id: 'desc' },
      })
    : [];
  const gridByEmpDate = new Map<string, ShiftGridLine & { shift?: Shift | null }>();
  const gridLinePriority = (gl: ShiftGridLine & { shift?: Shift | null }): number => {
    let p = 0;
    if (gl.shiftId || gl.shift) p += 20;
    if (gl.shift?.isOvernight) p += 5;
    if (gl.isOff || gl.isSick || gl.isAnnualLeave || gl.isExcluded || gl.isPresent || gl.isResignation) {
      p += 10;
    }
    return p;
  };
  for (const gl of gridLines) {
    const k = `${gl.employeeId}:${dateKey(gl.date)}`;
    const existing = gridByEmpDate.get(k);
    if (!existing || gridLinePriority(gl) > gridLinePriority(existing)) {
      gridByEmpDate.set(k, gl);
    }
  }

  const shiftCache = new Map<string, ShiftInfo>();
  const gridScoped = Boolean(options.shiftGridId);
  // Grid punch reports: OT only for manually listed emp+day pairs (days = excess/9).
  // Empty list ⇒ all OT zero. Non-grid reports keep automatic hour OT.
  const manualOtKeys = options.shiftGridId
    ? await loadManualOtKeySet(options.shiftGridId)
    : null;

  function resolveReportOt(
    employeeId: string | null | undefined,
    workDate: Date,
    net: number,
    shiftH: number,
  ): number {
    if (!gridScoped) return computeOvertimeHours(net, shiftH);
    if (!employeeId) return 0;
    if (!manualOtKeys!.has(`${employeeId}:${dateKey(workDate)}`)) return 0;
    return computeManualOtDays(net, shiftH);
  }

  function getCachedShift(employeeId: string, d: Date, _deviceSn = ''): ShiftInfo {
    const k = `${employeeId}:${dateKey(d)}`;
    if (shiftCache.has(k)) return shiftCache.get(k)!;

    const gl = gridByEmpDate.get(k) ?? null;
    let info: ShiftInfo;
    if (gl) {
      if (gl.isPresent && !gl.shiftId) {
        const { shift, isOff } = getEmployeeShiftForDate(
          assignmentsByEmp.get(employeeId) ?? [],
          d,
          shiftsById,
        );
        info = { shift, isOff, isSick: false, isAnnual: false, isExcluded: false, isBusDelay: gl.isBusDelay, isPresent: true };
      } else {
        info = gridLineToShiftInfo(gl);
      }
    } else if (gridScoped) {
      info = { shift: null, isOff: false, isSick: false, isAnnual: false, isExcluded: false, isBusDelay: false, isPresent: false };
    } else {
      const { shift, isOff } = getEmployeeShiftForDate(
        assignmentsByEmp.get(employeeId) ?? [],
        d,
        shiftsById,
      );
      info = { shift, isOff, isSick: false, isAnnual: false, isExcluded: false, isBusDelay: false, isPresent: false };
    }
    shiftCache.set(k, info);
    return info;
  }

  const empDatePunches = new Map<string, TxRow[]>();
  const empDateShiftInfo = new Map<string, ShiftInfo>();
  const empLastDevice = new Map<string, [string, string]>();

  for (const trans of transactions) {
    const empCode = (trans.empCode ?? '').trim() || (trans.employee ? employeeCode(trans.employee) : '');
    if (!empCode) continue;

    const emp = trans.employee ?? codeToEmp.get(empCode) ?? null;
    // punch_time is stored as device wall-clock (the digits, tagged UTC), so read it
    // directly with offset 0. Feeding it through a timezone conversion would double-shift.
    const adjTime = trans.punchTime;
    const calendarDate = parseDay(adjTime);
    let workDate = calendarDate;
    let shiftInfo: ShiftInfo = { shift: null, isOff: false, isSick: false, isAnnual: false, isExcluded: false, isBusDelay: false, isPresent: false };

    if (emp) {
      const adjHour = wallClockHour(adjTime);
      const termSn = trans.terminalSn ?? '';
      const prev = getCachedShift(emp.id, new Date(calendarDate.getTime() - 86400000), termSn);
      const today = getCachedShift(emp.id, calendarDate, termSn);

      const lateHours = resolveLateCheckoutHours(prev.shift, companyLateCheckoutHours);
      const earlyHours = resolveEarlyCheckinHours(today.shift, companyEarlyCheckinHours);
      const attribution = resolveOvernightMorningAttribution({
        punchHour: adjHour,
        prev,
        today,
        lateCheckoutHours: lateHours,
        earlyCheckinHours: earlyHours,
        isCheckIn: CHECK_IN_STATES.has(String(trans.punchState ?? '')),
      });

      if (attribution.handled) {
        if (attribution.usePreviousDay) {
          workDate = new Date(calendarDate.getTime() - 86400000);
          shiftInfo = prev;
        } else {
          workDate = calendarDate;
          shiftInfo = today;
        }
      } else {
        shiftInfo = getCachedShift(emp.id, calendarDate, termSn);
      }
    }

    const groupKey = `${empCode}:${dateKey(workDate)}`;
    const list = empDatePunches.get(groupKey) ?? [];
    list.push(trans);
    empDatePunches.set(groupKey, list);

    const devName = trans.terminalAlias || trans.terminalSn || '';
    if (devName) empLastDevice.set(empCode, [devName, trans.terminalSn ?? '']);

    if (!empDateShiftInfo.has(groupKey)) {
      const hasInfo =
        shiftInfo.shift ||
        shiftInfo.isOff ||
        shiftInfo.isSick ||
        shiftInfo.isAnnual ||
        shiftInfo.isExcluded ||
        shiftInfo.isBusDelay ||
        shiftInfo.isPresent;
      if (hasInfo) empDateShiftInfo.set(groupKey, shiftInfo);
    }
  }

  const lines: PunchReportExportLine[] = [];
  const existingKeys = new Set<string>();

  function makeLine(
    partial: Omit<PunchReportExportLine, 'id' | 'jobTitle' | 'basicSalary' | 'isBusDelay'> & {
      employeeId: string | null;
      isBusDelay?: boolean;
    },
  ): PunchReportExportLine {
    const emp = partial.employeeId ? empById.get(partial.employeeId) : null;
    return {
      ...partial,
      isBusDelay: partial.isBusDelay ?? false,
      id: nextLineId(),
      jobTitle: emp?.jobTitle?.trim() ?? '',
      basicSalary: emp?.basicSalary ?? 0,
    };
  }

  for (const [groupKey, punches] of empDatePunches) {
    const [empCode, workDateStr] = groupKey.split(':');
    const workDate = parseDay(new Date(`${workDateStr}T00:00:00.000Z`));
    if (workDate < dateFrom || workDate > dateTo) continue;

    punches.sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
    const wallPunches = punches.map((p) => ({
      tx: p,
      wall: p.punchTime, // already device wall-clock; no conversion (see adjTime above)
    }));
    const firstPunch = punches[0];
    const emp =
      firstPunch.employee ??
      codeToEmp.get(empCode) ??
      (firstPunch.employeeId ? empById.get(firstPunch.employeeId) : null) ??
      null;
    const employeeId = emp?.id ?? firstPunch.employeeId ?? null;
    const employeeName = emp?.name ?? empCode;
    const deviceName = firstPunch.terminalAlias || firstPunch.terminalSn || 'غير محدد';

    // Real BioTime punches always appear — even before hiringDate / firstWorkingDay.
    // Empty days before hire are still filled as «قبل التعيين» in phase 4.

    let firstCheckIn: Date | null = wallPunches[0]?.wall ?? null;
    let lastCheckOut: Date | null =
      wallPunches.length > 1 ? wallPunches[wallPunches.length - 1]?.wall ?? null : null;
    let punchCount = punches.length;
    let checkInCount = punches.filter((p) => CHECK_IN_STATES.has(String(p.punchState ?? ''))).length;
    let checkOutCount = punches.filter((p) => CHECK_OUT_STATES.has(String(p.punchState ?? ''))).length;

    let workedHours = 0;
    if (punchCount > 1 && firstCheckIn && lastCheckOut) {
      workedHours = (lastCheckOut.getTime() - firstCheckIn.getTime()) / 3600000;
    }

    let info = empDateShiftInfo.get(groupKey) ?? { shift: null, isOff: false, isSick: false, isAnnual: false, isExcluded: false, isBusDelay: false, isPresent: false };
    if (employeeId && !info.shift && !info.isOff && !info.isSick && !info.isAnnual && !info.isExcluded) {
      info = getCachedShift(employeeId, workDate, firstPunch.terminalSn ?? '');
    }

    if (info.isExcluded) {
      const dev = empLastDevice.get(empCode) ?? [deviceName, firstPunch.terminalSn ?? ''];
      lines.push(
        makeLine({
          employeeId,
          employeeCode: empCode,
          employeeName,
          punchDate: workDate,
          deviceName: dev[0],
          deviceSn: dev[1],
          firstCheckIn: null,
          lastCheckOut: null,
          punchCount: 0,
          checkInCount: 0,
          checkOutCount: 0,
          shiftId: null,
          shiftName: 'عدم احتساب يوم',
          expectedCheckIn: null,
          expectedCheckOut: null,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          netWorkedHours: 0,
          overtimeHours: 0,
          isOffDay: false,
          isAbsent: true,
          isAnnualLeave: false,
        }),
      );
      existingKeys.add(groupKey);
      continue;
    }

    let shiftName = '';
    let expectedCheckIn: Date | null = null;
    let expectedCheckOut: Date | null = null;
    let lateMinutes = 0;
    let earlyLeaveMinutes = 0;
    let netWorkedHours = 0;
    let overtimeHours = 0;
    const shift = info.shift;

    if (info.isSick) {
      shiftName = 'إجازة مرضية';
      if (punchCount > 0) netWorkedHours = workedHours;
    } else if (info.isAnnual) {
      shiftName = 'إجازة سنوية';
    } else if (info.isOff) {
      shiftName = 'إجازة';
      if (punchCount > 0) netWorkedHours = workedHours;
    } else if (shift) {
      shiftName = shift.name;
      [expectedCheckIn, expectedCheckOut] = getExpectedTimesForDate(shift, workDate);

      if (expectedCheckIn && expectedCheckOut && wallPunches.length) {
        const paired = resolveDayPunches(
          wallPunches.map((p) => p.wall),
          expectedCheckIn,
          expectedCheckOut,
          resolveEarlyCheckinHours(shift, companyEarlyCheckinHours),
        );
        firstCheckIn = paired.checkIn;
        lastCheckOut = paired.checkOut;
        checkInCount = firstCheckIn ? 1 : 0;
        checkOutCount = lastCheckOut ? 1 : 0;
        punchCount = checkInCount + checkOutCount;
        workedHours =
          firstCheckIn && lastCheckOut
            ? Math.max(0, (lastCheckOut.getTime() - firstCheckIn.getTime()) / 3600000)
            : 0;
      }

      if (firstCheckIn && expectedCheckIn && !info.isBusDelay) {
        const lateDelta = (firstCheckIn.getTime() - expectedCheckIn.getTime()) / 60000;
        lateMinutes = computeNetLateMinutes(lateDelta, shift, latePolicy);
      }
      if (lastCheckOut && expectedCheckOut) {
        const earlyDelta = (expectedCheckOut.getTime() - lastCheckOut.getTime()) / 60000;
        if (earlyDelta > (shift.gracePeriodOut ?? 0)) earlyLeaveMinutes = earlyDelta;
      }
      const breakDur = shift.breakDuration ?? 0;
      netWorkedHours = workedHours > 0 ? roundHours(Math.max(0, workedHours - breakDur)) : 0;
      const totalH = shiftTotalHours(shift);
      overtimeHours = resolveReportOt(employeeId, workDate, netWorkedHours, totalH);
    } else {
      netWorkedHours = workedHours;
    }

    if (info.isPresent) shiftName = shiftName ? `حاضر - ${shiftName}` : 'حاضر';

    const isOffDay = (info.isOff || info.isSick) && punchCount === 0;
    const isAbsent =
      punchCount === 0 &&
      !isOffDay &&
      !info.isAnnual &&
      !info.isPresent &&
      shiftName !== 'إجازة سنوية';

    lines.push(
      makeLine({
        employeeId,
        employeeCode: empCode,
        employeeName,
        punchDate: workDate,
        deviceName,
        deviceSn: firstPunch.terminalSn ?? '',
        firstCheckIn,
        lastCheckOut,
        punchCount,
        checkInCount,
        checkOutCount,
        shiftId: shift?.id ?? null,
        shiftName,
        expectedCheckIn,
        expectedCheckOut,
        lateMinutes,
        earlyLeaveMinutes,
        netWorkedHours,
        overtimeHours,
        isOffDay,
        isAbsent,
        isAnnualLeave: info.isAnnual,
        isBusDelay: info.isBusDelay,
      }),
    );
    existingKeys.add(groupKey);
  }

  const empCodesWithPunches = new Set<string>();
  for (const groupKey of empDatePunches.keys()) {
    empCodesWithPunches.add(groupKey.split(':')[0]!);
  }

  const empMap = new Map<string, { employeeId: string | null; employeeName: string }>();
  for (const e of employees) {
    const c = employeeCode(e);
    if (!c) continue;
    // Open-ended reports skip archived people with no punches (Odoo parity).
    // A shift-grid export keeps them: they are on the roster for payroll even
    // when every remaining day is إنهاء / استقالة with no fingerprint.
    if (!e.active && !empCodesWithPunches.has(c) && !gridScoped) continue;
    empMap.set(c, { employeeId: e.id, employeeName: e.name });
  }
  for (const empCode of empCodesWithPunches) {
    if (!empMap.has(empCode) && codeToEmp.has(empCode)) {
      const e = codeToEmp.get(empCode)!;
      empMap.set(empCode, { employeeId: e.id, employeeName: e.name });
    }
  }
  // Orphan BioTime codes (no Hudoori profile): still appear when punches exist,
  // and when explicitly requested for the full-server export.
  for (const empCode of requestedCodes) {
    if (empMap.has(empCode)) continue;
    if (codeToEmp.has(empCode)) {
      const e = codeToEmp.get(empCode)!;
      empMap.set(empCode, { employeeId: e.id, employeeName: e.name });
      continue;
    }
    if (empCodesWithPunches.has(empCode)) {
      empMap.set(empCode, { employeeId: null, employeeName: empCode });
    } else {
      // Requested but no punches in period — still list a zero-activity row set via phase 4 skip
      // (phase 4 needs employeeId). Emit nothing extra here; punch days already covered.
      empMap.set(empCode, { employeeId: null, employeeName: empCode });
    }
  }

  const empIdToCode = new Map<string, string>();
  for (const [code, v] of empMap) {
    if (v.employeeId) empIdToCode.set(v.employeeId, code);
  }

  for (const gl of gridLines) {
    const empCode = empIdToCode.get(gl.employeeId);
    if (!empCode) continue;
    const glDate = parseDay(gl.date);
    // Context-only day (dateFrom − 1) is for overnight attribution, not report rows.
    if (glDate < dateFrom || glDate > dateTo) continue;
    const k = `${empCode}:${dateKey(gl.date)}`;
    if (existingKeys.has(k)) continue;
    // Keep grid leave/off/excluded days even before hire so roster context shows.

    const pushGridLine = (shiftName: string, flags: Partial<PunchReportExportLine>) => {
      const meta = empMap.get(empCode)!;
      const dev = empLastDevice.get(empCode) ?? ['', ''];
      lines.push(
        makeLine({
          employeeId: meta.employeeId,
          employeeCode: empCode,
          employeeName: meta.employeeName,
          punchDate: parseDay(gl.date),
          deviceName: dev[0],
          deviceSn: dev[1],
          firstCheckIn: null,
          lastCheckOut: null,
          punchCount: 0,
          checkInCount: 0,
          checkOutCount: 0,
          shiftId: gl.shiftId,
          shiftName,
          expectedCheckIn: null,
          expectedCheckOut: null,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          netWorkedHours: 0,
          overtimeHours: 0,
          isOffDay: flags.isOffDay ?? false,
          isAbsent: flags.isAbsent ?? false,
          isAnnualLeave: flags.isAnnualLeave ?? false,
        }),
      );
      existingKeys.add(k);
    };

    if (gl.isOff && !gl.isSick && !gl.isAnnualLeave) {
      pushGridLine('إجازة', { isOffDay: true });
    } else if (gl.isSick) {
      pushGridLine('إجازة مرضية', { isOffDay: true });
    } else if (gl.isAnnualLeave) {
      pushGridLine('إجازة سنوية', { isAnnualLeave: true });
    } else if (gl.isExcluded) {
      pushGridLine('عدم احتساب يوم', { isAbsent: true });
    }
  }

  const allDates: Date[] = [];
  let d = new Date(dateFrom);
  while (d <= dateTo) {
    allDates.push(new Date(d));
    d = new Date(d.getTime() + 86400000);
  }

  // Phase 4 — Odoo: absent days, present-without-punch, expected shift times on absences
  const requestedCodeSet = new Set(requestedCodes);
  for (const [empCode, meta] of empMap) {
    const employeeId = meta.employeeId;
    if (!employeeId) {
      // Orphan BioTime code (no Hudoori profile): keep punch days from phase 2;
      // fill remaining calendar days as absent so the code still appears in «كل أكواد BioTime».
      if (!requestedCodeSet.has(empCode)) continue;
      for (const checkDate of allDates) {
        const k = `${empCode}:${dateKey(checkDate)}`;
        if (existingKeys.has(k)) continue;
        const dev = empLastDevice.get(empCode) ?? ['', ''];
        lines.push(
          makeLine({
            employeeId: null,
            employeeCode: empCode,
            employeeName: meta.employeeName,
            punchDate: checkDate,
            deviceName: dev[0],
            deviceSn: dev[1],
            firstCheckIn: null,
            lastCheckOut: null,
            punchCount: 0,
            checkInCount: 0,
            checkOutCount: 0,
            shiftId: null,
            shiftName: '',
            expectedCheckIn: null,
            expectedCheckOut: null,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
            netWorkedHours: 0,
            overtimeHours: 0,
            isOffDay: false,
            isAbsent: true,
            isAnnualLeave: false,
          }),
        );
        existingKeys.add(k);
      }
      continue;
    }

    for (const checkDate of allDates) {
      const k = `${empCode}:${dateKey(checkDate)}`;
      if (existingKeys.has(k)) continue;

      // Empty days before hire stay «قبل التعيين»; days with real punches already exist.
      if (isBeforeHireDate(checkDate, hireDateByEmpId.get(employeeId))) {
        const dev = empLastDevice.get(empCode) ?? ['', ''];
        lines.push(
          makeLine({
            employeeId,
            employeeCode: empCode,
            employeeName: meta.employeeName,
            punchDate: checkDate,
            deviceName: dev[0],
            deviceSn: dev[1],
            firstCheckIn: null,
            lastCheckOut: null,
            punchCount: 0,
            checkInCount: 0,
            checkOutCount: 0,
            shiftId: null,
            shiftName: BEFORE_HIRE_SHIFT,
            expectedCheckIn: null,
            expectedCheckOut: null,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
            netWorkedHours: 0,
            overtimeHours: 0,
            isOffDay: false,
            isAbsent: false,
            isAnnualLeave: false,
          }),
        );
        existingKeys.add(k);
        continue;
      }

      if (gridScoped && !gridByEmpDate.has(`${employeeId}:${dateKey(checkDate)}`)) {
        // No shift-grid cell for this day — still emit the date (usually غياب) through period end.
      }

      const cached = getCachedShift(employeeId, checkDate);

      if (cached.isPresent) {
        const shift = cached.shift;
        let shiftName = 'حاضر';
        let expectedCheckIn: Date | null = null;
        let expectedCheckOut: Date | null = null;
        if (shift) {
          shiftName = `حاضر - ${shift.name}`;
          [expectedCheckIn, expectedCheckOut] = getExpectedTimesForDate(shift, checkDate);
        }
        const breakDur = shift?.breakDuration ?? 0;
        const firstCheckIn = expectedCheckIn;
        const lastCheckOut = expectedCheckOut;
        const checkInCount = firstCheckIn ? 1 : 0;
        const checkOutCount = lastCheckOut ? 1 : 0;
        const punchCount = checkInCount + checkOutCount;
        let workedHours = 0;
        if (firstCheckIn && lastCheckOut && lastCheckOut > firstCheckIn) {
          workedHours = (lastCheckOut.getTime() - firstCheckIn.getTime()) / 3600000;
        }
        let netWorkedHours = workedHours > 0 ? roundHours(Math.max(0, workedHours - breakDur)) : 0;
        let overtimeHours = 0;
        if (shift) {
          overtimeHours = resolveReportOt(
            employeeId,
            checkDate,
            netWorkedHours,
            shiftTotalHours(shift),
          );
        }
        const dev = empLastDevice.get(empCode) ?? ['', ''];
        lines.push(
          makeLine({
            employeeId,
            employeeCode: empCode,
            employeeName: meta.employeeName,
            punchDate: checkDate,
            deviceName: dev[0],
            deviceSn: dev[1],
            firstCheckIn,
            lastCheckOut,
            punchCount,
            checkInCount,
            checkOutCount,
            shiftId: shift?.id ?? null,
            shiftName,
            expectedCheckIn,
            expectedCheckOut,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
            netWorkedHours,
            overtimeHours,
            isOffDay: false,
            isAbsent: false,
            isAnnualLeave: false,
          }),
        );
        existingKeys.add(k);
        continue;
      }

      if (cached.isOff || cached.isSick || cached.isAnnual || cached.isExcluded) {
        continue;
      }

      const shift = cached.shift;
      const shiftName = shift?.name ?? '';
      const [expectedCheckIn, expectedCheckOut] = shift
        ? getExpectedTimesForDate(shift, checkDate)
        : [null, null];
      const dev = empLastDevice.get(empCode) ?? ['', ''];
      lines.push(
        makeLine({
          employeeId,
          employeeCode: empCode,
          employeeName: meta.employeeName,
          punchDate: checkDate,
          deviceName: dev[0],
          deviceSn: dev[1],
          firstCheckIn: null,
          lastCheckOut: null,
          punchCount: 0,
          checkInCount: 0,
          checkOutCount: 0,
          shiftId: shift?.id ?? null,
          shiftName,
          expectedCheckIn,
          expectedCheckOut,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          netWorkedHours: 0,
          overtimeHours: 0,
          isOffDay: false,
          isAbsent: true,
          isAnnualLeave: false,
        }),
      );
      existingKeys.add(k);
    }
  }

  lines.sort((a, b) => {
    const c = (a.employeeCode || a.employeeName).localeCompare(b.employeeCode || b.employeeName, 'ar');
    if (c !== 0) return c;
    return dateKey(a.punchDate).localeCompare(dateKey(b.punchDate));
  });

  return lines;
}
