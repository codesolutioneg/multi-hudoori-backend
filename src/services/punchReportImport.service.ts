/**
 * Import edited «تقرير البصمات» Excel (employee summary rows) and build
 * payroll lines from those summaries — Odoo parity with
 * biotime.punch.report.import.wizard + build_line_vals_from_attendance_summary.
 *
 * Excel summary cells are day-fractions / counts; money fields on PayrollLine
 * are filled as dayFraction × (basicSalary / 30).
 */
import ExcelJS from 'exceljs';
import { PayrollState, PunchReportImportState, Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { resolveEmployeeByCode } from './deductionExcel.service';
import {
  createPayroll,
  linkDeductionsAndAdvances,
} from './payroll.service';
import { revertAdvancesOnPayroll } from './advances.service';
import { revertDeductionsOnPayroll } from './payrollDeductions.service';
import {
  recalculatePayrollLineTotals,
  refreshPayrollHeaderTotals,
  round2,
  getManualPayrollEmployeeIds,
  getExcludedPayrollEmployeeIds,
  deleteNonManualPayrollLines,
  maxPayrollLineSequence,
} from './payrollLine.service';
import { shouldSkipPunchRebuild } from './payrollExclusion.service';
import { payrollJson } from './serialize.service';

export type PunchAttendanceSummary = {
  earnedLeave: number;
  actualDays: number;
  punchCount: number;
  punchDed: number;
  absentCount: number;
  adminPenalty: number;
  overtime: number;
  lateDed: number;
  earlyDed: number;
  sickDays: number;
  sickDed: number;
  empName?: string;
};

/**
 * Excel cells are not always plain scalars: formulas arrive as
 * `{ formula, result }`, edited labels as `{ richText }`. HR edits the summary
 * row by hand (and «إجمالي الجزاءات» is itself a formula), so unwrap before use.
 */
function cellScalar(v: unknown): unknown {
  if (v == null || typeof v !== 'object') return v;
  if (v instanceof Date) return v;
  const obj = v as Record<string, unknown>;
  if ('error' in obj) return null;
  if ('result' in obj) return cellScalar(obj.result);
  if (Array.isArray(obj.richText)) {
    return obj.richText.map((part) => String((part as { text?: unknown }).text ?? '')).join('');
  }
  if ('text' in obj) return cellScalar(obj.text);
  return null;
}

function normLabel(v: unknown): string {
  let s = String(cellScalar(v) ?? '')
    .trim()
    .toLowerCase();
  s = s.replace(/أ|إ|آ/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/:/g, '');
  return s.replace(/\s+/g, ' ');
}

const SUMMARY_ALIASES: Record<keyof Omit<PunchAttendanceSummary, 'empName'>, string[]> = {
  earnedLeave: ['ايام الاجازه المستحقه', 'عدد الايام المستحقه'],
  actualDays: ['ايام العمل الفعليه', 'عدد العمل الفعلي', 'عدد ايام العمل الفعلي'],
  punchCount: ['عدم تكرار البصمه', 'عدد تكرار البصمه'],
  punchDed: ['خصم تكرار البصمه'],
  absentCount: ['غياب بدون اذن', 'غياب'],
  adminPenalty: ['جزاء اداري'],
  overtime: ['الاضافي'],
  lateDed: ['تاخير الحضور', 'تاخر الحضور', 'خصم التاخير', 'خصم التأخير'],
  earlyDed: ['تاخير الانصراف', 'تاخر الانصراف', 'خصم تاخير الانصراف', 'خصم تأخير الانصراف'],
  sickDays: ['ايام الاجازه المرضيه'],
  sickDed: ['خصم الاجازه المرضيه'],
};

const NORM_ALIASES: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(SUMMARY_ALIASES).map(([key, aliases]) => [
    key,
    new Set(aliases.map((a) => normLabel(a))),
  ]),
);

