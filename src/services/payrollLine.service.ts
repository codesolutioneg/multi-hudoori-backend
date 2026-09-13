import { PayrollLine } from '@prisma/client';
import { prisma } from '../prisma/client';
import { NotFoundError, AppError } from '../utils/errors';
import { mergePayrollExcludedIds } from './payrollExclusion.service';

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Odoo _admin_penalty_money — admin_deduction field stores days */
export function adminPenaltyMoney(basicSalary: number, adminDeductionDays: number): number {
  const daily = basicSalary / 30;
  return round2(daily * (adminDeductionDays || 0));
}

/** Odoo biotime.payroll.line _compute_total_deductions */
export function recalculatePayrollLineTotals(
  line: PayrollLine,
  options?: { socialInsurance?: number | null; medicalInsurance?: number | null },
): {
  totalEarnings: number;
  totalDeductions: number;
  netSalary: number;
  grossSalary: number;
  workDaysSalary: number;
  overtimeAmount: number;
} {
  const daily = line.basicSalary / 30;
  const workDaysSalary = line.workDaysSalary || round2(daily * (line.workingDays ?? 0));
  const overtimeAmount = line.overtimeAmount || round2(daily * (line.overtimeHours ?? 0));
  const totalEarnings = round2(workDaysSalary + overtimeAmount);

  const attendanceDed = round2(
    (line.lateDeduction || 0) +
      (line.lateCheckoutDeduction || 0) +
      (line.earlyDeduction || 0) +
      (line.punchDeductionCheckin || 0) +
      (line.punchDeductionCheckout || 0) +
      (line.absentDeduction || 0) +
      (line.sickDeduction || 0),
  );

  const adminPenalty = adminPenaltyMoney(line.basicSalary, line.adminDeduction || 0);

  const socialInsurance = options?.socialInsurance != null && options.socialInsurance > 0
    ? options.socialInsurance
    : (line.socialInsurance || 0);
  const medicalInsurance = options?.medicalInsurance != null && options.medicalInsurance > 0
    ? options.medicalInsurance
    : (line.medicalInsurance || 0);

  const manualDed = round2(
    socialInsurance +
      medicalInsurance +
      (line.penaltyDeductionValue || 0) +
      adminPenalty +
      (line.manualDebit || 0) +
      (line.fines || 0) +
      (line.deductionChecks || 0) +
      (line.groupedChecks || 0) +
      (line.healthCertificatesDeduction || 0) +
      (line.fractionDeduction || 0) +
      (line.documentsDeduction || 0) +
      (line.previousSettlements || 0) +
      (line.previousInsurance || 0),
  );

  const advances = (line.advanceShortTotal || 0) + (line.advanceLongTotal || 0);
  const totalDeductions = round2(attendanceDed + manualDed + advances);
  const netSalary = Math.max(0, round2(totalEarnings - totalDeductions));

  return {
    totalEarnings,
    totalDeductions,
    netSalary,
    grossSalary: totalEarnings,
    workDaysSalary,
    overtimeAmount,
  };
}

/** Excess when deductions exceed earnings (0 when net would be non-negative). */
export function overDeductionExcess(totalEarnings: number, totalDeductions: number): number {
  return Math.max(0, round2(totalDeductions - totalEarnings));
}

export function isOverDeductedLine(line: {
  totalEarnings: number;
  totalDeductions: number;
}): boolean {
  return line.totalDeductions > line.totalEarnings + 0.005;
}

export type OverDeductedPayrollLine = {
  lineId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  totalEarnings: number;
  totalDeductions: number;
  excess: number;
  netSalary: number;
};

/** Employees whose deductions exceed earnings (stored net is clamped to 0). */
export async function findOverDeductedPayrollLines(
  payrollId: string,
): Promise<OverDeductedPayrollLine[]> {
  const lines = await prisma.payrollLine.findMany({
    where: { payrollId },
    include: { employee: { select: { name: true, code: true } } },
    orderBy: { sequence: 'asc' },
  });
  return lines
    .filter((l) => isOverDeductedLine(l))
    .map((l) => ({
      lineId: l.id,
      employeeId: l.employeeId,
      employeeCode: l.employeeCode || l.employee?.code || '',
      employeeName: l.employee?.name || '',
      totalEarnings: round2(l.totalEarnings),
      totalDeductions: round2(l.totalDeductions),
      excess: overDeductionExcess(l.totalEarnings, l.totalDeductions),
      netSalary: round2(l.netSalary),
    }));
}

