/**
 * Odoo parity: biotime_payroll/models/payroll_advance_import.py
 */
import ExcelJS from 'exceljs';
import { PayrollLine, PayrollState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { loadSheetRows } from './deductionExcel.service';
import { exportFileResponse } from './payrollExport.service';
import {
  EDIT_MANUAL_DED_FIELDS,
  manualDedTotal,
  recalculatePayrollLineTotals,
  refreshPayrollHeaderTotals,
  round2,
} from './payrollLine.service';
import { normalizeHeader } from './payrollImport.service';

export const EDIT_TEMPLATE_FIELDS = [
  { key: 'deductionChecks', label: 'شيكات شخصية' },
  { key: 'manualDebit', label: 'مانيول ديبت' },
  { key: 'healthCertificatesDeduction', label: 'شهادات صحية' },
  { key: 'fractionDeduction', label: 'كسر' },
  { key: 'fines', label: 'خصومات' },
  { key: 'documentsDeduction', label: 'خصم اوراق' },
] as const;

type EditFieldKey = (typeof EDIT_TEMPLATE_FIELDS)[number]['key'];

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: 'thin' as const };
  return { top: side, left: side, bottom: side, right: side };
}

function applyStyle(cell: ExcelJS.Cell, style: Partial<ExcelJS.Style>) {
  if (style.font) cell.font = style.font as ExcelJS.Font;
  if (style.fill) cell.fill = style.fill as ExcelJS.Fill;
  if (style.alignment) cell.alignment = style.alignment as ExcelJS.Alignment;
  if (style.border) cell.border = style.border as ExcelJS.Borders;
  if (style.numFmt) cell.numFmt = style.numFmt;
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
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

function findHeaderRow(rows: unknown[][]): { headerIdx: number; header: string[] } {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const row = rows[i];
    if (!row) continue;
    const header = row.map(normalizeHeader);
    if (header.includes('employee_code')) {
      return { headerIdx: i, header };
    }
  }
  throw new AppError(
    'لم يتم العثور على صف المفاتيح (employee_code). تأكد أن الملف مُصدَّر من «تصدير قالب التعديل».',
    400,
    'IMPORT_ERROR',
  );
}