function safeFloat(v: unknown): number {
  const raw = cellScalar(v);
  if (raw == null || String(raw).trim() === '' || String(raw).trim() === '-') return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function summaryHasSignal(s: PunchAttendanceSummary): boolean {
  return [
    s.actualDays,
    s.overtime,
    s.punchCount,
    s.punchDed,
    s.absentCount,
    s.adminPenalty,
    s.lateDed,
    s.earlyDed,
    s.sickDays,
    s.sickDed,
  ].some((v) => Math.abs(v) > 0.0001);
}

/** Pure parser — also used by unit tests. */
export function parsePunchReportSummariesFromSheet(
  rows: unknown[][],
): Map<string, PunchAttendanceSummary> {
  const empSummary = new Map<string, PunchAttendanceSummary>();
  if (!rows.length) return empSummary;

  let headerRowIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const vals = row.map((c) => String(cellScalar(c) ?? '').trim());
    if (vals.includes('Line ID') || vals.includes('كود الموظف')) {
      headerRowIdx = i;
      headers = vals;
      break;
    }
  }
  if (headerRowIdx < 0) {
    throw new AppError('تعذر إيجاد صف العناوين (Line ID) في الملف', 400, 'IMPORT_ERROR');
  }

  const colIdx = new Map(headers.map((h, i) => [h, i]));
  const empCodeCol = colIdx.get('كود الموظف') ?? -1;
  const empNameCol = colIdx.get('اسم الموظف') ?? -1;

  let currentEmpCode: string | null = null;
  let currentEmpName = '';
  let nextIsSummaryValues = false;
  let summaryCols: Partial<Record<string, number>> = {};

  for (const row of rows.slice(headerRowIdx + 1)) {
    if (!row || row.every((c) => c == null || String(c).trim() === '')) {
      nextIsSummaryValues = false;
      continue;
    }

    if (nextIsSummaryValues) {
      nextIsSummaryValues = false;
      if (currentEmpCode) {
        const getVal = (key: string, fallbackIdx: number): unknown => {
          const idx = summaryCols[key];
          if (idx != null && idx < row.length) return row[idx];
          if (Object.keys(summaryCols).length === 0 && fallbackIdx < row.length) {
            return row[fallbackIdx];
          }
          return null;
        };
        const newVals: PunchAttendanceSummary = {
          earnedLeave: safeFloat(getVal('earnedLeave', 1)),
          actualDays: safeFloat(getVal('actualDays', 2)),
          punchCount: safeFloat(getVal('punchCount', 3)),
          punchDed: safeFloat(getVal('punchDed', 4)),
          absentCount: safeFloat(getVal('absentCount', 5)),
          adminPenalty: safeFloat(getVal('adminPenalty', 6)),
          overtime: safeFloat(getVal('overtime', 7)),
          lateDed: safeFloat(getVal('lateDed', 8)),
          earlyDed: safeFloat(getVal('earlyDed', 9)),
          sickDays: safeFloat(getVal('sickDays', 10)),
          sickDed: safeFloat(getVal('sickDed', 11)),
          empName: currentEmpName || undefined,
        };
        const existing = empSummary.get(currentEmpCode);
        // Prefer the summary that still has signal when duplicates appear.
        if (!existing || (summaryHasSignal(newVals) && !summaryHasSignal(existing))) {
          empSummary.set(currentEmpCode, newVals);
        } else if (summaryHasSignal(newVals)) {
          empSummary.set(currentEmpCode, newVals);
        }
      }
      continue;
    }

    // Detect summary LABEL row by matching known aliases in cells.
    const matched: Partial<Record<string, number>> = {};
    let matchCount = 0;
    for (let i = 0; i < row.length; i++) {
      const n = normLabel(row[i]);
      if (!n) continue;
      for (const [key, aliases] of Object.entries(NORM_ALIASES)) {
        if (aliases.has(n)) {
          matched[key] = i;
          matchCount++;
          break;
        }
      }
    }
    if (matchCount >= 3) {
      summaryCols = matched;
      nextIsSummaryValues = true;
      continue;
    }

    // Detail row — track last employee code for the following summary.
    if (empCodeCol >= 0) {
      const maybeCode = String(cellScalar(row[empCodeCol]) ?? '').trim();
      if (
        maybeCode &&
        maybeCode !== 'كود الموظف' &&
        maybeCode !== '#' &&
        !normLabel(maybeCode).includes('ايام') &&
        !normLabel(maybeCode).startsWith('اجمالي')
      ) {
        currentEmpCode = maybeCode;
        if (empNameCol >= 0) {
          currentEmpName = String(cellScalar(row[empNameCol]) ?? '').trim() || currentEmpName;
        }
      }
    }
  }

  return empSummary;
}

