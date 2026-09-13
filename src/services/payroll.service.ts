import { PayrollState, PunchReportImportState, Payroll, PayrollLine, EmployeeProfile, Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import { NotFoundError, AppError } from '../utils/errors';
import { generatePunchReport, calculateEmployeePayrollFromLines } from './punchReport.service';
import { getLatePolicy } from './latePolicy.service';
import { getPayablePeriodPolicy, resolvePayablePeriodDays } from './payablePeriod.service';
import { exportFawryXlsx } from './payrollExport.service';
import { recalculatePayrollLineTotals, refreshPayrollHeaderTotals, round2, fixBasicSalarySingle, getManualPayrollEmployeeIds, getExcludedPayrollEmployeeIds, clearExcludedPayrollEmployees, deleteNonManualPayrollLines, maxPayrollLineSequence } from './payrollLine.service';
import { shouldSkipPunchRebuild } from './payrollExclusion.service';
import {
  revertAdvancesOnPayroll,
  applyAdvancesForLine,
  confirmAdvancesOnPayroll,
} from './advances.service';
import { fixPenaltyValues, linkDeductionsToPayroll, revertDeductionsOnPayroll } from './payrollDeductions.service';
import { payrollLineJson } from './serialize.service';
import { utcDateOnly, periodDays, effectivePayrollEnd } from '../utils/payrollPeriod';

export { utcDateOnly, periodDays, effectivePayrollEnd };

export async function listPayrolls(options?: { limit?: number; offset?: number; state?: PayrollState }) {
  const limit = options?.limit;
  const offset = options?.offset ?? 0;
  return prisma.payroll.findMany({
    where: options?.state ? { state: options.state } : undefined,
    orderBy: [{ dateTo: 'desc' }, { dateFrom: 'desc' }, { createdAt: 'desc' }],
    include: {
      shiftGrid: { include: { location: true } },
      _count: { select: { lines: true } },
      lines: {
        include: {
          employee: {
            select: {
              hasFawryAccount: true,
              active: true,
              departureDate: true,
              archivedAt: true,
              archiveReason: true,
              basicSalary: true,
              insuranceSalary: true,
              medicalInsuranceSalary: true,
              workPhone: true,
              fawryAccount: true,
            },
          },
        },
      },
      punchReportImports: {
        where: { state: PunchReportImportState.applied },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      },
    },
    ...(limit != null ? { take: limit, skip: offset } : {}),
  });
}

export async function countPayrolls(state?: PayrollState) {
  return prisma.payroll.count({ where: state ? { state } : undefined });
}

type PayrollLineWithEmployee = PayrollLine & { employee: EmployeeProfile };

export type PayrollWithLines = Payroll & {
  lines: PayrollLineWithEmployee[];
  linePagination: {
    total: number;
    limit: number;
    offset: number;
    count: number;
    hasMore: boolean;
  } | null;
  payablePeriodDays?: number;
};

export async function getPayroll(
  id: string,
  options?: { includeLines?: boolean; lineLimit?: number; lineOffset?: number; lineSearch?: string },
): Promise<PayrollWithLines> {
  const includeLines = options?.includeLines !== false;
  const lineLimit = options?.lineLimit;
  const lineOffset = options?.lineOffset ?? 0;
  const lineSearch = options?.lineSearch?.trim() || undefined;
  const lineWhere = buildPayrollLineWhere(id, lineSearch);
  const [payablePolicy] = await Promise.all([getPayablePeriodPolicy()]);

  const attachPeriodMeta = <T extends Payroll>(row: T): T & { payablePeriodDays: number } => ({
    ...row,
    payablePeriodDays: resolvePayablePeriodDays(row.dateFrom, row.dateTo, payablePolicy),
  });

  if (!includeLines) {
    const payroll = await prisma.payroll.findUnique({
      where: { id },
      include: { shiftGrid: { include: { location: true } }, _count: { select: { lines: true } } },
    });
    if (!payroll) throw new NotFoundError('Payroll not found');
    return { ...attachPeriodMeta(payroll), lines: [] as PayrollLineWithEmployee[], linePagination: null };
  }

  if (lineLimit != null) {
    const payroll = await prisma.payroll.findUnique({
      where: { id },
      include: { shiftGrid: { include: { location: true } } },
    });
    if (!payroll) throw new NotFoundError('Payroll not found');
    const [lineTotal, lines] = await Promise.all([
      prisma.payrollLine.count({ where: lineWhere }),
      prisma.payrollLine.findMany({
        where: lineWhere,
        include: { employee: { include: { department: true, workLocation: true } } },
        orderBy: { sequence: 'asc' },
        take: lineLimit,
        skip: lineOffset,
      }),
    ]);
    return {
      ...attachPeriodMeta(payroll),
      lines: lines as PayrollLineWithEmployee[],
      linePagination: {
        total: lineTotal,
        limit: lineLimit,
        offset: lineOffset,
        count: lines.length,
        hasMore: lineOffset + lines.length < lineTotal,
      },
    };
  }

  const payroll = await prisma.payroll.findUnique({
    where: { id },
    include: {
      shiftGrid: { include: { location: true } },
      _count: { select: { lines: true } },
      lines: {
        where: lineSearch ? lineWhere : undefined,
        include: { employee: { include: { department: true, workLocation: true } } },
        orderBy: { sequence: 'asc' },
      },
    },
  });
  if (!payroll) throw new NotFoundError('Payroll not found');
  return { ...attachPeriodMeta(payroll), linePagination: null } as PayrollWithLines;
}

function buildPayrollLineWhere(payrollId: string, search?: string): Prisma.PayrollLineWhereInput {
  const where: Prisma.PayrollLineWhereInput = { payrollId };
  if (!search) return where;
  where.OR = [
    { employeeCode: { contains: search, mode: 'insensitive' } },
    { employeeId: search },
    { employee: { userId: search } },
    { employee: { code: { contains: search, mode: 'insensitive' } } },
    { employee: { identificationId: { contains: search, mode: 'insensitive' } } },
    { employee: { name: { contains: search, mode: 'insensitive' } } },
    { employee: { nationalIdConfirm: { contains: search } } },
  ];
  return where;
}

async function loadEmployeeMeta(employeeId: string) {
  return prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    include: { department: true, workLocation: true },
  });
}

