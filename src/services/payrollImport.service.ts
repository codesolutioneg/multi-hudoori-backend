/**
 * Odoo parity: biotime_payroll/models/payroll_xlsx_import.py
 * — update existing lines, add missing employees, delete lines not in file.
 */
import { AdvanceState, PayrollLine, PayrollState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { loadSheetRows, resolveEmployeeByCode } from './deductionExcel.service';
import { syncLinkedDeductionsFromPayrollImport } from './payrollDeductions.service';
import {
  adminPenaltyMoney,
  manualDedTotal,
  recalculatePayrollLineTotals,
  refreshPayrollHeaderTotals,
  round2,
  addExcludedPayrollEmployees,
  clearExcludedPayrollEmployees,
} from './payrollLine.service';

type CountSpec = {
  excelKeys: string[];
  countField?: keyof PayrollLine | null;
  moneyField?: keyof PayrollLine | null;
  multiplier?: number;
};

/** Odoo COUNT_IMPORT_SPECS — sick money = daily × sick_day_count (multiplier 1). */
const COUNT_IMPORT_SPECS: CountSpec[] = [
  { excelKeys: ['late_deductible_days', 'late_deduction'], moneyField: 'lateDeduction' },
  { excelKeys: ['single_punch_count'], countField: 'singlePunchCount', moneyField: 'punchDeductionCheckin' },
  { excelKeys: ['late_checkout_days', 'late_checkout_deduction'], moneyField: 'lateCheckoutDeduction' },
  { excelKeys: ['sick_day_count', 'sick_deduction'], countField: 'sickDayCount', moneyField: 'sickDeduction', multiplier: 1 },
  { excelKeys: ['absent_count'], countField: 'absentCount', moneyField: 'absentDeduction' },
  { excelKeys: ['admin_deduction'], countField: 'adminDeduction' },
  { excelKeys: ['overtime_hours'], countField: 'overtimeHours', moneyField: 'overtimeAmount' },
];

/** Odoo DIRECT_IMPORT_FIELDS (+ leave_absence kept for older sheets). */
const DIRECT_IMPORT_FIELD_MAP: { excelKeys: string[]; field: keyof PayrollLine }[] = [
  { excelKeys: ['working_days'], field: 'workingDays' },
  { excelKeys: ['penalty_deduction_value'], field: 'penaltyDeductionValue' },
  { excelKeys: ['long_term_advance'], field: 'advanceLongTotal' },
  { excelKeys: ['salary_advance'], field: 'advanceShortTotal' },
  { excelKeys: ['deduction_checks'], field: 'deductionChecks' },
  { excelKeys: ['manual_debit'], field: 'manualDebit' },
  { excelKeys: ['health_certificates_deduction'], field: 'healthCertificatesDeduction' },
  { excelKeys: ['fraction_deduction'], field: 'fractionDeduction' },
  { excelKeys: ['fines'], field: 'fines' },
  { excelKeys: ['documents_deduction'], field: 'documentsDeduction' },
  { excelKeys: ['leave_absence_deduction_value'], field: 'leaveAbsenceDeductionValue' },
  { excelKeys: ['previous_settlements'], field: 'previousSettlements' },
  { excelKeys: ['previous_insurance'], field: 'previousInsurance' },
  { excelKeys: ['grouped_checks'], field: 'groupedChecks' },
];

/**
 * Formula «value» columns in the exported Payroll sheet.
 * Applied AFTER day/count specs so an explicit money edit wins over days×rate.
 * (Hudoori extension vs Odoo SKIP — HR asked to keep Excel money edits.)
 */
const MONEY_IMPORT_FIELD_MAP: {
  excelKeys: string[];
  field: keyof PayrollLine;
  /** Optional days field to keep in sync for next export. */
  daysField?: keyof PayrollLine;
  /** Clear so totals don't double-count (late checkout vs early). */
  clearFields?: (keyof PayrollLine)[];
}[] = [
  { excelKeys: ['late_value'], field: 'lateDeduction', daysField: 'lateDeductibleDays' },
  {
    excelKeys: ['punch_deduction_checkin'],
    field: 'punchDeductionCheckin',
    daysField: 'singlePunchCount',
  },
  {
    excelKeys: ['late_checkout_value'],
    field: 'lateCheckoutDeduction',
    clearFields: ['earlyDeduction'],
  },
  { excelKeys: ['sick_value'], field: 'sickDeduction', daysField: 'sickDayCount' },
  { excelKeys: ['absent_deduction'], field: 'absentDeduction', daysField: 'absentCount' },
];

/** Keys that still must not write back (pure display / insurance / payment). */
const SKIP_IMPORT_KEYS = new Set([
  'work_days_salary',
  'overtime_amount',
  'permission_count',
  'total_earnings',
  'total_deductions',
  'net_salary',
  'social_insurance',
  'medical_insurance',
  'fawry_commission',
  'grand_total',
  'duplicate_in_payroll',
  'placeholder',
  'fawry_account',
  'over_deduction',
  'employee_name',
  'department',
  'position',
  'hiring_date',
  'employee_location',
  'basic_salary',
]);

/** Fields that lock the line against punch rebuild when changed via Excel. */
const MANUAL_LOCK_FIELDS = new Set([
  'workingDays',
  'overtimeHours',
  'lateDeduction',
  'lateDeductibleDays',
  'lateCheckoutDeduction',
  'earlyDeduction',
  'punchDeductionCheckin',
  'singlePunchCount',
  'sickDeduction',
  'sickDayCount',
  'absentDeduction',
  'absentCount',
  'adminDeduction',
  'penaltyDeductionValue',
  'leaveAbsenceDeductionValue',
  'deductionChecks',
  'manualDebit',
  'healthCertificatesDeduction',
  'fractionDeduction',
  'fines',
  'documentsDeduction',
  'groupedChecks',
  'advanceShortTotal',
  'advanceLongTotal',
  'previousSettlements',
  'previousInsurance',
]);

/** Map export row-5 keys (snake_case) → Prisma payroll line fields */
export function resolveDirectImportCols(header: string[]): Partial<Record<keyof PayrollLine, number>> {
  const directCols: Partial<Record<keyof PayrollLine, number>> = {};
  for (const { excelKeys, field } of DIRECT_IMPORT_FIELD_MAP) {
    const idx = colIndex(header, excelKeys);
    if (idx >= 0 && !excelKeys.some((k) => SKIP_IMPORT_KEYS.has(k))) {
      directCols[field] = idx;
    }
  }
  return directCols;
}

export function resolveMoneyImportCols(
  header: string[],
): Array<{
  col: number;
  field: keyof PayrollLine;
  daysField?: keyof PayrollLine;
  clearFields?: (keyof PayrollLine)[];
}> {
  const out: Array<{
    col: number;
    field: keyof PayrollLine;
    daysField?: keyof PayrollLine;
    clearFields?: (keyof PayrollLine)[];
  }> = [];
  for (const spec of MONEY_IMPORT_FIELD_MAP) {
    const idx = colIndex(header, spec.excelKeys);
    if (idx < 0) continue;
    out.push({
      col: idx,
      field: spec.field,
      daysField: spec.daysField,
      clearFields: spec.clearFields,
    });
  }
  return out;
}

/** ExcelJS may return `{ formula, result }` for formula cells. */
function unwrapExcelCell(v: unknown): unknown {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  if ('result' in o) return o.result;
  if (Array.isArray(o.richText)) {
    return (o.richText as { text?: string }[]).map((t) => t.text ?? '').join('');
  }
  if (typeof o.text === 'string' && !('formula' in o)) return o.text;
  // Formula without cached result — treat as empty so we don't wipe DB with 0.
  if ('formula' in o) return null;
  return v;
}

function parseFloatCell(v: unknown): number {
  const raw = unwrapExcelCell(v);
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'string') {
    const n = Number(raw.replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Empty Excel cells must not overwrite existing DB values (Odoo partial row apply). */
function cellHasImportValue(v: unknown): boolean {
  const raw = unwrapExcelCell(v);
  if (raw == null || raw === '') return false;
  if (typeof raw === 'string' && !raw.trim()) return false;
  return true;
}

/** True when HR typed a literal amount (not an untouched Excel formula cell). */
function isExplicitMoneyOverride(v: unknown): boolean {
  if (v == null || v === '') return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return false;
    return Number.isFinite(Number(t.replace(/,/g, '')));
  }
  if (typeof v === 'object' && !Array.isArray(v) && 'formula' in (v as object)) {
    // Still a formula — keep days×rate from count specs; don't re-apply cached result.
    return false;
  }
  return cellHasImportValue(v);
}

function normalizeHeader(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

export { normalizeHeader };

function findHeaderRow(rows: unknown[][]): { headerIdx: number; header: string[] } {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const row = rows[i];
    if (!row) continue;
    const header = row.map(normalizeHeader);
    if (header.includes('employee_code')) {
      return { headerIdx: i, header };
    }
  }
  throw new AppError('لم يتم العثور على صف employee_code في الملف', 400, 'IMPORT_ERROR');
}

function colIndex(header: string[], keys: string[]): number {
  for (const k of keys) {
    const idx = header.indexOf(k);
    if (idx >= 0) return idx;
  }
  return -1;
}

function safeMoney(n: number): number {
  return Number.isFinite(n) ? round2(n) : 0;
}

function payrollLineTotalsForWrite(
  line: PayrollLine,
  options?: { socialInsurance?: number | null; medicalInsurance?: number | null },
) {
  const totals = recalculatePayrollLineTotals(line, options);
  return {
    workDaysSalary: safeMoney(totals.workDaysSalary),
    overtimeAmount: safeMoney(totals.overtimeAmount),
    totalEarnings: safeMoney(totals.totalEarnings),
    grossSalary: safeMoney(totals.grossSalary),
    totalDeductions: safeMoney(totals.totalDeductions),
    netSalary: safeMoney(totals.netSalary),
  };
}

function dailyRateFromLine(line: PayrollLine, excelBasic = 0): number {
  let basic = line.basicSalary || 0;
  if (!basic && excelBasic) basic = excelBasic;
  if (basic) return basic / 30;
  if (line.workingDays && line.workDaysSalary) return line.workDaysSalary / line.workingDays;
  return 0;
}

/** Odoo _correct_imported_penalty — strip admin-days money from imported penalty cell. */
export function correctImportedPenalty(
  penaltyDeductionValue: number,
  basicSalary: number,
  adminDeductionDays: number,
): number {
  const adminMoney = adminPenaltyMoney(basicSalary, adminDeductionDays);
  return Math.max(0, round2(penaltyDeductionValue - adminMoney));
}

async function snapshotEditComparison(payrollId: string): Promise<void> {
  const payroll = await prisma.payroll.findUnique({
    where: { id: payrollId },
    include: { lines: true },
  });
  if (!payroll) return;

  const netBefore = round2(payroll.lines.reduce((s, l) => s + l.netSalary, 0));
  await prisma.payroll.update({
    where: { id: payrollId },
    data: { comparisonTotalNetBefore: netBefore },
  });

  for (const line of payroll.lines) {
    await prisma.payrollLine.update({
      where: { id: line.id },
      data: {
        editSnapshotSet: true,
        editNetBefore: line.netSalary,
        editManualDedBefore: manualDedTotal(line),
      },
    });
  }
}

async function finalizeEditComparison(payrollId: string, message: string): Promise<void> {
  const payroll = await prisma.payroll.findUnique({
    where: { id: payrollId },
    include: { lines: true },
  });
  if (!payroll) return;

  const netAfter = round2(payroll.lines.reduce((s, l) => s + l.netSalary, 0));
  await prisma.payroll.update({
    where: { id: payrollId },
    data: {
      showEditComparison: true,
      editImportMessage: message,
      comparisonTotalNetAfter: netAfter,
    },
  });
}

async function resolveEmployeeForImport(code: string, name?: string) {
  const byCode = await resolveEmployeeByCode(code);
  if (byCode) return byCode;
  const trimmedName = (name || '').trim();
  if (!trimmedName) return null;
  return prisma.employeeProfile.findFirst({
    where: {
      name: { contains: trimmedName, mode: 'insensitive' },
    },
    include: { department: true, workLocation: true },
  });
}

/** Apply one Excel data row onto a payroll line (days first, then direct, then money overrides). */
export function applyPayrollImportRowUpdates(params: {
  line: PayrollLine;
  row: unknown[];
  countCols: Record<string, number>;
  directCols: Partial<Record<keyof PayrollLine, number>>;
  moneyCols: ReturnType<typeof resolveMoneyImportCols>;
  excelBasic: number;
  importedPenalty: boolean;
}): Record<string, number> {
  const { line, row, countCols, directCols, moneyCols, excelBasic, importedPenalty } = params;
  const updates: Record<string, number> = {};

  if (excelBasic > 0 && !line.basicSalary) {
    updates.basicSalary = excelBasic;
  }

  for (const spec of COUNT_IMPORT_SPECS) {
    const matchedKey = spec.excelKeys.find((k) => countCols[k] != null);
    if (!matchedKey) continue;
    const col = countCols[matchedKey]!;
    if (!cellHasImportValue(row[col])) continue;
    const val = parseFloatCell(row[col]);
    if (spec.countField) {
      updates[String(spec.countField)] = val;
      if (spec.countField === 'absentCount') {
        updates.absentDays = val;
      }
    }
    if (spec.moneyField) {
      const merged = {
        ...line,
        ...updates,
        basicSalary: updates.basicSalary ?? line.basicSalary,
      } as PayrollLine;
      const daily = dailyRateFromLine(merged, excelBasic);
      const mult = spec.multiplier ?? 1;
      updates[String(spec.moneyField)] = round2(val * mult * daily);
    }
  }

  for (const [field, col] of Object.entries(directCols) as [keyof PayrollLine, number][]) {
    if (!cellHasImportValue(row[col])) continue;
    updates[String(field)] = parseFloatCell(row[col]);
  }

  // Explicit money-column edits win over days×rate (and survive next Excel export).
  // Only apply when the cell is a literal number — untouched formulas are ignored.
  for (const money of moneyCols) {
    if (!isExplicitMoneyOverride(row[money.col])) continue;
    const val = parseFloatCell(row[money.col]);
    updates[String(money.field)] = val;
    if (money.clearFields) {
      for (const f of money.clearFields) updates[String(f)] = 0;
    }
    if (money.daysField) {
      const merged = {
        ...line,
        ...updates,
        basicSalary: updates.basicSalary ?? line.basicSalary,
      } as PayrollLine;
      const daily = dailyRateFromLine(merged, excelBasic);
      if (daily > 0) {
        updates[String(money.daysField)] = round2(val / daily);
        if (money.daysField === 'absentCount') {
          updates.absentDays = updates[String(money.daysField)];
        }
      }
    }
  }

  const merged = { ...line, ...updates } as PayrollLine;
  const basic = merged.basicSalary;
  const daily = dailyRateFromLine(merged, excelBasic);

  if (updates.workingDays != null || updates.basicSalary != null) {
    updates.workDaysSalary = round2(daily * merged.workingDays);
  }
  if (updates.overtimeHours != null || updates.basicSalary != null) {
    updates.overtimeAmount = round2(daily * merged.overtimeHours);
  }

  if (importedPenalty) {
    updates.penaltyDeductionValue = correctImportedPenalty(
      merged.penaltyDeductionValue || 0,
      basic,
      merged.adminDeduction || 0,
    );
  }

  return updates;
}

/** Mark line manual when newly added or deduction/earnings fields changed via Excel. */
export function shouldMarkManualLine(
  line: PayrollLine,
  updates: Record<string, number>,
  wasAdded: boolean,
): boolean {
  if (wasAdded) return true;
  if (line.isManual) return true;
  for (const [key, val] of Object.entries(updates)) {
    if (!MANUAL_LOCK_FIELDS.has(key)) continue;
    const prev = Number((line as unknown as Record<string, unknown>)[key] ?? 0);
    if (Math.abs(val - prev) > 0.001) return true;
  }
  return false;
}

export async function importPayrollXlsx(payrollId: string, base64: string) {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن استيراد Excel على كشف مؤكد', 400, 'ACTION_ERROR');
  }

  const rows = await loadSheetRows(base64);
  const { headerIdx, header } = findHeaderRow(rows);

  const codeCol = colIndex(header, ['employee_code']);
  if (codeCol < 0) throw new AppError('عمود employee_code غير موجود', 400, 'IMPORT_ERROR');
  const nameCol = colIndex(header, ['employee_name']);

  const basicCol = colIndex(header, ['basic_salary']);
  const countCols: Record<string, number> = {};
  for (const spec of COUNT_IMPORT_SPECS) {
    for (const key of spec.excelKeys) {
      if (header.includes(key) && !SKIP_IMPORT_KEYS.has(key)) {
        countCols[key] = header.indexOf(key);
        break;
      }
    }
  }
  const directCols = resolveDirectImportCols(header);
  const moneyCols = resolveMoneyImportCols(header);
  const importedPenalty = directCols.penaltyDeductionValue != null;

  await snapshotEditComparison(payrollId);

  let updated = 0;
  let added = 0;
  let skipped = 0;
  const codesInFile = new Set<string>();
  const employeeIdsInFile = new Set<string>();

  const maxSeq = await prisma.payrollLine.aggregate({
    where: { payrollId },
    _max: { sequence: true },
  });
  let nextSeq = (maxSeq._max.sequence || 0) + 1;

  for (const row of rows.slice(headerIdx + 1)) {
    if (!row) continue;
    const code = String(row[codeCol] ?? '').trim();
    if (!code) continue;
    codesInFile.add(code);

    const rowName = nameCol >= 0 ? String(row[nameCol] ?? '').trim() : '';
    const excelBasic = basicCol >= 0 ? parseFloatCell(row[basicCol]) : 0;

    let line = await prisma.payrollLine.findFirst({
      where: {
        payrollId,
        OR: [
          { employeeCode: code },
          { employee: { code } },
          { employee: { mapping: { biotimeEmpCode: code } } },
        ],
      },
    });

    let wasAdded = false;
    if (!line) {
      const employee = await resolveEmployeeForImport(code, rowName);
      if (!employee) {
        skipped++;
        continue;
      }

      const existingForEmp = await prisma.payrollLine.findFirst({
        where: { payrollId, employeeId: employee.id },
      });
      if (existingForEmp) {
        line = existingForEmp;
      } else {
        const empWithDept = await prisma.employeeProfile.findUnique({
          where: { id: employee.id },
          include: { department: true, workLocation: true },
        });
        const baseLine = {
          payrollId,
          employeeId: employee.id,
          sequence: nextSeq++,
          employeeCode: employee.code ?? code,
          basicSalary: employee.basicSalary || excelBasic || 0,
          workingDays: 26,
          overtimeHours: 0,
          overtimeAmount: 0,
          isManual: true,
          positionName: employee.jobTitle ?? '',
          departmentName: empWithDept?.department?.name ?? '',
          employeeLocation:
            empWithDept?.workLocation?.name ?? employee.location ?? '',
          socialInsurance: employee.insuranceSalary || 0,
          medicalInsurance: employee.medicalInsuranceSalary || 0,
          notes: 'مضاف يدوياً من استيراد Excel',
        };

        const totals = payrollLineTotalsForWrite(baseLine as PayrollLine, {
          socialInsurance: baseLine.socialInsurance,
          medicalInsurance: baseLine.medicalInsurance,
        });
        line = await prisma.payrollLine.create({
          data: {
            ...baseLine,
            ...totals,
          },
        });
        wasAdded = true;
        added++;
      }
    }

    const updates = applyPayrollImportRowUpdates({
      line,
      row,
      countCols,
      directCols,
      moneyCols,
      excelBasic,
      importedPenalty,
    });

    const merged = { ...line, ...updates } as PayrollLine;
    const totals = payrollLineTotalsForWrite(merged);
    await prisma.payrollLine.update({
      where: { id: line.id },
      data: {
        ...updates,
        ...totals,
        ...(shouldMarkManualLine(line, updates, wasAdded) ? { isManual: true } : {}),
      },
    });
    if (!wasAdded) updated++;
    employeeIdsInFile.add(line.employeeId);
  }

  // Odoo: delete lines whose codes are not in the file
  let deleted = 0;
  if (codesInFile.size) {
    const allLines = await prisma.payrollLine.findMany({
      where: { payrollId },
      select: {
        id: true,
        employeeId: true,
        employeeCode: true,
        employee: { select: { code: true, mapping: { select: { biotimeEmpCode: true } } } },
      },
    });
    const toDelete = allLines.filter((l) => {
      const codes = [
        l.employeeCode,
        l.employee?.code,
        l.employee?.mapping?.biotimeEmpCode,
      ]
        .filter(Boolean)
        .map((c) => String(c).trim());
      return !codes.some((c) => codesInFile.has(c));
    });
    if (toDelete.length) {
      const ids = toDelete.map((l) => l.id);
      await prisma.advanceShort.updateMany({
        where: { payrollLineId: { in: ids } },
        data: {
          payrollId: null,
          payrollLineId: null,
          state: AdvanceState.pending,
        },
      });
      await prisma.deduction.updateMany({
        where: { payrollLineId: { in: ids } },
        data: { payrollLineId: null, payrollId: null },
      });
      await prisma.advanceLongPayment.deleteMany({
        where: { payrollLineId: { in: ids } },
      });
      const del = await prisma.payrollLine.deleteMany({ where: { id: { in: ids } } });
      deleted = del.count;
      await addExcludedPayrollEmployees(
        payrollId,
        toDelete.map((l) => l.employeeId),
      );
    }
  }

  if (employeeIdsInFile.size) {
    await clearExcludedPayrollEmployees(payrollId, [...employeeIdsInFile]);
  }

  // Keep Excel amounts as written — do not overwrite with DB advances/penalty.
  // Use «ربط خصومات وسلف» / «حساب» (link-only after Excel) / «تصحيح الجزاء» when needed.
  await refreshPayrollHeaderTotals(payrollId);

  const deductionSync = await syncLinkedDeductionsFromPayrollImport(payrollId);

  await prisma.payroll.update({
    where: { id: payrollId },
    data: { excelImportedAt: new Date() },
  });

  const parts = [`تم تحديث ${updated} سطر`];
  if (added) parts.push(`إضافة ${added} موظف`);
  if (deleted) parts.push(`حذف ${deleted} غير موجود في الملف`);
  if (skipped) parts.push(`تخطي ${skipped} (كود غير معروف في النظام)`);
  if (deductionSync.updated) parts.push(`مزامنة ${deductionSync.updated} استقطاع`);
  const message = parts.join(' — ');

  await finalizeEditComparison(payrollId, message);

  return { updated, added, deleted, skipped, message };
}

export async function resetEditComparison(payrollId: string) {
  await prisma.payroll.update({
    where: { id: payrollId },
    data: {
      showEditComparison: false,
      editImportMessage: null,
      comparisonTotalNetBefore: 0,
      comparisonTotalNetAfter: 0,
    },
  });
  await prisma.payrollLine.updateMany({
    where: { payrollId },
    data: {
      editSnapshotSet: false,
      editNetBefore: 0,
      editManualDedBefore: 0,
    },
  });
  return { message: 'تم إعادة تعيين المقارنة' };
}