async function workbookFromBase64(base64: string): Promise<ExcelJS.Workbook> {
  const cleaned = cleanBase64(base64);
  const buf = Buffer.from(cleaned, 'base64');
  const wb = new ExcelJS.Workbook();
  // exceljs typings disagree with Node 20 Buffer generics
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  return wb;
}

function cleanBase64(base64: string): string {
  const trimmed = base64.trim();
  return trimmed.includes(',') ? trimmed.split(',')[1]! : trimmed;
}

function sheetToRows(sheet: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const vals: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      while (vals.length < colNumber - 1) vals.push(null);
      vals.push(cell.value);
    });
    rows.push(vals);
  });
  return rows;
}

function readMeta(wb: ExcelJS.Workbook): {
  wizardId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  shiftGridId: string | null;
} {
  const meta = wb.getWorksheet('_meta');
  if (!meta) {
    throw new AppError(
      'الملف لا يحتوي على ورقة _meta — لازم يكون مُصدَّر من تقرير البصمات',
      400,
      'IMPORT_ERROR',
    );
  }
  const map = new Map<string, string>();
  for (let r = 1; r <= 10; r++) {
    const k = String(meta.getCell(r, 1).value ?? '').trim().toLowerCase();
    const v = String(meta.getCell(r, 2).value ?? '').trim();
    if (k) map.set(k, v);
  }
  return {
    wizardId: map.get('wizard_id') || null,
    dateFrom: map.get('date_from') || null,
    dateTo: map.get('date_to') || null,
    shiftGridId: map.get('shift_grid_id') || null,
  };
}

export function buildPayrollLineFromSummary(params: {
  employeeId: string;
  employeeCode: string;
  basicSalary: number;
  insuranceSalary: number;
  medicalInsuranceSalary: number;
  summary: PunchAttendanceSummary;
  sequence: number;
  payrollId: string;
  meta?: Record<string, unknown>;
}) {
  const {
    employeeId,
    employeeCode,
    basicSalary,
    insuranceSalary,
    medicalInsuranceSalary,
    summary,
    sequence,
    payrollId,
  } = params;
  const daily = basicSalary / 30;
  const money = (days: number) => round2(days * daily);

  let singlePunch = round2(summary.punchDed || 0);
  // Odoo: single_punch_count = punch_ded (days), not punch_count.
  if (singlePunch <= 0) singlePunch = 0;

  const workingDays = round2(summary.actualDays || 0);
  const overtimeHours = round2(summary.overtime || 0);
  const lateDays = round2(summary.lateDed || 0);
  const earlyDays = round2(summary.earlyDed || 0);
  const punchDays = round2(summary.punchDed || 0);
  const absentCount = round2(summary.absentCount || 0);
  const adminDays = round2(summary.adminPenalty || 0);
  const sickDays = round2(summary.sickDays || 0);
  const sickDedDays = round2(summary.sickDed || 0);
  // Odoo: sick_day_count = sick_days × 0.25; sick money from sick_ded days.
  const sickDayCount = sickDays > 0 ? round2(sickDays * 0.25) : 0;
  const sickMoneyDays = sickDedDays > 0 ? sickDedDays : sickDayCount;

  const lineBase = {
    payrollId,
    employeeId,
    sequence,
    employeeCode,
    basicSalary,
    workingDays,
    actualWorkingDays: workingDays,
    workDaysSalary: 0,
    grossSalary: 0,
    totalEarnings: 0,
    overtimeHours,
    overtimeAmount: 0,
    totalDeductions: 0,
    netSalary: 0,
    absentDays: absentCount,
    absentCount,
    sickDayCount,
    leaveAbsenceDeductionValue: 0,
    lateDeductibleDays: lateDays,
    lateDeductibleMinutes: 0,
    earnedLeave: round2(summary.earnedLeave || 0),
    permissionCount: 0,
    lateDeduction: money(lateDays),
    earlyDeduction: 0,
    lateCheckoutDeduction: money(earlyDays),
    absentDeduction: money(absentCount),
    sickDeduction: money(sickMoneyDays),
    punchDeductionCheckin: money(punchDays),
    punchDeductionCheckout: 0,
    singlePunchCount: singlePunch,
    earlyLeaveMinutes: 0,
    totalNetHours: 0,
    offDayCount: 0,
    daysCount: 0,
    manualDebit: 0,
    penaltyDeductionValue: 0,
    // Odoo: admin_deduction stores days (money via adminPenaltyMoney).
    adminDeduction: adminDays,
    fines: 0,
    deductionChecks: 0,
    groupedChecks: 0,
    healthCertificatesDeduction: 0,
    fractionDeduction: 0,
    documentsDeduction: 0,
    socialInsurance: insuranceSalary,
    medicalInsurance: medicalInsuranceSalary,
    advanceShortTotal: 0,
    advanceLongTotal: 0,
    previousSettlements: 0,
    previousInsurance: 0,
    notes: 'من استيراد تقرير البصمات Excel',
    ...(params.meta ?? {}),
  };

  const totals = recalculatePayrollLineTotals(lineBase as never, {
    socialInsurance: insuranceSalary,
    medicalInsurance: medicalInsuranceSalary,
  });

  return {
    ...lineBase,
    workDaysSalary: totals.workDaysSalary,
    overtimeAmount: totals.overtimeAmount,
    totalEarnings: totals.totalEarnings,
    grossSalary: totals.grossSalary,
    totalDeductions: totals.totalDeductions,
    netSalary: totals.netSalary,
  };
}