function employeeMetaFields(employee: Awaited<ReturnType<typeof loadEmployeeMeta>>) {
  if (!employee) return {};
  return {
    departmentName: employee.department?.name ?? '',
    positionName: employee.jobTitle ?? '',
    employeeLocation: employee.workLocation?.name ?? employee.location ?? '',
  };
}

export async function createPayroll(params: {
  dateFrom?: string;
  dateTo?: string;
  shiftGridId?: string;
  deviceId?: string;
  name?: string;
}) {
  let dateFrom = params.dateFrom?.trim();
  let dateTo = params.dateTo?.trim();
  let deviceId = params.deviceId ? String(params.deviceId) : undefined;
  let gridName = '';

  if (params.shiftGridId) {
    const grid = await prisma.shiftGrid.findUnique({
      where: { id: params.shiftGridId },
      include: { location: true },
    });
    if (!grid) throw new NotFoundError('جدول الشيفتات غير موجود');
    if (!dateFrom || dateFrom === 'undefined') {
      dateFrom = grid.dateFrom.toISOString().slice(0, 10);
    }
    if (!dateTo || dateTo === 'undefined') {
      dateTo = grid.dateTo.toISOString().slice(0, 10);
    }
    if (!deviceId && grid.deviceId) deviceId = grid.deviceId;
    gridName = grid.name?.trim() || grid.location?.name?.trim() || '';
  }

  if (!dateFrom || !dateTo || dateFrom === 'undefined' || dateTo === 'undefined') {
    throw new AppError('يجب تحديد فترة الكشف', 400, 'VALIDATION');
  }

  const payrollName = params.name?.trim()
    || (gridName
      ? `Payroll ${gridName} ${dateFrom} - ${dateTo}`
      : `Payroll ${dateFrom} - ${dateTo}`);

  return prisma.payroll.create({
    data: {
      name: payrollName,
      dateFrom: new Date(dateFrom),
      dateTo: new Date(dateTo),
      shiftGridId: params.shiftGridId,
      deviceId,
      state: PayrollState.draft,
    },
    include: { shiftGrid: { include: { location: true } } },
  });
}

