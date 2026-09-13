import {
  Attendance,
  BioTimeConfig,
  Deduction,
  Device,
  EmployeeMapping,
  EmployeeProfile,
  Payroll,
  PayrollLine,
  Shift,
  ShiftAssignment,
  ShiftGrid,
  ShiftGridLine,
  AdvanceShort,
  AdvanceLong,
  AdvanceLongPayment,
  Department,
  Location,
  PayrollState,
} from '@prisma/client';
import { computeLongAdvanceAmounts, longAdvanceCanEdit, longAdvanceCanStop, longAdvanceCanAdjustRemaining } from './advances.service';
import { prisma } from '../prisma/client';
import { shiftJsonExtras } from './shiftCalculations.service';
import { assignmentToWeeklyPattern } from './shiftGridAssignment.service';
import { roundHours } from './shiftTime.service';
import { employeeCustomFieldsJson } from './employeeProfileFields.service';
import { latePolicyConfigJson } from './latePolicy.service';
import { payablePeriodConfigJson } from './payablePeriod.service';
import { computePayrollExcelSummary } from './payrollExport.service';

type EmployeeWithRelations = EmployeeProfile & {
  department?: Department | null;
  mapping?: EmployeeMapping | null;
  workLocation?: Location | null;
  manager?: EmployeeProfile | null;
};