export type ParsedPunchReportUpload = {
  meta: {
    wizardId: string | null;
    dateFrom: string | null;
    dateTo: string | null;
    shiftGridId: string | null;
  };
  summaries: Map<string, PunchAttendanceSummary>;
  kept: Map<string, PunchAttendanceSummary>;
  preview: { code: string; name: string; actualDays: number; found: boolean }[];
};

/** Shared validation for punch-report Excel uploads (shift grid + payroll re-import). */
export function validatePunchReportMeta(
  meta: ParsedPunchReportUpload['meta'],
  expected: { shiftGridId: string; dateFrom: string; dateTo: string },
) {
  if (!meta.shiftGridId) {
    throw new AppError(
      'الملف بدون معرف الجدول (_meta) — صدّر «تقرير البصمات» من نفس جدول الشيفتات ثم استورده',
      400,
      'IMPORT_ERROR',
    );
  }
  if (meta.shiftGridId !== expected.shiftGridId) {
    throw new AppError(
      'هذا الملف يخص فرع/جدول شيفتات آخر — صدّر التقرير من نفس الجدول ثم استورده هنا',
      400,
      'IMPORT_ERROR',
    );
  }
  if (meta.dateFrom && meta.dateTo) {
    if (meta.dateFrom !== expected.dateFrom || meta.dateTo !== expected.dateTo) {
      throw new AppError(
        `فترة الملف (${meta.dateFrom} → ${meta.dateTo}) تختلف عن فترة الكشف (${expected.dateFrom} → ${expected.dateTo})`,
        400,
        'IMPORT_ERROR',
      );
    }
  }
}