/** After payroll Excel import, calculate must not rebuild from punch — only link advances/deductions. */
export function isPayrollExcelSourceLocked(
  payroll: { excelImportedAt?: Date | null },
): boolean {
  return Boolean(payroll.excelImportedAt);
}

export async function calculatePayroll(payrollId: string) {
  const payroll = await getPayroll(payrollId, { includeLines: false });
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن إعادة حساب كشف مؤكد', 400, 'ACTION_ERROR');
  }

  // Last payroll Excel import is source of truth for line amounts until punch reimport clears the flag.
  if (isPayrollExcelSourceLocked(payroll)) {
    await linkDeductionsAndAdvances(payrollId);
    return prisma.payroll.update({
      where: { id: payrollId },
      data: { state: PayrollState.calculated },
      include: { lines: { include: { employee: true }, orderBy: { sequence: 'asc' } } },
    });
  }

  const { getAppliedPunchImportForPayroll, rebuildPayrollFromPunchImport } =
    await import('./punchReportImport.service');
  const punchImport = await getAppliedPunchImportForPayroll(payrollId);
  if (punchImport) {
    const { lineCount } = await rebuildPayrollFromPunchImport(payrollId, punchImport);
    const remaining = await prisma.payrollLine.count({ where: { payrollId } });
    if (!remaining && !lineCount) {
      throw new AppError('لا توجد بيانات في تقرير البصمات المرجعي', 400, 'ACTION_ERROR');
    }
    await linkDeductionsAndAdvances(payrollId);
    return prisma.payroll.update({
      where: { id: payrollId },
      data: { state: PayrollState.calculated },
      include: { lines: { include: { employee: true }, orderBy: { sequence: 'asc' } } },
    });
  }

  let employeeIds: string[] | undefined;

  if (payroll.shiftGridId) {
    const gridLines = await prisma.shiftGridLine.findMany({
      where: { gridId: payroll.shiftGridId },
      select: { employeeId: true },
    });
    employeeIds = [...new Set(gridLines.map((l) => l.employeeId))];
  }

  // includeInactive so archived employees still get punches through their archive day
  const punchLines = await generatePunchReport(
    payroll.dateFrom,
    payroll.dateTo,
    employeeIds,
    payroll.shiftGridId ?? undefined,
    true,
  );
  const latePolicy = await getLatePolicy();
  const payablePolicy = await getPayablePeriodPolicy();
  const byEmployee = new Map<string, typeof punchLines>();
  for (const line of punchLines) {
    if (!line.employeeId) continue;
    const arr = byEmployee.get(line.employeeId) ?? [];
    arr.push(line);
    byEmployee.set(line.employeeId, arr);
  }

  if (!byEmployee.size) {
    throw new AppError('لا توجد بيانات بصمة في الفترة المحددة', 400, 'ACTION_ERROR');
  }

  await revertAdvancesOnPayroll(payrollId);
  await revertDeductionsOnPayroll(payrollId);
  const manualEmployeeIds = await getManualPayrollEmployeeIds(payrollId);
  const excludedEmployeeIds = await getExcludedPayrollEmployeeIds(payrollId);
  await deleteNonManualPayrollLines(payrollId);

  let seq = await maxPayrollLineSequence(payrollId);

  for (const [employeeId, allLines] of byEmployee) {
    if (shouldSkipPunchRebuild(employeeId, manualEmployeeIds, excludedEmployeeIds)) continue;
    const employee = await loadEmployeeMeta(employeeId);
    if (!employee) continue;

    const effectiveEnd = effectivePayrollEnd(payroll.dateFrom, payroll.dateTo, employee);
    if (!effectiveEnd) continue;

    const endMs = utcDateOnly(effectiveEnd).getTime();
    const lines = allLines.filter((l) => utcDateOnly(l.punchDate).getTime() <= endMs);
    if (!lines.length) continue;

    const isCut = utcDateOnly(effectiveEnd).getTime() < utcDateOnly(payroll.dateTo).getTime();
    const daysCount = periodDays(payroll.dateFrom, effectiveEnd);
    const periodBaseDays = isCut
      ? daysCount
      : resolvePayablePeriodDays(payroll.dateFrom, payroll.dateTo, payablePolicy);

    const calc = calculateEmployeePayrollFromLines(
      lines,
      employee.basicSalary,
      periodBaseDays,
      latePolicy,
      payablePolicy.absentForgivenDaysCount,
    );
    const lineBase = {
      payrollId,
      employeeId,
      sequence: seq + 1,
      employeeCode: employee.code,
      basicSalary: employee.basicSalary,
      workingDays: calc.workingDays,
      actualWorkingDays: calc.actualWorkingDays,
      workDaysSalary: calc.workDaysSalary,
      grossSalary: calc.grossSalary,
      totalEarnings: calc.totalEarnings,
      overtimeHours: calc.overtimeHours,
      overtimeAmount: calc.overtimeAmount,
      totalDeductions: 0,
      netSalary: 0,
      absentDays: calc.absentDays,
      absentCount: calc.absentDays,
      sickDayCount: calc.sickDayCount,
      leaveAbsenceDeductionValue: 0,
      lateDeductibleDays: calc.lateDeductibleDays,
      lateDeductibleMinutes: calc.lateDeductibleMinutes,
      earnedLeave: calc.earnedLeave,
      permissionCount: calc.permissionCount,
      lateDeduction: calc.lateDeduction,
      earlyDeduction: calc.earlyDeduction,
      absentDeduction: calc.absentDeduction,
      sickDeduction: calc.sickDeduction,
      punchDeductionCheckin: calc.punchDeductionCheckin,
      punchDeductionCheckout: calc.punchDeductionCheckout,
      lateCheckoutDeduction: calc.lateCheckoutDeduction,
      singlePunchCount: calc.singlePunchCount,
      earlyLeaveMinutes: calc.earlyLeaveMinutes,
      totalNetHours: calc.totalNetHours,
      offDayCount: calc.offDayCount,
      daysCount,
      manualDebit: 0,
      penaltyDeductionValue: 0,
      adminDeduction: 0,
      fines: 0,
      deductionChecks: 0,
      groupedChecks: 0,
      healthCertificatesDeduction: 0,
      fractionDeduction: 0,
      documentsDeduction: 0,
      socialInsurance: employee.insuranceSalary,
      medicalInsurance: employee.medicalInsuranceSalary,
      advanceShortTotal: 0,
      advanceLongTotal: 0,
      previousSettlements: 0,
      previousInsurance: 0,
      notes: null,
      ...employeeMetaFields(employee),
    };
    const totals = recalculatePayrollLineTotals(lineBase as PayrollLine, {
      socialInsurance: employee.insuranceSalary,
      medicalInsurance: employee.medicalInsuranceSalary,
    });

    seq++;
    await prisma.payrollLine.create({
      data: {
        ...lineBase,
        sequence: seq,
        workDaysSalary: totals.workDaysSalary,
        overtimeAmount: totals.overtimeAmount,
        totalEarnings: totals.totalEarnings,
        grossSalary: totals.grossSalary,
        totalDeductions: totals.totalDeductions,
        netSalary: totals.netSalary,
      },
    });
  }

  await linkDeductionsAndAdvances(payrollId);

  return prisma.payroll.update({
    where: { id: payrollId },
    data: { state: PayrollState.calculated },
    include: { lines: { include: { employee: true }, orderBy: { sequence: 'asc' } } },
  });
}

