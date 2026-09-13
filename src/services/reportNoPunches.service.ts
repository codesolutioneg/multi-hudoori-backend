/**
 * Report 1 — employees with no punches in a period (بدون بصمات).
 *
 * The inverse of exportUnlocatedEmployeesPunchesXlsx, which lists employees who
 * punched but carry no data. This lists employees who carry data but never
 * punched.
 *
 * Deliberately NOT built on noPunchAlerts.service: that snapshot is a fixed
 * 7-day window and drops anyone with no Attendance rows, which excludes exactly
 * the bare codes HR wants to see ("أكواد معمولة"). This walks the employee list
 * and subtracts whoever has a punch, so an employee with no shift, no schedule
 * and no attendance still appears.
 */
import { prisma } from '../prisma/client';
import {
  dateOnly,
  findReportEmployees,
  identityCells,
  IDENTITY_HEADERS,
  yesNo,
  type EmployeeScopeFilters,
  type EmployeeWithReportRelations,
} from './hrReports.service';
import { buildReportWorkbook, type ReportFile } from './hrReportsExcel.service';

export type NoPunchReportOptions = EmployeeScopeFilters & {
  dateFrom: Date;
  dateTo: Date;
  /** Include employees who have never had a shift or attendance row. */
  includeNeverScheduled?: boolean;
};

export type NoPunchReportRow = {
  employeeId: string;
  code: string;
  name: string;
  locationName: string;
  departmentName: string;
  nationalId: string;
  hiringDate: string;
  departureDate: string;
  hasShiftSchedule: boolean;
  /** True when nothing but a code exists: no schedule and no attendance. */
  isBareCode: boolean;
  lastPunchAt: string;
};

function employeeCodes(emp: EmployeeWithReportRelations): string[] {
  return [emp.code, emp.mapping?.biotimeEmpCode, emp.identificationId, emp.barcode]
    .map((c) => c?.trim())
    .filter((c): c is string => Boolean(c));
}

export async function buildNoPunchReport(
  options: NoPunchReportOptions,
): Promise<NoPunchReportRow[]> {
  const employees = await findReportEmployees(options);
  if (employees.length === 0) return [];

  const employeeIds = employees.map((e) => e.id);

  // Punches are matched on employeeId OR empCode: unlinked transactions carry
  // only a code, and those still prove the employee punched.
  const [punches, scheduledIds, gridIds, lastPunches] = await Promise.all([
    prisma.transaction.findMany({
      where: { punchTime: { gte: options.dateFrom, lte: options.dateTo } },
      select: { employeeId: true, empCode: true },
    }),
    prisma.shiftAssignment
      .findMany({ where: { employeeId: { in: employeeIds } }, select: { employeeId: true } })
      .then((rows) => new Set(rows.map((r) => r.employeeId))),
    prisma.shiftGridLine
      .findMany({ where: { employeeId: { in: employeeIds } }, select: { employeeId: true } })
      .then((rows) => new Set(rows.map((r) => r.employeeId))),
    prisma.transaction.groupBy({
      by: ['employeeId'],
      where: { employeeId: { in: employeeIds } },
      _max: { punchTime: true },
    }),
  ]);

  const punchedIds = new Set<string>();
  const punchedCodes = new Set<string>();
  for (const punch of punches) {
    if (punch.employeeId) punchedIds.add(punch.employeeId);
    const code = punch.empCode?.trim();
    if (code) punchedCodes.add(code);
  }
  const lastPunchById = new Map(
    lastPunches.map((row) => [row.employeeId ?? '', row._max.punchTime ?? null]),
  );

  const rows: NoPunchReportRow[] = [];
  for (const emp of employees) {
    const punched =
      punchedIds.has(emp.id) || employeeCodes(emp).some((code) => punchedCodes.has(code));
    if (punched) continue;

    const hasSchedule = scheduledIds.has(emp.id) || gridIds.has(emp.id);
    const isBareCode = !hasSchedule;
    if (isBareCode && options.includeNeverScheduled === false) continue;

    const identity = identityCells(emp);
    rows.push({
      employeeId: emp.id,
      locationName: identity[0],
      departmentName: identity[1],
      code: identity[2],
      name: identity[3],
      nationalId: identity[4],
      hiringDate: dateOnly(emp.hiringDate),
      departureDate: dateOnly(emp.departureDate),
      hasShiftSchedule: hasSchedule,
      isBareCode,
      lastPunchAt: dateOnly(lastPunchById.get(emp.id) ?? null),
    });
  }
  return rows;
}

const HEADERS = [
  ...IDENTITY_HEADERS,
  'تاريخ التعيين',
  'تاريخ ترك العمل',
  'له جدول شيفتات',
  'كود بدون بيانات',
  'آخر بصمة على الإطلاق',
] as const;

export async function exportNoPunchReportXlsx(
  options: NoPunchReportOptions,
): Promise<ReportFile> {
  const rows = await buildNoPunchReport(options);
  const criteria = [
    `الفترة: من ${dateOnly(options.dateFrom)} إلى ${dateOnly(options.dateTo)}`,
    `الأكواد بدون جدول شيفتات: ${yesNo(options.includeNeverScheduled !== false)}`,
    `المؤرشفون: ${yesNo(Boolean(options.includeArchived))}`,
    `بشرط وجود رقم قومي: ${yesNo(Boolean(options.requireNationalId))}`,
    `عدد النتائج: ${rows.length}`,
  ];

  return buildReportWorkbook(
    [
      {
        title: 'موظفون بدون بصمات',
        criteria,
        headers: HEADERS,
        rows: rows.map((r) => [
          r.locationName,
          r.departmentName,
          r.code,
          r.name,
          r.nationalId,
          r.hiringDate,
          r.departureDate,
          yesNo(r.hasShiftSchedule),
          yesNo(r.isBareCode),
          r.lastPunchAt,
        ]),
        // A bare code is the actionable case: either wire it up or archive it.
        alertRows: new Set(rows.map((r, i) => (r.isBareCode ? i : -1)).filter((i) => i >= 0)),
        emptyMessage: 'كل الموظفين لهم بصمات في الفترة المحددة',
      },
    ],
    'report_no_punches',
  );
}
