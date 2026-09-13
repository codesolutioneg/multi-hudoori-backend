/**
 * Report — punch summary (ملخص البصمات), one row per employee.
 *
 * The on-screen rows reuse `computeEmployeeSummary`. Excel export deliberately
 * delegates to `punchReportExcel.service.ts`, producing the exact same daily
 * lines, employee summaries, breakdown sheet and metadata as a shift-grid
 * "تقرير البصمات Excel", scoped to employees in the selected branch.
 */
import {
  findReportEmployees,
  identityCells,
  type EmployeeScopeFilters,
} from './hrReports.service';
import {
  computeEmployeeSummary,
  generatePunchReportLines,
  getPayableSummaryPeriodDays,
  type EmployeeSummaryRow,
  type PunchReportExportLine,
} from './punchReportLine.service';
import { getLatePolicy } from './latePolicy.service';
import { getPayablePeriodPolicy } from './payablePeriod.service';
import { exportPunchReportFileResponse } from './punchReportExcel.service';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';

/** Prefer a location shift grid overlapping the report period (same roster logic as جدول الشيفتات). */
async function findOverlappingShiftGridId(
  locationId: string | null | undefined,
  dateFrom: Date,
  dateTo: Date,
): Promise<string | undefined> {
  if (!locationId) return undefined;
  const grid = await prisma.shiftGrid.findFirst({
    where: {
      locationId,
      dateFrom: { lte: dateTo },
      dateTo: { gte: dateFrom },
    },
    orderBy: [{ dateFrom: 'desc' }],
    select: { id: true },
  });
  return grid?.id;
}

export type PunchSummaryReportOptions = EmployeeScopeFilters & {
  dateFrom: Date;
  dateTo: Date;
};

export type PunchSummaryReportRow = EmployeeSummaryRow & {
  employeeId: string;
  code: string;
  name: string;
  locationName: string;
  departmentName: string;
  nationalId: string;
  /**
   * False when the attendance pipeline produced no line for this employee, so
   * every figure is zero because nothing could be measured rather than because
   * the record is clean. Happens for an employee with no attendance code, and
   * for an inactive one with no punches in the period (which the punch report
   * omits, matching Odoo). Derived from the result, so it stays correct if the
   * pipeline gains another exclusion.
   */
  measured: boolean;
};

export async function buildPunchSummaryReport(
  options: PunchSummaryReportOptions,
): Promise<PunchSummaryReportRow[]> {
  const employees = await findReportEmployees(options);
  if (!employees.length) return [];

  const shiftGridId = await findOverlappingShiftGridId(
    options.locationId,
    options.dateFrom,
    options.dateTo,
  );

  const lines = await generatePunchReportLines({
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    employeeIds: employees.map((e) => e.id),
    // The population was already decided by findReportEmployees; re-filtering on
    // `active` here would drop inactive-but-not-archived employees it selected,
    // leaving them as all-zero rows.
    includeInactive: true,
    ...(shiftGridId ? { shiftGridId } : {}),
  });

  const linesByEmp = new Map<string, PunchReportExportLine[]>();
  for (const line of lines) {
    if (!line.employeeId) continue;
    const list = linesByEmp.get(line.employeeId) ?? [];
    list.push(line);
    linesByEmp.set(line.employeeId, list);
  }

  const policy = await getLatePolicy();
  const payablePolicy = await getPayablePeriodPolicy();
  const periodDays = getPayableSummaryPeriodDays(
    options.dateFrom,
    options.dateTo,
    payablePolicy,
  );

  // computeSummaryWorkMetrics derives the day figures from the period length, so
  // asking it about an employee with no lines invents an attendance record
  // (a seven-day period reports eight actual working days). An unmeasured row
  // has to read as zeros next to its flag, not as fabricated attendance.
  const zeroSummary = computeEmployeeSummary(
    [],
    0,
    0,
    policy,
    payablePolicy.absentForgivenDaysCount,
  );

  const rows: PunchSummaryReportRow[] = [];
  for (const emp of employees) {
    const empLines = linesByEmp.get(emp.id) ?? [];
    const summary = empLines.length
      ? computeEmployeeSummary(
          empLines,
          periodDays,
          0,
          policy,
          payablePolicy.absentForgivenDaysCount,
        )
      : zeroSummary;
    const identity = identityCells(emp);
    rows.push({
      ...summary,
      employeeId: emp.id,
      locationName: identity[0],
      departmentName: identity[1],
      code: identity[2],
      name: identity[3],
      nationalId: identity[4],
      measured: empLines.length > 0,
    });
  }

  rows.sort((a, b) => {
    const byLoc = a.locationName.localeCompare(b.locationName, 'ar');
    if (byLoc !== 0) return byLoc;
    return a.name.localeCompare(b.name, 'ar');
  });

  return rows;
}

export async function exportPunchSummaryReportXlsx(
  options: PunchSummaryReportOptions,
) {
  const employees = await findReportEmployees(options);
  if (!employees.length) {
    throw new AppError('لا يوجد موظفون في الفرع المحدد', 404, 'NOT_FOUND');
  }
  let locationName: string | null = null;
  if (options.locationId) {
    const loc = await prisma.location.findUnique({
      where: { id: options.locationId },
      select: { name: true, actualName: true },
    });
    locationName = loc?.actualName?.trim() || loc?.name?.trim() || null;
  }
  const shiftGridId = await findOverlappingShiftGridId(
    options.locationId,
    options.dateFrom,
    options.dateTo,
  );
  return exportPunchReportFileResponse({
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    employeeIds: employees.map((employee) => employee.id),
    // The branch filter already chose the population. Keep explicitly included
    // archived/inactive employees instead of silently dropping them downstream.
    includeInactive: true,
    locationName,
    ...(shiftGridId ? { shiftGridId } : {}),
  });
}