export async function calculateSingleEmployee(payrollId: string, employeeId: string) {
  const payroll = await getPayroll(payrollId, { includeLines: false });
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن إضافة موظف لكشف مؤكد', 400, 'ACTION_ERROR');
  }

  const conflict = await prisma.payrollLine.findUnique({
    where: { payrollId_employeeId: { payrollId, employeeId } },
  });
  if (conflict) {
    throw new AppError('الموظف موجود بالفعل في هذا الكشف', 400, 'ACTION_ERROR');
  }

  await clearExcludedPayrollEmployees(payrollId, [employeeId]);

  const punchLines = await generatePunchReport(
    payroll.dateFrom,
    payroll.dateTo,
    [employeeId],
    payroll.shiftGridId ?? undefined,
    true,
  );
  const employee = await loadEmployeeMeta(employeeId);
  if (!employee) throw new NotFoundError('Employee not found');

  const effectiveEnd = effectivePayrollEnd(payroll.dateFrom, payroll.dateTo, employee);
  if (!effectiveEnd) {
    throw new AppError('الموظف مؤرشف قبل فترة هذا الكشف', 400, 'ACTION_ERROR');
  }
  const endMs = utcDateOnly(effectiveEnd).getTime();
  const empLines = punchLines.filter(
    (l) => l.employeeId === employeeId && utcDateOnly(l.punchDate).getTime() <= endMs,
  );
  if (!empLines.length) {
    throw new AppError('لا توجد بيانات بصمة للموظف في الفترة المحددة', 400, 'ACTION_ERROR');
  }

  const isCut = utcDateOnly(effectiveEnd).getTime() < utcDateOnly(payroll.dateTo).getTime();
  const daysCount = periodDays(payroll.dateFrom, effectiveEnd);
  const periodBaseDays = isCut ? daysCount : undefined;
  const calc = calculateEmployeePayrollFromLines(
    empLines,
    employee.basicSalary,
    periodBaseDays,
    await getLatePolicy(),
  );
  const maxSeq = await prisma.payrollLine.aggregate({
    where: { payrollId },
    _max: { sequence: true },
  });
  const seq = (maxSeq._max.sequence ?? 0) + 1;

  const lineBase = {
    payrollId,
    employeeId,
    sequence: seq,
    employeeCode: employee.code,
    basicSalary: employee.basicSalary,
    workingDays: calc.workingDays,
    actualWorkingDays: calc.actualWorkingDays,
    workDaysSalary: calc.workDaysSalary,
    grossSalary: calc.grossSalary,
    totalEarnings: calc.totalEarnings,
    overtimeHours: calc.overtimeHours,
    overtimeAmount: calc.overtimeAmount,
    totalDeductions: 0,
    netSalary: 0,
    absentDays: calc.absentDays,
    absentCount: calc.absentDays,
    sickDayCount: calc.sickDayCount,
    leaveAbsenceDeductionValue: 0,
    lateDeductibleDays: calc.lateDeductibleDays,
    lateDeductibleMinutes: calc.lateDeductibleMinutes,
    earnedLeave: calc.earnedLeave,
    permissionCount: calc.permissionCount,
    lateDeduction: calc.lateDeduction,
    earlyDeduction: calc.earlyDeduction,
    absentDeduction: calc.absentDeduction,
    sickDeduction: calc.sickDeduction,
    punchDeductionCheckin: calc.punchDeductionCheckin,
    punchDeductionCheckout: calc.punchDeductionCheckout,
    lateCheckoutDeduction: calc.lateCheckoutDeduction,
    singlePunchCount: calc.singlePunchCount,
    earlyLeaveMinutes: calc.earlyLeaveMinutes,
    totalNetHours: calc.totalNetHours,
    offDayCount: calc.offDayCount,
    daysCount,
    manualDebit: 0,
    penaltyDeductionValue: 0,
    adminDeduction: 0,
    fines: 0,
    deductionChecks: 0,
    groupedChecks: 0,
    healthCertificatesDeduction: 0,
    fractionDeduction: 0,
    documentsDeduction: 0,
    socialInsurance: employee.insuranceSalary,
    medicalInsurance: employee.medicalInsuranceSalary,
    advanceShortTotal: 0,
    advanceLongTotal: 0,
    previousSettlements: 0,
    previousInsurance: 0,
    notes: null,
    ...employeeMetaFields(employee),
  };

  const totals = recalculatePayrollLineTotals(lineBase as PayrollLine, {
    socialInsurance: employee.insuranceSalary,
    medicalInsurance: employee.medicalInsuranceSalary,
  });

  await prisma.payrollLine.create({
    data: {
      ...lineBase,
      workDaysSalary: totals.workDaysSalary,
      overtimeAmount: totals.overtimeAmount,
      totalEarnings: totals.totalEarnings,
      grossSalary: totals.grossSalary,
      totalDeductions: totals.totalDeductions,
      netSalary: totals.netSalary,
    },
  });

  await linkDeductionsAndAdvances(payrollId);

  return prisma.payroll.update({
    where: { id: payrollId },
    data: { state: PayrollState.calculated },
    include: { lines: { include: { employee: true }, orderBy: { sequence: 'asc' } } },
  });
}

