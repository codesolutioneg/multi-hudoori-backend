import {
  computeSummaryWorkMetrics,
  excessRegularLeaveDays,
  generatePunchReportLines,
  weightedAbsentPenaltyDays,
  type PunchReportExportLine,
} from './punchReportLine.service';
import {
  cappedPermissionCount,
  DEFAULT_LATE_POLICY,
  lateDayFraction,
  splitForgivenLateDays,
  type LatePolicy,
} from './latePolicy.service';
import { DEFAULT_PAYABLE_PERIOD_POLICY } from './payablePeriod.service';

export interface PunchReportLine {
  employeeId: string | null;
  employeeCode: string;
  employeeName: string;
  punchDate: Date;
  punchCount: number;
  checkInCount: number;
  checkOutCount: number;
  isOffDay: boolean;
  isAbsent: boolean;
  isPermission: boolean;
  shiftName: string;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeHours: number;
  netWorkedHours: number;
}

export function earnedLeaveFromBaseDays(actualBaseDays: number): number {
  if (actualBaseDays >= 24) return 4;
  if (actualBaseDays >= 20) return 3;
  if (actualBaseDays >= 13) return 2;
  if (actualBaseDays >= 6) return 1;
  return 0;
}

export function exportLineToPayrollLine(line: PunchReportExportLine): PunchReportLine {
  return {
    employeeId: line.employeeId,
    employeeCode: line.employeeCode,
    employeeName: line.employeeName,
    punchDate: line.punchDate,
    punchCount: line.punchCount,
    checkInCount: line.checkInCount,
    checkOutCount: line.checkOutCount,
    isOffDay: line.isOffDay,
    isAbsent: line.isAbsent,
    isPermission: line.isBusDelay,
    shiftName: line.shiftName,
    lateMinutes: line.lateMinutes,
    earlyLeaveMinutes: line.earlyLeaveMinutes,
    overtimeHours: line.overtimeHours,
    netWorkedHours: line.netWorkedHours,
  };
}

function payrollLineToMetricsLine(line: PunchReportLine): PunchReportExportLine {
  return {
    id: 0,
    employeeId: line.employeeId,
    employeeCode: line.employeeCode,
    employeeName: line.employeeName,
    jobTitle: '',
    punchDate: line.punchDate,
    deviceName: '',
    deviceSn: '',
    firstCheckIn: null,
    lastCheckOut: null,
    punchCount: line.punchCount,
    checkInCount: line.checkInCount,
    checkOutCount: line.checkOutCount,
    shiftId: null,
    shiftName: line.shiftName,
    expectedCheckIn: null,
    expectedCheckOut: null,
    lateMinutes: line.lateMinutes,
    earlyLeaveMinutes: line.earlyLeaveMinutes,
    netWorkedHours: line.netWorkedHours,
    overtimeHours: line.overtimeHours,
    isOffDay: line.isOffDay,
    isAbsent: line.isAbsent,
    isAnnualLeave: line.shiftName === 'إجازة سنوية',
    isBusDelay: line.isPermission,
    basicSalary: 0,
  };
}

/** Unified Odoo-parity punch report (delegates to punch report wizard logic). */
export async function generatePunchReport(
  dateFrom: Date,
  dateTo: Date,
  employeeIds?: string[],
  shiftGridId?: string,
  includeInactive?: boolean,
): Promise<PunchReportLine[]> {
  const exportLines = await generatePunchReportLines({
    dateFrom,
    dateTo,
    employeeIds,
    shiftGridId,
    includeInactive,
  });
  return exportLines.map(exportLineToPayrollLine);
}

export { lateDayFraction };