function parseFloatCell(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function exportPayrollEditTemplate(payrollId: string): Promise<string> {
  const payroll = await prisma.payroll.findUnique({
    where: { id: payrollId },
    include: {
      lines: {
        include: { employee: true },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (!payroll.lines.length) {
    throw new AppError('لا توجد سطور في كشف الرواتب', 400, 'ACTION_ERROR');
  }

  await snapshotEditComparison(payrollId);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('EditTemplate', { views: [{ rightToLeft: true }] });
  const meta = workbook.addWorksheet('_meta');

  const titleFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 12 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
  };
  const headerFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 10 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDD7EE' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
  };
  const readonlyFmt: Partial<ExcelJS.Style> = {
    font: { size: 10 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
  };
  const editableFmt: Partial<ExcelJS.Style> = {
    font: { size: 10 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFCC' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
    numFmt: '#,##0.##',
  };

  const infoLabels = ['كود الموظف', 'اسم الموظف', 'الوظيفة'];
  const infoKeys = ['employee_code', 'employee_name', 'position'];
  const fieldLabels = EDIT_TEMPLATE_FIELDS.map((f) => f.label);
  const fieldKeys = EDIT_TEMPLATE_FIELDS.map((f) => f.key);
  const lastCol = infoLabels.length + fieldLabels.length;

  sheet.mergeCells(1, 1, 1, lastCol);
  applyStyle(sheet.getCell(1, 1), titleFmt);
  sheet.getCell(1, 1).value = `قالب تعديل الخصومات — ${payroll.name || payrollId}`;

  sheet.mergeCells(2, 1, 2, lastCol);
  applyStyle(sheet.getCell(2, 1), headerFmt);
  sheet.getCell(2, 1).value = 'عدّل الأعمدة الصفراء فقط ثم ارفع الملف من «استيراد قالب التعديل»';

  const arabicHeaders = [...infoLabels, ...fieldLabels];
  const englishHeaders = [...infoKeys, ...fieldKeys];
  for (let c = 0; c < arabicHeaders.length; c++) {
    applyStyle(sheet.getCell(3, c + 1), headerFmt);
    sheet.getCell(3, c + 1).value = arabicHeaders[c];
    applyStyle(sheet.getCell(4, c + 1), headerFmt);
    sheet.getCell(4, c + 1).value = englishHeaders[c];
  }

  let row = 5;
  for (const line of payroll.lines) {
    applyStyle(sheet.getCell(row, 1), readonlyFmt);
    sheet.getCell(row, 1).value = line.employeeCode || '';
    applyStyle(sheet.getCell(row, 2), readonlyFmt);
    sheet.getCell(row, 2).value = line.employee?.name ?? '';
    applyStyle(sheet.getCell(row, 3), readonlyFmt);
    sheet.getCell(row, 3).value = line.positionName || '';
    for (let i = 0; i < fieldKeys.length; i++) {
      const key = fieldKeys[i] as EditFieldKey;
      applyStyle(sheet.getCell(row, 4 + i), editableFmt);
      sheet.getCell(row, 4 + i).value = (line[key] as number) || 0;
    }
    row++;
  }

  meta.getCell(1, 1).value = 'payroll_id';
  meta.getCell(1, 2).value = payroll.id;
  meta.getCell(2, 1).value = 'payroll_name';
  meta.getCell(2, 2).value = payroll.name || '';

  sheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: 4, xSplit: 3 }];
  return workbookToBase64(workbook);
}

export async function importPayrollEditTemplate(payrollId: string, base64: string) {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن استيراد قالب التعديل على كشف مؤكد', 400, 'ACTION_ERROR');
  }

  const rows = await loadSheetRows(base64);
  const { headerIdx, header } = findHeaderRow(rows);

  const codeCol = header.indexOf('employee_code');
  if (codeCol < 0) throw new AppError('عمود employee_code غير موجود', 400, 'IMPORT_ERROR');

  const fieldCols: Partial<Record<EditFieldKey, number>> = {};
  for (const f of EDIT_TEMPLATE_FIELDS) {
    const idx = header.indexOf(f.key);
    if (idx >= 0) fieldCols[f.key] = idx;
  }
  if (!Object.keys(fieldCols).length) {
    throw new AppError('لم يتم العثور على أي حقل قابل للتعديل في الملف', 400, 'IMPORT_ERROR');
  }

  await snapshotEditComparison(payrollId);

  let updated = 0;
  const skipped: string[] = [];

  for (const row of rows.slice(headerIdx + 1)) {
    if (!row) continue;
    const code = String(row[codeCol] ?? '').trim();
    if (!code) continue;

    const line = await prisma.payrollLine.findFirst({
      where: { payrollId, employeeCode: code },
      include: { employee: true },
    });
    if (!line) {
      skipped.push(code);
      continue;
    }

    const data: Partial<PayrollLine> = {};
    for (const [key, col] of Object.entries(fieldCols) as [EditFieldKey, number][]) {
      data[key] = parseFloatCell(row[col]);
    }

    const merged = { ...line, ...data } as PayrollLine;
    const totals = recalculatePayrollLineTotals(merged, {
      socialInsurance: line.employee?.insuranceSalary ?? line.socialInsurance,
      medicalInsurance: line.employee?.medicalInsuranceSalary ?? line.medicalInsurance,
    });

    await prisma.payrollLine.update({
      where: { id: line.id },
      data: {
        ...data,
        totalEarnings: totals.totalEarnings,
        grossSalary: totals.grossSalary,
        totalDeductions: totals.totalDeductions,
        netSalary: totals.netSalary,
        workDaysSalary: totals.workDaysSalary,
        overtimeAmount: totals.overtimeAmount,
      },
    });
    updated++;
  }

  await refreshPayrollHeaderTotals(payrollId);

  const fieldLabels = EDIT_TEMPLATE_FIELDS
    .filter((f) => fieldCols[f.key] != null)
    .map((f) => f.label)
    .join('، ');
  let message = `تم تحديث ${updated} سطر.\nالأعمدة المقروءة: ${fieldLabels}`;
  if (skipped.length) {
    message += `\nتم تخطي ${skipped.length} كود: ${skipped.slice(0, 10).join(', ')}`;
  }
  await finalizeEditComparison(payrollId, message);

  return { updated, skipped: skipped.length, message };
}

export { exportFileResponse };