export async function linkAdvancesToPayroll(payrollId: string) {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن تعديل كشف رواتب مؤكد', 400, 'ACTION_ERROR');
  }

  await revertAdvancesOnPayroll(payrollId);
  const lines = await prisma.payrollLine.findMany({ where: { payrollId } });

  for (const line of lines) {
    const { shortTotal, longTotal } = await applyAdvancesForLine(payroll, line);
    const merged = { ...line, advanceShortTotal: shortTotal, advanceLongTotal: longTotal };
    const employee = await loadEmployeeMeta(line.employeeId);
    const totals = recalculatePayrollLineTotals(merged, {
      socialInsurance: employee?.insuranceSalary ?? line.socialInsurance,
      medicalInsurance: employee?.medicalInsuranceSalary ?? line.medicalInsurance,
    });
    await prisma.payrollLine.update({
      where: { id: line.id },
      data: {
        advanceShortTotal: shortTotal,
        advanceLongTotal: longTotal,
        totalEarnings: totals.totalEarnings,
        grossSalary: totals.grossSalary,
        totalDeductions: totals.totalDeductions,
        netSalary: totals.netSalary,
      },
    });
  }

  return refreshPayrollHeaderTotals(payrollId);
}

export async function linkDeductionsOnly(payrollId: string, options?: { allowConfirmed?: boolean }) {
  await linkDeductionsToPayroll(payrollId, options);
  return getPayroll(payrollId);
}