export function calculateEmployeePayrollFromLines(
  lines: PunchReportLine[],
  basicSalary: number,
  /**
   * Calendar days in the payable period. Defaults to the standard 30-day
   * month; pass the prorated day count for employees archived mid-period.
   */
  periodBaseDays?: number,
  policy: LatePolicy = DEFAULT_LATE_POLICY,
  absentForgivenDaysCount = DEFAULT_PAYABLE_PERIOD_POLICY.absentForgivenDaysCount,
) {
  const totalOt = lines.filter((l) => !l.isOffDay).reduce((s, l) => s + l.overtimeHours, 0);
  const otOffDays = lines
    .filter((l) => l.isOffDay && l.punchCount > 0)
    .reduce((s, l) => s + l.overtimeHours, 0);
  const totalOtAll = totalOt + otOffDays;

  const offDayCount = lines.filter((l) => l.isOffDay && l.shiftName === 'إجازة').length;
  const sickDayCount = lines.filter((l) => l.isOffDay && l.shiftName === 'إجازة مرضية').length;

  const payableDays = Math.max(0, periodBaseDays ?? 30);
  const metrics = computeSummaryWorkMetrics(lines.map(payrollLineToMetricsLine), payableDays);
  const earnedLeaveCapped = metrics.earnedLeaveCapped;
  const actualWorkingDays = metrics.actualWorkingDays;

  const absentCount = weightedAbsentPenaltyDays(lines, absentForgivenDaysCount, false);
  const excessLeaveDays = excessRegularLeaveDays(lines, 4);

  const { charged: deductibleLate } = splitForgivenLateDays(lines, policy);
  const lateDeductibleMinutes = deductibleLate.reduce((s, l) => s + l.lateMinutes, 0);
  const lateDeductibleDays = deductibleLate.reduce(
    (s, l) => s + lateDayFraction(l.lateMinutes, policy),
    0,
  );

  const totalEarly = lines.reduce((s, l) => s + l.earlyLeaveMinutes, 0);
  const lateCheckoutMinutes = lines
    .filter((l) => l.netWorkedHours < 9)
    .reduce((s, l) => s + l.earlyLeaveMinutes, 0);
  const totalNetHours = lines.reduce((s, l) => s + l.netWorkedHours, 0);

  const missingOutDays = lines.filter(
    (l) =>
      !l.isOffDay &&
      !l.isAbsent &&
      l.punchCount === 1 &&
      l.checkInCount > 0 &&
      l.checkOutCount === 0,
  );
  const missingOutDeduction = Math.max(0, missingOutDays.length - 1) * 0.25;

  const missingInDays = lines.filter(
    (l) =>
      !l.isOffDay &&
      !l.isAbsent &&
      l.punchCount === 1 &&
      l.checkOutCount > 0 &&
      l.checkInCount === 0,
  );
  const missingInDeduction = Math.max(0, missingInDays.length - 1) * 0.5;

  const dailyRate = basicSalary / 30;
  const hourlyRate = dailyRate / 8;

  const workDaysSalary = Math.round(actualWorkingDays * dailyRate * 100) / 100;
  const overtimeAmount = Math.round(totalOtAll * dailyRate * 100) / 100;
  const grossSalary = Math.round((workDaysSalary + overtimeAmount) * 100) / 100;

  const lateDeduction = Math.round(lateDeductibleDays * dailyRate * 100) / 100;
  const earlyDeduction = Math.round((totalEarly / 60) * hourlyRate * 100) / 100;
  const lateCheckoutDeduction = Math.round((lateCheckoutMinutes / 60 / 9) * dailyRate * 100) / 100;
  const absentDeduction = Math.round(absentCount * dailyRate * 100) / 100;
  // Extra «إجازة» days are unpaid (out of working days) — do not charge them again.
  const excessLeaveDeduction = 0;
  const sickDeduction = Math.round(sickDayCount * 0.25 * dailyRate * 100) / 100;
  const punchDeductionCheckin = Math.round(missingInDeduction * dailyRate * 100) / 100;
  const punchDeductionCheckout = Math.round(missingOutDeduction * dailyRate * 100) / 100;

  const totalDeductions =
    lateDeduction +
    earlyDeduction +
    lateCheckoutDeduction +
    absentDeduction +
    sickDeduction +
    punchDeductionCheckin +
    punchDeductionCheckout;

  const permissionCount = lines.filter((l) => l.isPermission).length;

  const singlePunchCount = lines.filter(
    (l) => l.punchCount === 1 && !l.isOffDay && !l.isAbsent,
  ).length;

  const netSalary = Math.round((grossSalary - totalDeductions) * 100) / 100;

  return {
    workingDays: actualWorkingDays,
    actualWorkingDays,
    workDaysSalary,
    overtimeHours: totalOtAll,
    overtimeAmount,
    grossSalary,
    totalEarnings: grossSalary,
    totalDeductions,
    netSalary,
    absentDays: absentCount,
    excessLeaveDays,
    lateDeductibleDays,
    lateDeductibleMinutes,
    earnedLeave: earnedLeaveCapped,
    permissionCount: cappedPermissionCount(permissionCount, policy),
    lateDeduction,
    earlyDeduction,
    lateCheckoutDeduction,
    absentDeduction,
    excessLeaveDeduction,
    sickDeduction,
    punchDeductionCheckin,
    punchDeductionCheckout,
    singlePunchCount,
    earlyLeaveMinutes: totalEarly,
    totalNetHours,
    offDayCount,
    sickDayCount,
  };
}