export async function refreshPayrollHeaderTotals(payrollId: string) {
  const lines = await prisma.payrollLine.findMany({ where: { payrollId } });
  const totals = lines.reduce(
    (acc, l) => ({
      gross: acc.gross + l.grossSalary,
      net: acc.net + l.netSalary,
      deductions: acc.deductions + l.totalDeductions,
    }),
    { gross: 0, net: 0, deductions: 0 },
  );
  return prisma.payroll.update({
    where: { id: payrollId },
    data: {
      totalGross: round2(totals.gross),
      totalNet: round2(totals.net),
      totalDeductions: round2(totals.deductions),
    },
  });
}

export const EDIT_MANUAL_DED_FIELDS = [
  'deductionChecks',
  'manualDebit',
  'healthCertificatesDeduction',
  'fractionDeduction',
  'fines',
  'documentsDeduction',
] as const;

export function manualDedTotal(line: PayrollLine): number {
  return round2(
    EDIT_MANUAL_DED_FIELDS.reduce((s, k) => s + (Number(line[k]) || 0), 0),
  );
}

export async function updatePayrollLine(lineId: string, fields: Record<string, unknown>) {
  const existing = await prisma.payrollLine.findUnique({
    where: { id: lineId },
    include: { employee: true },
  });
  if (!existing) throw new NotFoundError('Payroll line not found');

  const numericKeys = [
    'basicSalary',
    'workingDays',
    'overtimeHours',
    'manualDebit',
    'fines',
    'deductionChecks',
    'groupedChecks',
    'healthCertificatesDeduction',
    'fractionDeduction',
    'documentsDeduction',
    'socialInsurance',
    'medicalInsurance',
    'adminDeduction',
    'previousSettlements',
    'previousInsurance',
    'penaltyDeductionValue',
    'leaveAbsenceDeductionValue',
    'lateCheckoutDeduction',
    'lateDeduction',
    'earlyDeduction',
    'absentDeduction',
    'sickDeduction',
    'punchDeductionCheckin',
    'punchDeductionCheckout',
    'advanceShortTotal',
    'advanceLongTotal',
  ] as const;

  const data: Record<string, unknown> = {};
  for (const key of numericKeys) {
    if (fields[key] !== undefined) data[key] = Number(fields[key]);
  }
  if (fields.notes !== undefined) data.notes = String(fields.notes);

  if (data.basicSalary !== undefined || data.workingDays !== undefined) {
    const basic = Number(data.basicSalary ?? existing.basicSalary);
    const days = Number(data.workingDays ?? existing.workingDays);
    data.workDaysSalary = round2((basic / 30) * days);
  }

  if (data.overtimeHours !== undefined || data.basicSalary !== undefined) {
    const basic = Number(data.basicSalary ?? existing.basicSalary);
    const ot = Number(data.overtimeHours ?? existing.overtimeHours);
    data.overtimeAmount = round2((basic / 30) * ot);
  }

  const merged = { ...existing, ...data } as PayrollLine;
  const totals = recalculatePayrollLineTotals(merged, {
    socialInsurance: existing.employee?.insuranceSalary ?? existing.socialInsurance,
    medicalInsurance: existing.employee?.medicalInsuranceSalary ?? existing.medicalInsurance,
  });

  const line = await prisma.payrollLine.update({
    where: { id: lineId },
    data: {
      ...data,
      totalEarnings: totals.totalEarnings,
      grossSalary: totals.grossSalary,
      totalDeductions: totals.totalDeductions,
      netSalary: totals.netSalary,
      workDaysSalary: totals.workDaysSalary,
      overtimeAmount: totals.overtimeAmount,
    },
    include: { employee: true },
  });

  await refreshPayrollHeaderTotals(line.payrollId);
  return line;
}