export async function linkDeductionsAndAdvances(payrollId: string, options?: { allowConfirmed?: boolean }) {
  if (!options?.allowConfirmed) {
    await linkAdvancesToPayroll(payrollId);
  }
  await linkDeductionsToPayroll(payrollId, options);
  return getPayroll(payrollId);
}

export async function backToDraft(payrollId: string) {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state !== PayrollState.calculated) {
    throw new AppError('يمكن الرجوع للمسودة من حالة «محسوب» فقط', 400, 'ACTION_ERROR');
  }
  return prisma.payroll.update({
    where: { id: payrollId },
    data: { state: PayrollState.draft },
    include: { lines: { include: { employee: true } } },
  });
}

export async function syncEmployeeInfo(payrollId: string) {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن تعديل كشف رواتب مؤكد', 400, 'ACTION_ERROR');
  }

  const lines = await prisma.payrollLine.findMany({ where: { payrollId } });
  let updated = 0;
  for (const line of lines) {
    const employee = await loadEmployeeMeta(line.employeeId);
    if (!employee) continue;
    const meta = employeeMetaFields(employee);
    await prisma.payrollLine.update({
      where: { id: line.id },
      data: {
        employeeCode: employee.code,
        ...meta,
      },
    });
    updated++;
  }
  return { updated, message: `تم تحديث بيانات ${updated} موظف` };
}

export async function recalculateBasicSalary(payrollId: string) {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state !== PayrollState.calculated) {
    throw new AppError('يجب أن يكون الكشف في حالة «محسوب»', 400, 'ACTION_ERROR');
  }

  const lines = await prisma.payrollLine.findMany({ where: { payrollId } });
  let updated = 0;
  for (const line of lines) {
    const employee = await prisma.employeeProfile.findUnique({ where: { id: line.employeeId } });
    if (!employee?.basicSalary) continue;
    const merged = { ...line, basicSalary: employee.basicSalary };
    const totals = recalculatePayrollLineTotals(merged, {
      socialInsurance: employee.insuranceSalary,
      medicalInsurance: employee.medicalInsuranceSalary,
    });
    await prisma.payrollLine.update({
      where: { id: line.id },
      data: {
        basicSalary: employee.basicSalary,
        workDaysSalary: totals.workDaysSalary,
        overtimeAmount: totals.overtimeAmount,
        totalEarnings: totals.totalEarnings,
        grossSalary: totals.grossSalary,
        totalDeductions: totals.totalDeductions,
        netSalary: totals.netSalary,
      },
    });
    updated++;
  }

  await revertAdvancesOnPayroll(payrollId);
  await linkAdvancesToPayroll(payrollId);
  await refreshPayrollHeaderTotals(payrollId);
  return { updated, message: `تم تحديث الراتب الأساسي لـ ${updated} موظف` };
}