export async function parseValidatedPunchReportUpload(params: {
  shiftGridId: string;
  base64: string;
  dateFrom: Date;
  dateTo: Date;
}): Promise<ParsedPunchReportUpload> {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: params.shiftGridId } });
  if (!grid) throw new NotFoundError('جدول الشيفتات غير موجود');

  const wb = await workbookFromBase64(params.base64);
  const meta = readMeta(wb);
  validatePunchReportMeta(meta, {
    shiftGridId: params.shiftGridId,
    dateFrom: params.dateFrom.toISOString().slice(0, 10),
    dateTo: params.dateTo.toISOString().slice(0, 10),
  });

  const main =
    wb.getWorksheet('تقرير البصمات') ??
    wb.worksheets.find((s) => s.name !== '_meta' && s.name !== 'تفاصيل الحسابات') ??
    wb.worksheets[0];
  if (!main) throw new AppError('الملف فارغ', 400, 'IMPORT_ERROR');

  const summaries = parsePunchReportSummariesFromSheet(sheetToRows(main));
  if (!summaries.size) {
    throw new AppError('لم يتم العثور على صفوف ملخص موظفين في الملف', 400, 'IMPORT_ERROR');
  }

  const preview: ParsedPunchReportUpload['preview'] = [];
  const kept = new Map<string, PunchAttendanceSummary>();
  for (const [code, summary] of summaries) {
    if (!summaryHasSignal(summary)) continue;
    const emp = await resolveEmployeeByCode(code);
    preview.push({
      code,
      name: summary.empName || emp?.name || '',
      actualDays: summary.actualDays,
      found: Boolean(emp),
    });
    if (emp) kept.set(code, summary);
  }
  if (!kept.size) {
    throw new AppError('لا يوجد موظفون معروفون في النظام ضمن ملخص الملف', 400, 'IMPORT_ERROR');
  }

  return { meta, summaries, kept, preview };
}

export async function importPunchReportExcel(params: {
  shiftGridId: string;
  base64: string;
  filename?: string;
}) {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: params.shiftGridId } });
  if (!grid) throw new NotFoundError('جدول الشيفتات غير موجود');

  const parsed = await parseValidatedPunchReportUpload({
    shiftGridId: params.shiftGridId,
    base64: params.base64,
    dateFrom: grid.dateFrom,
    dateTo: grid.dateTo,
  });

  const batch = await prisma.punchReportImport.create({
    data: {
      shiftGridId: params.shiftGridId,
      dateFrom: grid.dateFrom,
      dateTo: grid.dateTo,
      sourceFilename: params.filename ?? null,
      sourceFileBase64: cleanBase64(params.base64),
      exportWizardId: parsed.meta.wizardId ?? undefined,
      state: PunchReportImportState.ready,
      employeeCount: parsed.kept.size,
      summariesJson: Object.fromEntries(parsed.kept) as Prisma.InputJsonValue,
    },
  });

  return {
    importId: batch.id,
    employeeCount: parsed.kept.size,
    skippedUnknown: parsed.preview.filter((p) => !p.found).length,
    preview: parsed.preview.slice(0, 50),
    message: `تم استيراد ملخص ${parsed.kept.size} موظف — اضغط «عمل كشف من تقرير البصمات» لإكمال الحساب`,
  };
}

export async function getAppliedPunchImportForPayroll(payrollId: string) {
  return prisma.punchReportImport.findFirst({
    where: { payrollId, state: PunchReportImportState.applied },
    orderBy: { updatedAt: 'desc' },
  });
}

export function punchImportSourceJson(
  batch: {
    id: string;
    sourceFilename: string | null;
    employeeCount: number;
    createdAt: Date;
    updatedAt: Date;
    sourceFileBase64?: string | null;
  } | null,
) {
  if (!batch) return null;
  return {
    importId: batch.id,
    sourceFilename: batch.sourceFilename ?? '',
    employeeCount: batch.employeeCount,
    importedAt: batch.createdAt.toISOString(),
    appliedAt: batch.updatedAt.toISOString(),
    hasSourceFile: Boolean(batch.sourceFileBase64?.trim()),
  };
}

export async function exportPunchImportReferenceForPayroll(payrollId: string) {
  const batch = await getAppliedPunchImportForPayroll(payrollId);
  if (!batch?.sourceFileBase64?.trim()) {
    throw new AppError(
      'لا يوجد ملف تقرير بصمات محفوظ لهذا الكشف — ارفع التقرير المعدّل من جدول الشيفتات ثم أنشئ الكشف من جديد',
      404,
      'NOT_FOUND',
    );
  }
  const filename =
    batch.sourceFilename?.trim() ||
    `punch_report_reference_${batch.dateFrom.toISOString().slice(0, 10)}_${batch.dateTo.toISOString().slice(0, 10)}.xlsx`;
  return { base64: batch.sourceFileBase64, filename };
}