/** Odoo action_fix_basic_salary_single — works even on confirmed payroll */
export async function fixBasicSalarySingle(lineId: string) {
  const line = await prisma.payrollLine.findUnique({
    where: { id: lineId },
    include: { employee: true },
  });
  if (!line) throw new NotFoundError('Payroll line not found');

  let newBasic = line.employee?.basicSalary || 0;
  if (!newBasic && line.workingDays && line.workDaysSalary) {
    newBasic = round2((line.workDaysSalary / line.workingDays) * 30);
  }
  if (!newBasic) {
    throw new AppError(
      `تعذّر تحديد راتب أساسي للموظف ${line.employeeCode || line.employee?.name || ''}`,
      400,
      'ACTION_ERROR',
    );
  }

  const oldBasic = line.basicSalary || 0;
  const daily = newBasic / 30;
  const hourly = daily / 8;

  let late = line.lateDeduction || 0;
  let lateCo = line.lateCheckoutDeduction || 0;
  let punchIn = line.punchDeductionCheckin || 0;
  let punchOut = line.punchDeductionCheckout || 0;
  if (oldBasic > 0.01 && newBasic) {
    const factor = newBasic / oldBasic;
    late = round2(late * factor);
    lateCo = round2(lateCo * factor);
    punchIn = round2(punchIn * factor);
    punchOut = round2(punchOut * factor);
  }

  const merged = {
    ...line,
    basicSalary: newBasic,
    workDaysSalary: round2(line.workingDays * daily),
    overtimeAmount: round2(line.overtimeHours * daily),
    absentDeduction: round2((line.absentCount || line.absentDays || 0) * daily),
    sickDeduction: round2((line.sickDayCount || 0) * daily),
    earlyDeduction: round2(((line.earlyLeaveMinutes || 0) / 60) * hourly),
    lateDeduction: late,
    lateCheckoutDeduction: lateCo,
    punchDeductionCheckin: punchIn,
    punchDeductionCheckout: punchOut,
  } as PayrollLine;

  const totals = recalculatePayrollLineTotals(merged, {
    socialInsurance: line.employee?.insuranceSalary ?? line.socialInsurance,
    medicalInsurance: line.employee?.medicalInsuranceSalary ?? line.medicalInsurance,
  });

  const updated = await prisma.payrollLine.update({
    where: { id: lineId },
    data: {
      basicSalary: newBasic,
      workDaysSalary: totals.workDaysSalary,
      overtimeAmount: totals.overtimeAmount,
      absentDeduction: merged.absentDeduction,
      sickDeduction: merged.sickDeduction,
      earlyDeduction: merged.earlyDeduction,
      lateDeduction: late,
      lateCheckoutDeduction: lateCo,
      punchDeductionCheckin: punchIn,
      punchDeductionCheckout: punchOut,
      totalEarnings: totals.totalEarnings,
      grossSalary: totals.grossSalary,
      totalDeductions: totals.totalDeductions,
      netSalary: totals.netSalary,
    },
    include: { employee: true },
  });

  await refreshPayrollHeaderTotals(line.payrollId);
  return updated;
}

/** Employee IDs with Excel/manual payroll lines — preserved across recalculate. */
export async function getManualPayrollEmployeeIds(payrollId: string): Promise<Set<string>> {
  const lines = await prisma.payrollLine.findMany({
    where: { payrollId, isManual: true },
    select: { employeeId: true },
  });
  return new Set(lines.map((l) => l.employeeId));
}

export async function getExcludedPayrollEmployeeIds(payrollId: string): Promise<Set<string>> {
  const row = await prisma.payroll.findUnique({
    where: { id: payrollId },
    select: { excludedEmployeeIds: true },
  });
  return new Set(row?.excludedEmployeeIds ?? []);
}

export async function addExcludedPayrollEmployees(
  payrollId: string,
  employeeIds: string[],
): Promise<void> {
  if (!employeeIds.length) return;
  const row = await prisma.payroll.findUnique({
    where: { id: payrollId },
    select: { excludedEmployeeIds: true },
  });
  const next = mergePayrollExcludedIds(row?.excludedEmployeeIds, employeeIds, []);
  await prisma.payroll.update({
    where: { id: payrollId },
    data: { excludedEmployeeIds: next },
  });
}

/** Re-adding via Excel / calculate-single clears the punch skip. */
export async function clearExcludedPayrollEmployees(
  payrollId: string,
  employeeIds: string[],
): Promise<void> {
  if (!employeeIds.length) return;
  const row = await prisma.payroll.findUnique({
    where: { id: payrollId },
    select: { excludedEmployeeIds: true },
  });
  const next = mergePayrollExcludedIds(row?.excludedEmployeeIds, [], employeeIds);
  await prisma.payroll.update({
    where: { id: payrollId },
    data: { excludedEmployeeIds: next },
  });
}

export async function deleteNonManualPayrollLines(payrollId: string): Promise<number> {
  const result = await prisma.payrollLine.deleteMany({
    where: { payrollId, isManual: false },
  });
  return result.count;
}

export async function maxPayrollLineSequence(payrollId: string): Promise<number> {
  const max = await prisma.payrollLine.aggregate({
    where: { payrollId },
    _max: { sequence: true },
  });
  return max._max.sequence ?? 0;
}