export async function recalculateAdvancesOnly(payrollId: string) {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن تعديل كشف رواتب مؤكد', 400, 'ACTION_ERROR');
  }
  await linkAdvancesToPayroll(payrollId);
  return { message: 'تم إعادة تطبيق السلف' };
}

export async function checkPayrollDuplicates(payrollId: string) {
  const lines = await prisma.payrollLine.findMany({
    where: { payrollId },
    include: { employee: true },
  });
  const byEmployee = new Map<string, typeof lines>();
  for (const line of lines) {
    const list = byEmployee.get(line.employeeId) ?? [];
    list.push(line);
    byEmployee.set(line.employeeId, list);
  }
  const duplicates = [...byEmployee.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([employeeId, rows]) => ({
      employeeId,
      employeeCode: rows[0]?.employeeCode ?? '',
      employeeName: rows[0]?.employee?.name ?? '',
      count: rows.length,
    }));
  return { duplicates, count: duplicates.length };
}

/** Odoo _compute_payroll_link_counts */
export async function getPayrollLinkStats(payrollId: string) {
  const [deductions, shorts, longPayments] = await Promise.all([
    prisma.deduction.findMany({ where: { payrollId }, select: { amount: true } }),
    prisma.advanceShort.findMany({ where: { payrollId }, select: { amount: true } }),
    prisma.advanceLongPayment.findMany({ where: { payrollId }, select: { amount: true } }),
  ]);
  return {
    deductionCount: deductions.length,
    deductionTotalAmount: round2(deductions.reduce((s, d) => s + (d.amount || 0), 0)),
    shortAdvanceCount: shorts.length,
    shortAdvanceTotalAmount: round2(shorts.reduce((s, a) => s + (a.amount || 0), 0)),
    longAdvanceCount: longPayments.length,
    longAdvanceTotalAmount: round2(longPayments.reduce((s, p) => s + (p.amount || 0), 0)),
  };
}

export async function confirmPayroll(payrollId: string) {
  await confirmAdvancesOnPayroll(payrollId);
  // Lock Cash/Fawry classification so later archives don't move people between sheets.
  const { freezePayrollPaymentMethods } = await import('./payrollExport.service');
  await freezePayrollPaymentMethods(payrollId, { overwrite: true });
  return prisma.payroll.update({
    where: { id: payrollId },
    data: { state: PayrollState.confirmed },
    include: { lines: { include: { employee: true } } },
  });
}

export async function finalizePayroll(payrollId: string) {
  const payroll = await confirmPayroll(payrollId);
  const journalSkipped = true;
  const journalEntryId: string | false = false;

  const updated = await prisma.payroll.update({
    where: { id: payrollId },
    data: { journalEntryId: null },
    include: { lines: { include: { employee: true }, orderBy: { sequence: 'asc' } } },
  });
  return { payroll: updated, journalSkipped, journalEntryId };
}

export async function exportFawry(payrollId: string): Promise<{ base64: string; filename: string }> {
  return exportFawryXlsx(payrollId);
}

export async function myPayroll(userId: string) {
  const profile = await prisma.employeeProfile.findFirst({ where: { userId } });
  if (!profile) return [];

  const lines = await prisma.payrollLine.findMany({
    where: {
      employeeId: profile.id,
      payroll: { state: { in: [PayrollState.calculated, PayrollState.confirmed] } },
    },
    include: { payroll: true, employee: { include: { department: true, workLocation: true } } },
    orderBy: { payroll: { dateTo: 'desc' } },
    take: 24,
  });

  return lines.map((l) => {
    const dateFrom = l.payroll.dateFrom.toISOString().slice(0, 10);
    const dateTo = l.payroll.dateTo.toISOString().slice(0, 10);
    const line = payrollLineJson(l);
    return {
      payrollId: l.payrollId,
      payrollName: l.payroll.name ?? '',
      name: l.payroll.name ?? '',
      dateFrom,
      dateTo,
      periodFrom: dateFrom,
      periodTo: dateTo,
      state: l.payroll.state,
      netSalary: l.netSalary,
      grossSalary: l.grossSalary,
      employeeName: l.employee?.name ?? '',
      line,
    };
  });
}

export { fixPenaltyValues, fixBasicSalarySingle };