/** Replace applied punch-report reference on an existing payroll and rebuild lines. */
export async function reimportPunchReportForPayroll(params: {
  payrollId: string;
  base64: string;
  filename?: string;
}) {
  const payroll = await prisma.payroll.findUnique({
    where: { id: params.payrollId },
    include: { shiftGrid: { include: { location: true } } },
  });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن إعادة استيراد تقرير البصمات لكشف مؤكد', 400, 'ACTION_ERROR');
  }
  if (!payroll.shiftGridId) {
    throw new AppError('هذا الكشف غير مرتبط بجدول شيفتات', 400, 'ACTION_ERROR');
  }

  const existing = await getAppliedPunchImportForPayroll(params.payrollId);
  if (!existing) {
    throw new AppError(
      'هذا الكشف ليس من تقرير بصمات مرفوع — أنشئه من جدول الشيفتات أولاً',
      400,
      'ACTION_ERROR',
    );
  }

  const parsed = await parseValidatedPunchReportUpload({
    shiftGridId: payroll.shiftGridId,
    base64: params.base64,
    dateFrom: payroll.dateFrom,
    dateTo: payroll.dateTo,
  });

  const summariesJson = Object.fromEntries(parsed.kept) as Prisma.InputJsonValue;
  await prisma.punchReportImport.update({
    where: { id: existing.id },
    data: {
      summariesJson,
      sourceFilename: params.filename ?? existing.sourceFilename,
      sourceFileBase64: cleanBase64(params.base64),
      exportWizardId: parsed.meta.wizardId ?? existing.exportWizardId,
      employeeCount: parsed.kept.size,
      state: PunchReportImportState.applied,
      payrollId: payroll.id,
    },
  });

  const batch = await prisma.punchReportImport.findUnique({ where: { id: existing.id } });
  if (!batch) throw new NotFoundError('استيراد تقرير البصمات غير موجود');

  const { lineCount } = await rebuildPayrollFromPunchImport(payroll.id, batch);
  await linkDeductionsAndAdvances(payroll.id);

  const updated = await prisma.payroll.update({
    where: { id: payroll.id },
    data: {
      state: PayrollState.calculated,
      excelImportedAt: null,
    },
    include: {
      lines: { include: { employee: true }, orderBy: { sequence: 'asc' } },
      shiftGrid: { include: { location: true } },
      _count: { select: { lines: true } },
    },
  });

  const appliedBatch = await prisma.punchReportImport.findUnique({ where: { id: batch.id } });

  return {
    payroll: payrollJson(
      updated,
      true,
      updated.lines,
      undefined,
      undefined,
      punchImportSourceJson(appliedBatch),
    ),
    importId: batch.id,
    lineCount,
    employeeCount: parsed.kept.size,
    skippedUnknown: parsed.preview.filter((p) => !p.found).length,
    preview: parsed.preview.slice(0, 50),
    message: `تم تحديث الكشف من تقرير البصمات (${lineCount} سطر، ${parsed.kept.size} موظف)`,
  };
}