export function resolveEmployeeDisplayName(
  employee: EmployeeWithRelations,
): string {
  const local = (employee.displayName || employee.name || '').trim();

  // Local edits not yet pushed to BioTime — show saved name, not stale mapping.
  if (!employee.biotimeSynced && local) return local;

  const map = employee.mapping;
  const fromMapping = [map?.firstName, map?.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (fromMapping) return fromMapping;

  const code = employee.code ?? map?.biotimeEmpCode ?? '';
  if (code && local === code) return local;
  return local || code || '—';
}

export function employeeListJson(employee: EmployeeWithRelations) {
  const map = employee.mapping;
  const displayName = resolveEmployeeDisplayName(employee);
  const code = employee.code ?? map?.biotimeEmpCode ?? '';
  return {
    id: employee.id,
    displayName,
    name: employee.name,
    code,
    department: employee.department?.name ?? '',
    departmentEn:
      employee.department?.nameEn ?? employee.department?.name ?? '',
    departmentId: employee.departmentId ?? false,
    job: employee.jobTitle ?? '',
    jobTitle: employee.jobTitle ?? '',
    workEmail: employee.workEmail || map?.email || '',
    mobilePhone: employee.mobilePhone || map?.mobile || '',
    biotimeSynced: employee.biotimeSynced,
    active: employee.active,
    archivedAt: employee.archivedAt?.toISOString() ?? false,
    archiveReason: employee.archiveReason ?? '',
    departureDate: employee.departureDate?.toISOString().slice(0, 10) ?? '',
    cardNo: map?.cardNo ?? '',
    locationId: employee.locationId ?? false,
    location: employee.workLocation?.name ?? employee.location ?? '',
    locationName: employee.workLocation?.name ?? employee.location ?? '',
  };
}

export function employeeJson(
  employee: EmployeeWithRelations,
  includeBiotime = false,
) {
  const displayName = resolveEmployeeDisplayName(employee);

  const data: Record<string, unknown> = {
    id: employee.id,
    name: employee.name,
    displayName,
    code: employee.code ?? '',
    identificationId: employee.identificationId ?? '',
    barcode: employee.barcode ?? '',
    departmentId: employee.departmentId ?? false,
    department: employee.department?.name ?? '',
    departmentEn:
      employee.department?.nameEn ?? employee.department?.name ?? '',
    job: employee.jobTitle ?? '',
    jobTitle: employee.jobTitle ?? '',
    managerId: employee.managerId ?? false,
    managerName: employee.manager
      ? (employee.manager.displayName || employee.manager.name || '').trim()
      : '',
    workPhone: employee.workPhone ?? '',
    mobilePhone: employee.mobilePhone ?? '',
    workEmail: employee.workEmail ?? '',
    workEmailPassword: employee.workEmailPassword ?? '',
    gender: employee.gender ?? '',
    active: employee.active,
    archivedAt: employee.archivedAt?.toISOString() ?? false,
    archiveReason: employee.archiveReason ?? '',
    departureDate: employee.departureDate?.toISOString().slice(0, 10) ?? '',
    location: employee.workLocation?.name ?? employee.location ?? '',
    locationId: employee.locationId ?? false,
    locationName: employee.workLocation?.name ?? employee.location ?? '',
    basicSalary: employee.basicSalary,
    biotimeSynced: employee.biotimeSynced,
    biotimeDeviceId: employee.biotimeDeviceId ?? false,
    ...employeeCustomFieldsJson(employee),
  };

  if (includeBiotime && employee.mapping) {
    data.mapping = mappingJson(employee.mapping);
  }
  return data;
}

export function mappingJson(mapping: EmployeeMapping) {
  return {
    id: mapping.id,
    biotimeEmpId: mapping.biotimeEmpId,
    biotimeEmpCode: mapping.biotimeEmpCode ?? '',
    firstName: mapping.firstName ?? '',
    lastName: mapping.lastName ?? '',
    cardNo: mapping.cardNo ?? '',
  };
}

export function configSettingsJson(
  config: BioTimeConfig,
  counts?: {
    employees: number;
    departments: number;
    devices: number;
    transactions: number;
  },
) {
  const hasCredentials = Boolean(config.username && config.password);
  const connected =
    config.isConnected && Boolean(config.serverIp) && hasCredentials;
  return {
    id: config.id,
    name: config.serverIp ? `BioTime @ ${config.serverIp}` : 'BioTime',
    serverIp: config.serverIp,
    serverPort: config.serverPort,
    useHttps: config.useHttps,
    username: config.username,
    credentialsConfigured: hasCredentials,
    isConnected: connected,
    connectionMessage: connected
      ? 'Connected to BioTime server'
      : hasCredentials
        ? 'Credentials saved — run Test connection'
        : 'Not connected — enter BioTime API username and password in settings',
    timezone: config.timezone,
    authType: config.authType,
    autoSyncEmployees: config.autoSyncEmployees,
    autoSyncDepartments: config.autoSyncDepartments,
    autoSyncTransactions: config.autoSyncTransactions,
    scheduledAutoSyncEnabled: config.scheduledAutoSyncEnabled !== false,
    autoPushToBiotime: config.autoPushToBiotime === true,
    autoPushDeletes: config.autoPushDeletes,
    defaultBiotimeAreaId: config.defaultBiotimeAreaId ?? false,
    employeeSyncIntervalHours: config.employeeSyncIntervalHours,
    transactionSyncIntervalMinutes: config.transactionSyncIntervalMins,
    duplicateGraceMinutes: config.duplicateGraceMinutes,
    duplicatePolicy: config.duplicatePolicy,
    lastEmployeeSync: config.lastEmployeeSync?.toISOString() ?? false,
    lastDepartmentSync: config.lastDepartmentSync?.toISOString() ?? false,
    lastTransactionSync: config.lastTransactionSync?.toISOString() ?? false,
    employeeCount: counts?.employees ?? 0,
    transactionCount: counts?.transactions ?? 0,
    totalDepartmentsSynced: counts?.departments ?? 0,
    totalDevicesSynced: counts?.devices ?? 0,
    hasCompanyLogo: Boolean(config.companyLogoPath),
    advanceDefaultPercent: config.advanceDefaultPercent ?? 25,
    advanceMinimumWorkingDays: config.advanceMinimumWorkingDays ?? 15,
    advanceEnforceLimit: config.advanceEnforceLimit !== false,
    advanceEligibilitySource: config.advanceEligibilitySource ?? 'punch_report',
    tipJobTitleIds: config.tipJobTitleIds ?? [],
    // Prefixed to stay unambiguous next to duplicateGraceMinutes.
    ...latePolicyConfigJson(config),
    payrollMonthStartDay: config.payrollMonthStartDay ?? 26,
    ...payablePeriodConfigJson(config),
    gridWeekStartDay: config.gridWeekStartDay ?? 0,
    employeeTeamScheduleScope: config.employeeTeamScheduleScope ?? 'department',
    employeeTeamShowShiftTimes: config.employeeTeamShowShiftTimes !== false,
    employeeTeamShowOffDays: config.employeeTeamShowOffDays !== false,
    employeeTeamShowLeave: config.employeeTeamShowLeave === true,
    employeeTeamShowSickLeave: config.employeeTeamShowSickLeave === true,
  };
}

export async function configSettingsWithCounts(config: BioTimeConfig) {
  const [employees, departments, devices, transactions] = await Promise.all([
    prisma.employeeProfile.count(),
    prisma.department.count(),
    prisma.device.count(),
    prisma.transaction.count(),
  ]);
  return configSettingsJson(config, {
    employees,
    departments,
    devices,
    transactions,
  });
}

export function configSummaryJson(config: BioTimeConfig | null) {
  if (!config) return {};
  return {
    serverIp: config.serverIp,
    isConnected: config.isConnected,
  };
}

export function shiftJson(shift: Shift) {
  const extras = shiftJsonExtras(
    shift.startTime,
    shift.endTime,
    shift.breakDuration,
    shift.isOvernight,
  );
  return {
    id: shift.id,
    name: shift.name,
    code: shift.code ?? '',
    startTime: extras.startTime,
    endTime: extras.endTime,
    startTimeDisplay: extras.startTimeDisplay,
    endTimeDisplay: extras.endTimeDisplay,
    startTimeStored: shift.startTime,
    endTimeStored: shift.endTime,
    isOvernight: shift.isOvernight,
    workDateReference: shift.workDateReference,
    earlyCheckinThreshold: shift.earlyCheckinThreshold,
    lateCheckoutThreshold: shift.lateCheckoutThreshold,
    restDays: shift.restDays ?? '',
    breakDuration: shift.breakDuration,
    totalHours: extras.totalHours,
    gracePeriodIn: shift.gracePeriodIn,
    gracePeriodOut: shift.gracePeriodOut,
    checkInGrace: shift.gracePeriodIn,
    checkOutGrace: shift.gracePeriodOut,
    active: shift.active,
  };
}

export function shiftAssignmentJson(
  a: ShiftAssignment & { shift?: Shift | null; employee?: EmployeeProfile },
) {
  const employeeName = a.employee?.name ?? '';
  const shiftCode = a.shift?.code ?? '';
  const shiftName = a.shift?.name ?? '';
  return {
    id: a.id,
    employeeId: a.employeeId,
    employeeName,
    displayName: employeeName,
    shiftId: a.shiftId,
    shiftName,
    shiftCode,
    dateFrom: a.dateFrom.toISOString().slice(0, 10),
    dateTo: a.dateTo?.toISOString().slice(0, 10) ?? null,
    weekDays: a.weekDays ?? '',
    assignmentType: a.assignmentType,
    notes: a.notes ?? '',
    weekly: assignmentToWeeklyPattern(a),
    active: a.active,
  };
}

export function deviceJson(
  d: Device & {
    location?: { id: string; name: string; code?: string | null } | null;
  },
) {
  return {
    id: d.id,
    name: d.name,
    alias: d.alias ?? '',
    serialNumber: d.serialNumber ?? '',
    ipAddress: d.ipAddress ?? '',
    active: d.active,
    locationId: d.locationId ?? null,
    locationName: d.location?.name ?? '',
    locationCode: d.location?.code ?? '',
  };
}

export function departmentJson(d: Department) {
  return {
    id: d.id,
    name: d.name,
    nameAr: d.name,
    nameEn: d.nameEn ?? '',
    code: d.code ?? '',
    sequence: d.sequence,
    active: d.active,
  };
}

export function attendanceJson(
  a: Attendance & { employee?: EmployeeWithRelations | null },
) {
  const displayName = a.employee ? resolveEmployeeDisplayName(a.employee) : '';
  const code = a.employee?.code ?? a.employee?.mapping?.biotimeEmpCode ?? '';
  return {
    id: a.id,
    employeeId: a.employeeId,
    employeeName: displayName,
    employeeCode: code,
    departmentName: a.employee?.department?.name ?? '',
    employee: a.employee
      ? {
          id: a.employee.id,
          name: a.employee.name,
          displayName,
          code,
        }
      : undefined,
    date: a.date.toISOString().slice(0, 10),
    shiftId: a.shiftId ?? false,
    expectedCheckIn: a.expectedCheckIn ?? '',
    expectedCheckOut: a.expectedCheckOut ?? '',
    firstCheckIn: a.firstCheckIn?.toISOString() ?? false,
    lastCheckOut: a.lastCheckOut?.toISOString() ?? false,
    workedHours: roundHours(a.workedHours),
    netWorkedHours: roundHours(a.netWorkedHours),
    lateMinutes: a.lateMinutes,
    earlyLeaveMinutes: a.earlyLeaveMinutes,
    overtimeHours: roundHours(a.overtimeHours),
    status: a.status,
  };
}

export function locationJson(loc: Location) {
  return {
    id: loc.id,
    name: loc.name,
    actualName: loc.actualName ?? '',
    code: loc.code ?? '',
    active: loc.active,
    sequence: loc.sequence,
    loanNotificationEmails: loc.loanNotificationEmails,
    locationPunchEnabled: Boolean(loc.locationPunchEnabled),
    latitude: loc.latitude ?? null,
    longitude: loc.longitude ?? null,
    geofenceRadiusMeters: loc.geofenceRadiusMeters ?? 200,
  };
}

export function formatLocationDisplay(
  name?: string | null,
  actualName?: string | null,
): string {
  const n = (name ?? '').trim();
  const actual = (actualName ?? '').trim();
  if (n && actual) return `${n} (${actual})`;
  return n || actual;
}

export function formatOdooReviewReference(
  reference: string,
  actualName?: string | null,
): string {
  const actual = (actualName ?? '').trim();
  return actual ? `${reference} (${actual})` : reference;
}

export function insuranceCompanyJson(company: {
  id: string;
  name: string;
  code: string | null;
  active: boolean;
  sequence: number;
}) {
  return {
    id: company.id,
    name: company.name,
    code: company.code ?? '',
    active: company.active,
    sequence: company.sequence,
  };
}

export function shiftGridJson(
  grid: ShiftGrid & { device?: Device | null; location?: Location | null },
  summary?: {
    lineCount?: number;
    employeeCount?: number;
    daysCount?: number;
    hasAssignedShift?: boolean;
  },
  sync?: Record<string, unknown>,
) {
  const lineCount = summary?.lineCount ?? 0;
  const employeeCount = summary?.employeeCount ?? 0;
  const daysCount = summary?.daysCount ?? 0;
  const hasAssignedShift = summary?.hasAssignedShift === true;
  return {
    id: grid.id,
    name: grid.name,
    dateFrom: grid.dateFrom.toISOString().slice(0, 10),
    dateTo: grid.dateTo.toISOString().slice(0, 10),
    state: grid.state,
    selectionMethod: grid.selectionMethod,
    conflictAction:
      'conflictAction' in grid ? (grid.conflictAction as string) : 'replace',
    employeeIds: 'employeeIds' in grid ? (grid.employeeIds as string[]) : [],
    departmentIds:
      'departmentIds' in grid ? (grid.departmentIds as string[]) : [],
    deviceId: grid.deviceId ?? false,
    deviceName: grid.device?.name ?? grid.device?.alias ?? '',
    gridLocation: grid.location?.name ?? grid.gridLocation ?? '',
    locationId: grid.locationId ?? false,
    locationName: grid.location?.name ?? grid.gridLocation ?? '',
    mergedFromGridIds:
      'mergedFromGridIds' in grid ? (grid.mergedFromGridIds as string[]) : [],
    mergedAt:
      'mergedAt' in grid && grid.mergedAt
        ? (grid.mergedAt as Date).toISOString()
        : null,
    mergedIntoGridId:
      'mergedIntoGridId' in grid
        ? ((grid.mergedIntoGridId as string | null) ?? null)
        : null,
    isMergedGrid:
      'mergedFromGridIds' in grid &&
      (grid.mergedFromGridIds as string[]).length > 0,
    lineCount,
    employeeCount,
    daysCount,
    hasAssignedShift,
    ...(sync ?? {}),
  };
}

export function shiftGridLineJson(
  line: ShiftGridLine & {
    shift?: Shift | null;
    employee?: EmployeeWithRelations;
  },
) {
  return {
    id: line.id,
    employeeId: line.employeeId,
    employeeName: line.employee?.name ?? '',
    employeeLocation:
      line.employee?.workLocation?.name ?? line.employee?.location ?? '',
    date: line.date.toISOString().slice(0, 10),
    shiftId: line.shiftId ?? false,
    shiftName: line.shift?.name ?? '',
    isOff: line.isOff,
    isSick: line.isSick,
    isAnnualLeave: line.isAnnualLeave,
    isExcluded: line.isExcluded,
    isBusDelay: line.isBusDelay,
    isPresent: line.isPresent,
    isFinished: line.isFinished,
    isResignation: line.isResignation,
    isWorkAbsence: line.isWorkAbsence,
    isWorkInjury: line.isWorkInjury,
    isMarriageLeave: line.isMarriageLeave,
  };
}

export function payrollJson(
  payroll: Payroll & {
    shiftGrid?: (ShiftGrid & { location?: Location | null }) | null;
    _count?: { lines: number };
    lines?: Array<{
      netSalary?: number | null;
      employee?: {
        hasFawryAccount?: boolean | null;
        active?: boolean | null;
        departureDate?: Date | null;
        archivedAt?: Date | null;
        archiveReason?: string | null;
      } | null;
    }>;
  },
  includeLines = false,
  lines?: PayrollLine[],
  employeeCountOverride?: number,
  linkStats?: Record<string, number>,
  punchImportSource?: Record<string, unknown> | null,
) {
  const grid = payroll.shiftGrid;
  const branchName =
    grid?.location?.name?.trim() || grid?.gridLocation?.trim() || '';
  const shiftGridTitle = grid?.name?.trim() || '';
  const gridLabel = shiftGridTitle || branchName;
  const employeeCount =
    employeeCountOverride ?? payroll._count?.lines ?? lines?.length ?? 0;

  const splitLines = lines ?? payroll.lines;
  const canExcelTotals = Boolean(
    splitLines?.length &&
      splitLines.some((line) => {
        const row = line as Record<string, unknown>;
        return (
          row.totalEarnings != null ||
          row.basicSalary != null ||
          row.grossSalary != null
        );
      }),
  );
  const excelTotals = canExcelTotals
    ? computePayrollExcelSummary(splitLines as Parameters<typeof computePayrollExcelSummary>[0])
    : null;
  const { cashTotal, fawryTotal } = excelTotals
    ? { cashTotal: excelTotals.cashTotal, fawryTotal: excelTotals.fawryTotal }
    : computePayrollCashFawryTotals(splitLines);
  const fawryCommission = excelTotals
    ? excelTotals.fawryCommission
    : Math.round(fawryTotal * 0.0015 * 100) / 100;
  const fawryGrandTotal = excelTotals
    ? excelTotals.fawryGrandTotal
    : Math.round((fawryTotal + fawryCommission) * 100) / 100;

  const data: Record<string, unknown> = {
    id: payroll.id,
    name: payroll.name ?? '',
    dateFrom: payroll.dateFrom.toISOString().slice(0, 10),
    dateTo: payroll.dateTo.toISOString().slice(0, 10),
    state: payroll.state,
    shiftGridId: payroll.shiftGridId ?? false,
    shiftGridName: gridLabel,
    shiftGridTitle,
    branchName,
    payrollScope: payroll.shiftGridId
      ? [shiftGridTitle, branchName].filter(Boolean).join(' — ') ||
        'جدول شيفتات محدد'
      : 'كل الموظفين (من بيانات البصمة)',
    isBranchScoped: Boolean(payroll.shiftGridId),
    deviceId: payroll.deviceId ?? false,
    totalGross: excelTotals?.totalEarnings ?? payroll.totalGross,
    totalEarnings: excelTotals?.totalEarnings ?? payroll.totalGross,
    totalNet: excelTotals?.totalNet ?? payroll.totalNet,
    totalDeductions: excelTotals?.totalDeductions ?? payroll.totalDeductions,
    grandTotal: excelTotals?.grandTotal ?? payroll.totalNet,
    storedTotalNet: payroll.totalNet,
    cashTotal,
    fawryTotal,
    fawryCommission,
    fawryGrandTotal,
    employeeCount,
    journalEntryId: (payroll as { journalEntryId?: string | null }).journalEntryId ?? false,
    odooMoveId: (payroll as { odooMoveId?: number | null }).odooMoveId ?? null,
    odooMoveName: (payroll as { odooMoveName?: string | null }).odooMoveName ?? '',
    odooPayrollJournalId:
      (payroll as { odooPayrollJournalId?: number | null }).odooPayrollJournalId ?? null,
    odooSentAt: (payroll as { odooSentAt?: Date | null }).odooSentAt?.toISOString() ?? null,
    odooSent: Boolean(
      (payroll as { odooPayrollJournalId?: number | null }).odooPayrollJournalId,
    ),
    showEditComparison: payroll.showEditComparison,
    editImportMessage: payroll.editImportMessage ?? '',
    comparisonTotalNetBefore: payroll.comparisonTotalNetBefore,
    comparisonTotalNetAfter: payroll.comparisonTotalNetAfter,
    excludedEmployeeCount: Array.isArray(
      (payroll as { excludedEmployeeIds?: string[] }).excludedEmployeeIds,
    )
      ? (payroll as { excludedEmployeeIds: string[] }).excludedEmployeeIds.length
      : 0,
    comparisonTotalNetDelta:
      Math.round(
        (payroll.comparisonTotalNetAfter - payroll.comparisonTotalNetBefore) *
          100,
      ) / 100,
    payablePeriodDays:
      (payroll as Payroll & { payablePeriodDays?: number }).payablePeriodDays,
    calculationSource: punchImportSource ? 'punch_report_import' : 'live_punch',
    punchImportSource: punchImportSource ?? null,
    excelImportedAt:
      (payroll as { excelImportedAt?: Date | null }).excelImportedAt?.toISOString() ??
      null,
    excelSourceLocked: Boolean(
      (payroll as { excelImportedAt?: Date | null }).excelImportedAt,
    ),
    ...(linkStats ?? {}),
  };
  if (includeLines && lines) {
    data.lines = lines.map(payrollLineJson);
  }
  return data;
}

/** Net totals by payment method — no Fawry commission (list / period headers). */
function computePayrollCashFawryTotals(
  lines?: Array<{
    netSalary?: number | null;
    employee?: {
      hasFawryAccount?: boolean | null;
      active?: boolean | null;
      departureDate?: Date | null;
      archivedAt?: Date | null;
      archiveReason?: string | null;
    } | null;
  }> | null,
): { cashTotal: number; fawryTotal: number } {
  let cash = 0;
  let fawry = 0;
  for (const line of lines ?? []) {
    const net = Number(line.netSalary ?? 0) || 0;
    if (isPayrollEmployeeResigned(line.employee) || !line.employee?.hasFawryAccount) {
      cash += net;
    } else {
      fawry += net;
    }
  }
  return {
    cashTotal: Math.round(cash * 100) / 100,
    fawryTotal: Math.round(fawry * 100) / 100,
  };
}

function isPayrollEmployeeResigned(
  emp?: {
    active?: boolean | null;
    departureDate?: Date | null;
    archivedAt?: Date | null;
    archiveReason?: string | null;
  } | null,
): boolean {
  if (!emp) return false;
  if (emp.active && !emp.departureDate) return false;
  if (!emp.active || emp.departureDate || emp.archivedAt) return true;
  const reason = String(emp.archiveReason ?? '');
  return /استقال|انهاء|إنهاء|انقطاع|ترك العمل|terminated|resign/i.test(reason);
}

export function payrollLineJson(
  line: PayrollLine & {
    employee?:
      | (EmployeeProfile & {
          department?: Department | null;
          workLocation?: Location | null;
        })
      | null;
  },
) {
  return {
    id: line.id,
    employeeId: line.employeeId,
    employeeCode: line.employeeCode ?? line.employee?.code ?? '',
    employeeName: line.employee?.name ?? '',
    nationalId: line.employee?.nationalIdConfirm ?? '',
    userId: line.employee?.userId ?? '',
    sequence: line.sequence,
    basicSalary: line.basicSalary,
    workingDays: line.workingDays,
    actualWorkingDays: line.actualWorkingDays,
    workDaysSalary: line.workDaysSalary,
    grossSalary: line.grossSalary,
    totalEarnings: line.totalEarnings || line.grossSalary,
    overtimeHours: line.overtimeHours,
    overtimeAmount: line.overtimeAmount,
    totalDeductions: line.totalDeductions,
    netSalary: line.netSalary,
    absentDays: line.absentDays,
    absentCount: line.absentCount ?? line.absentDays,
    sickDayCount: line.sickDayCount,
    leaveAbsenceDeductionValue: line.leaveAbsenceDeductionValue,
    editSnapshotSet: line.editSnapshotSet,
    editNetBefore: line.editNetBefore,
    editManualDedBefore: line.editManualDedBefore,
    editNetDelta: line.editSnapshotSet
      ? Math.round((line.netSalary - line.editNetBefore) * 100) / 100
      : 0,
    lateDeductibleDays: line.lateDeductibleDays,
    earnedLeave: line.earnedLeave,
    permissionCount: line.permissionCount,
    lateDeduction: line.lateDeduction,
    earlyDeduction: line.earlyDeduction,
    absentDeduction: line.absentDeduction,
    sickDeduction: line.sickDeduction,
    manualDebit: line.manualDebit,
    penaltyDeductionValue: line.penaltyDeductionValue,
    adminDeduction: line.adminDeduction || line.penaltyDeductionValue,
    fines: line.fines,
    deductionChecks: line.deductionChecks,
    groupedChecks: line.groupedChecks,
    healthCertificatesDeduction: line.healthCertificatesDeduction,
    fractionDeduction: line.fractionDeduction,
    documentsDeduction: line.documentsDeduction,
    socialInsurance: line.socialInsurance,
    medicalInsurance: line.medicalInsurance,
    advanceShortTotal: line.advanceShortTotal,
    advanceLongTotal: line.advanceLongTotal,
    punchDeductionCheckin: line.punchDeductionCheckin,
    punchDeductionCheckout: line.punchDeductionCheckout,
    lateCheckoutDeduction: line.lateCheckoutDeduction,
    singlePunchCount: line.singlePunchCount,
    lateDeductibleMinutes: line.lateDeductibleMinutes,
    earlyLeaveMinutes: line.earlyLeaveMinutes,
    offDayCount: line.offDayCount,
    daysCount: line.daysCount,
    totalNetHours: line.totalNetHours,
    departmentName:
      line.departmentName ?? line.employee?.department?.name ?? '',
    positionName: line.positionName ?? line.employee?.jobTitle ?? '',
    employeeLocation:
      line.employeeLocation ??
      line.employee?.workLocation?.name ??
      line.employee?.location ??
      '',
    previousSettlements: line.previousSettlements,
    previousInsurance: line.previousInsurance,
    notes: line.notes ?? '',
    attendanceDeduction: round2(
      (line.lateDeduction || 0) +
        (line.lateCheckoutDeduction || 0) +
        (line.earlyDeduction || 0) +
        (line.punchDeductionCheckin || 0) +
        (line.punchDeductionCheckout || 0),
    ),
    hoursDifference: round2(
      (line.workingDays || 0) * 8 - (line.totalNetHours || 0),
    ),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function deductionUiState(state: string): string {
  if (state === 'linked') return 'applied';
  if (state === 'draft') return 'pending';
  return state;
}

export function deductionJson(
  d: Deduction & {
    employee?: EmployeeProfile;
    device?: (Device & { location?: { id: string; name: string } | null }) | null;
  },
) {
  const typeLabel =
    DEDUCTION_TYPES.find((t) => t.value === d.type)?.label ?? d.type;
  const ref = d.reference?.trim() || d.id.slice(0, 8);
  const locationName =
    d.device?.location?.name?.trim() || d.device?.name || d.device?.alias || '';
  return {
    id: d.id,
    reference: d.reference ?? '',
    employeeId: d.employeeId,
    employeeName: d.employee?.name ?? '',
    employeeCode:
      d.employee?.code?.trim() ||
      d.employee?.identificationId?.trim() ||
      '',
    type: d.type,
    deductionType: d.type,
    deductionTypeLabel: typeLabel,
    amount: d.amount,
    appliedAmount: d.appliedAmount ?? 0,
    state: deductionUiState(d.state),
    date: d.date.toISOString().slice(0, 10),
    notes: d.notes ?? '',
    name: d.reference?.trim() || d.notes?.trim() || typeLabel,
    deviceId: d.deviceId ?? null,
    locationId: d.device?.location?.id ?? null,
    deviceName: locationName,
    locationName,
    payrollId: d.payrollId ?? null,
    payrollLineId: d.payrollLineId ?? null,
  };
}

export function advanceShortJson(
  a: AdvanceShort & {
    employee?: EmployeeProfile & {
      workLocation?: { id: string; name: string } | null;
    };
    loanImport?: {
      id: string;
      reference: string;
      date: Date;
    } | null;
  },
) {
  return {
    id: a.id,
    employeeId: a.employeeId,
    employeeName: a.employee?.name ?? '',
    employeeCode: a.employee?.code ?? '',
    employeeJobTitle: a.employee?.jobTitle ?? '',
    locationId: a.employee?.workLocation?.id ?? null,
    locationName: a.employee?.workLocation?.name ?? '',
    importId: a.loanImport?.id ?? null,
    importReference: a.loanImport?.reference ?? '',
    importDate: a.loanImport?.date.toISOString().slice(0, 10) ?? null,
    amount: a.amount,
    hasFawryAccount: a.employee?.hasFawryAccount === true || Boolean(a.employee?.fawryAccount?.trim()),
    state: a.state,
    isDeducted: a.isDeducted,
    payrollId: a.payrollId,
    date: a.date.toISOString().slice(0, 10),
    deductionStartDate: (a.deductionStartDate ?? a.date)
      .toISOString()
      .slice(0, 10),
    notes: a.notes ?? '',
    eligibilityPercent: a.eligibilityPercent ?? null,
    maxEligibleAtCreation: a.maxEligibleAtCreation ?? null,
    actualWorkingDaysAtCreation: a.actualWorkingDaysAtCreation ?? null,
    limitOverride: a.limitOverride ?? false,
    overrideReason: a.overrideReason ?? '',
  };
}

export function advanceLongJson(
  a: AdvanceLong & {
    employee?: EmployeeProfile;
    payments?: AdvanceLongPayment[];
  },
) {
  const amounts = computeLongAdvanceAmounts({
    ...a,
    payments: a.payments ?? [],
  });
  const paymentsWithPayroll = (a.payments ?? []) as {
    payroll?: { state?: PayrollState } | null;
  }[];
  return {
    id: a.id,
    employeeId: a.employeeId,
    employeeName: a.employee?.name ?? '',
    employeeCode: a.employee?.code ?? '',
    totalAmount: a.totalAmount,
    installmentAmount: amounts.installmentAmount,
    installments: a.installments,
    paidAmount: amounts.paidAmount,
    remainingAmount: amounts.remainingAmount,
    paidInstallments: amounts.paidInstallments,
    remainingInstallments: amounts.remainingInstallments,
    state: a.state,
    canEdit: longAdvanceCanEdit({
      state: a.state,
      isAccountingLocked: a.isAccountingLocked,
      payments: paymentsWithPayroll,
    }),
    canStop: longAdvanceCanStop({
      state: a.state,
      isAccountingLocked: a.isAccountingLocked,
      totalAmount: a.totalAmount,
      installmentAmount: a.installmentAmount,
      installments: a.installments,
      payments: a.payments ?? [],
    }),
    canAdjustRemaining: longAdvanceCanAdjustRemaining({
      state: a.state,
      isAccountingLocked: a.isAccountingLocked,
      totalAmount: a.totalAmount,
      installmentAmount: a.installmentAmount,
      installments: a.installments,
      payments: a.payments ?? [],
    }),
    date: a.date.toISOString().slice(0, 10),
    startDate:
      a.startDate?.toISOString().slice(0, 10) ??
      a.date.toISOString().slice(0, 10),
    nextDeductionDate: a.nextDeductionDate?.toISOString().slice(0, 10) ?? null,
    notes: a.notes ?? '',
    eligibilityPercent: a.eligibilityPercent ?? null,
    maxEligibleAtCreation: a.maxEligibleAtCreation ?? null,
    actualWorkingDaysAtCreation: a.actualWorkingDaysAtCreation ?? null,
    limitOverride: a.limitOverride ?? false,
    overrideReason: a.overrideReason ?? '',
    odooAdvanceLongId: a.odooAdvanceLongId ?? null,
    odooAccountsSendId: a.odooAccountsSendId ?? null,
    odooMoveId: a.odooMoveId ?? null,
    odooMoveName: a.odooMoveName ?? '',
    odooSentAt: a.odooSentAt?.toISOString() ?? null,
    odooSyncError: a.odooSyncError ?? '',
  };
}

export const DEDUCTION_TYPES = [
  { value: 'manual_debit', label: 'مانيول ديبت' },
  { value: 'grouped_checks', label: 'شيكات مجمعة' },
  { value: 'personal_checks', label: 'شيكات شخصية' },
  { value: 'check', label: 'شيك' },
  { value: 'health_certificates', label: 'شهادات صحية' },
  { value: 'fraction', label: 'كسر' },
  { value: 'fines', label: 'غرامات' },
  { value: 'documents', label: 'خصم أوراق' },
  { value: 'admin', label: 'خصم إداري' },
  { value: 'previous_settlements', label: 'تسويات سابقة' },
  { value: 'previous_insurance', label: 'تأمينات سابقة' },
];