/** Rebuild payroll lines from an applied/ready punch-import batch (summariesJson). */
export async function rebuildPayrollFromPunchImport(
  payrollId: string,
  batch: { id: string; shiftGridId: string; summariesJson: Prisma.JsonValue },
): Promise<{ lineCount: number; importId: string }> {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: batch.shiftGridId } });
  if (!grid) throw new NotFoundError('جدول الشيفتات غير موجود');

  const summaries = batch.summariesJson as Record<string, PunchAttendanceSummary>;
  const codes = Object.keys(summaries);
  if (!codes.length) throw new AppError('الاستيراد فارغ', 400, 'ACTION_ERROR');

  await revertAdvancesOnPayroll(payrollId);
  await revertDeductionsOnPayroll(payrollId);
  const manualEmployeeIds = await getManualPayrollEmployeeIds(payrollId);
  const excludedEmployeeIds = await getExcludedPayrollEmployeeIds(payrollId);
  await deleteNonManualPayrollLines(payrollId);

  let seq = await maxPayrollLineSequence(payrollId);
  let created = 0;
  for (const code of codes) {
    const summary = summaries[code]!;
    if (!summaryHasSignal(summary)) continue;
    const emp = await prisma.employeeProfile.findFirst({
      where: {
        OR: [{ code }, { mapping: { is: { biotimeEmpCode: code } } }],
      },
      include: { department: true, workLocation: true },
    });
    if (!emp) continue;
    if (shouldSkipPunchRebuild(emp.id, manualEmployeeIds, excludedEmployeeIds)) continue;

    seq += 1;
    const lineData = buildPayrollLineFromSummary({
      employeeId: emp.id,
      employeeCode: emp.code ?? code,
      basicSalary: emp.basicSalary || 0,
      insuranceSalary: emp.insuranceSalary || 0,
      medicalInsuranceSalary: emp.medicalInsuranceSalary || 0,
      summary,
      sequence: seq,
      payrollId,
      meta: {
        positionName: emp.jobTitle ?? '',
        departmentName: emp.department?.name ?? '',
        employeeLocation: emp.workLocation?.name ?? emp.location ?? '',
        leaveAbsenceDeductionValue: 0,
      },
    });

    await prisma.payrollLine.create({ data: lineData as never });
    created += 1;
  }

  if (!created) {
    const remaining = await prisma.payrollLine.count({ where: { payrollId } });
    if (!remaining) {
      throw new AppError('لم يُنشأ أي سطر راتب من الاستيراد', 400, 'ACTION_ERROR');
    }
  }

  await refreshPayrollHeaderTotals(payrollId);
  return { lineCount: created, importId: batch.id };
}

export async function createPayrollFromPunchImport(params: {
  shiftGridId: string;
  importId?: string;
}) {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: params.shiftGridId } });
  if (!grid) throw new NotFoundError('جدول الشيفتات غير موجود');

  const batch = params.importId
    ? await prisma.punchReportImport.findFirst({
        where: { id: params.importId, shiftGridId: params.shiftGridId },
      })
    : await prisma.punchReportImport.findFirst({
        where: { shiftGridId: params.shiftGridId, state: PunchReportImportState.ready },
        orderBy: { createdAt: 'desc' },
      });

  if (!batch) {
    throw new AppError(
      'لا يوجد استيراد جاهز — ارفع تقرير البصمات Excel أولاً',
      400,
      'ACTION_ERROR',
    );
  }

  const summaries = batch.summariesJson as Record<string, PunchAttendanceSummary>;
  const codes = Object.keys(summaries);
  if (!codes.length) throw new AppError('الاستيراد فارغ', 400, 'ACTION_ERROR');

  // Reuse open draft/calculated payroll for this grid + dates when possible.
  let payroll = await prisma.payroll.findFirst({
    where: {
      shiftGridId: params.shiftGridId,
      dateFrom: grid.dateFrom,
      dateTo: grid.dateTo,
      state: { not: PayrollState.confirmed },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!payroll) {
    payroll = await createPayroll({ shiftGridId: params.shiftGridId });
  }

  const { lineCount: created, importId } = await rebuildPayrollFromPunchImport(payroll.id, batch);
  await linkDeductionsAndAdvances(payroll.id);

  const updated = await prisma.payroll.update({
    where: { id: payroll.id },
    data: { state: PayrollState.calculated },
    include: {
      lines: { include: { employee: true }, orderBy: { sequence: 'asc' } },
      shiftGrid: { include: { location: true } },
      _count: { select: { lines: true } },
    },
  });

  await prisma.punchReportImport.update({
    where: { id: batch.id },
    data: {
      state: PunchReportImportState.applied,
      payrollId: updated.id,
    },
  });

  const appliedBatch = await prisma.punchReportImport.findUnique({ where: { id: batch.id } });

  return {
    payroll: payrollJson(
      updated,
      true,
      updated.lines,
      undefined,
      undefined,
      punchImportSourceJson(appliedBatch),
    ),
    importId,
    lineCount: created,
    message: `تم إنشاء/تحديث كشف الرواتب (${created} سطر) من تقرير البصمات`,
  };
}
