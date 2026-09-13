/**
 * Period-level payroll downloads: cash/fawry ZIP for all branches + monthly summary Excel.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { utcDateOnly } from '../utils/payrollPeriod';
import {
  computePayrollJournalAmounts,
  round2 as journalRound2,
} from './odoo/payrollJournalAmounts';
import {
  computePayrollExcelSummary,
  exportCashFawryXlsx,
  isResignedLine,
  sanitizePayrollFilenamePart,
} from './payrollExport.service';
import { getSentSnapshotOrGenerate } from './payrollSentSnapshot.service';
import type { EmployeeProfile, PayrollLine } from '@prisma/client';

export type PeriodPayrollSummaryRow = {
  journalDate: string;
  branchName: string;
  payrollName: string;
  payrollId: string;
  /** إجمالي — same as payroll list period header (cash + fawry with commission). */
  salaries: number;
  companySocial: number;
  penalties: number;
  longAdvance: number;
  shortAdvance: number;
  checks: number;
  manualDebit: number;
  socialLib: number;
  medicalLib: number;
  /** مستحق مرتبات / صافي — cash + fawry without commission (list «صافي»). */
  netSalaries: number;
  cashTotal: number;
  fawryGrandTotal: number;
  fawryCommission: number;
  /** Employees on sheet who are not resigned (cash/fawry yellow logic). */
  activeEmployeeCount: number;
  resignedEmployeeCount: number;
  lineCount: number;
};

type LineWithEmp = PayrollLine & {
  employee?: EmployeeProfile | null;
};

function requirePeriod(dateFrom?: string | null, dateTo?: string | null): {
  from: Date;
  to: Date;
  fromStr: string;
  toStr: string;
} {
  const fromStr = String(dateFrom ?? '').slice(0, 10);
  const toStr = String(dateTo ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
    throw new AppError('حدد تاريخ البداية والنهاية للدورة', 400, 'VALIDATION_ERROR');
  }
  const from = utcDateOnly(new Date(`${fromStr}T00:00:00.000Z`));
  const to = utcDateOnly(new Date(`${toStr}T00:00:00.000Z`));
  if (from.getTime() > to.getTime()) {
    throw new AppError('تاريخ البداية بعد النهاية', 400, 'VALIDATION_ERROR');
  }
  return { from, to, fromStr, toStr };
}

function branchOf(payroll: {
  name: string | null;
  shiftGrid?: {
    name?: string | null;
    gridLocation?: string | null;
    location?: { name?: string | null } | null;
  } | null;
}): string {
  const grid = payroll.shiftGrid;
  return (
    grid?.location?.name?.trim() ||
    grid?.gridLocation?.trim() ||
    grid?.name?.trim() ||
    payroll.name?.trim() ||
    'بدون فرع'
  );
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthYearLabel(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Pure builder — used by Excel export + unit tests (must match sheet totals). */
export function buildPeriodPayrollSummaryRow(params: {
  journalDate: string;
  branchName: string;
  payrollName: string;
  payrollId: string;
  lines: LineWithEmp[];
}): PeriodPayrollSummaryRow {
  const journal = computePayrollJournalAmounts(params.lines);
  const excel = computePayrollExcelSummary(params.lines as never);
  let activeEmployeeCount = 0;
  let resignedEmployeeCount = 0;
  for (const line of params.lines) {
    if (isResignedLine(line)) resignedEmployeeCount += 1;
    else activeEmployeeCount += 1;
  }
  return {
    journalDate: params.journalDate,
    branchName: params.branchName,
    payrollName: params.payrollName,
    payrollId: params.payrollId,
    // Match list header «إجمالي» / «صافي» — not journal totalEarnings (gross before deductions).
    salaries: excel.grandTotal,
    companySocial: journal.companySocial,
    penalties: journal.penalties,
    longAdvance: journal.longTermAdvance,
    shortAdvance: journal.salaryAdvance,
    checks: journal.deductionChecks,
    manualDebit: journal.manualDebit,
    socialLib: journal.totalSocialLib,
    medicalLib: journal.totalMedicalLib,
    netSalaries: journalRound2(excel.cashTotal + excel.fawryTotal),
    cashTotal: excel.cashTotal,
    fawryGrandTotal: excel.fawryGrandTotal,
    fawryCommission: excel.fawryCommission,
    activeEmployeeCount,
    resignedEmployeeCount,
    lineCount: params.lines.length,
  };
}

export function sumPeriodPayrollSummaryRows(
  rows: PeriodPayrollSummaryRow[],
): Omit<
  PeriodPayrollSummaryRow,
  'journalDate' | 'branchName' | 'payrollName' | 'payrollId'
> {
  const sum = {
    salaries: 0,
    companySocial: 0,
    penalties: 0,
    longAdvance: 0,
    shortAdvance: 0,
    checks: 0,
    manualDebit: 0,
    socialLib: 0,
    medicalLib: 0,
    netSalaries: 0,
    cashTotal: 0,
    fawryGrandTotal: 0,
    fawryCommission: 0,
    activeEmployeeCount: 0,
    resignedEmployeeCount: 0,
    lineCount: 0,
  };
  for (const r of rows) {
    sum.salaries += r.salaries;
    sum.companySocial += r.companySocial;
    sum.penalties += r.penalties;
    sum.longAdvance += r.longAdvance;
    sum.shortAdvance += r.shortAdvance;
    sum.checks += r.checks;
    sum.manualDebit += r.manualDebit;
    sum.socialLib += r.socialLib;
    sum.medicalLib += r.medicalLib;
    sum.netSalaries += r.netSalaries;
    sum.cashTotal += r.cashTotal;
    sum.fawryGrandTotal += r.fawryGrandTotal;
    sum.fawryCommission += r.fawryCommission;
    sum.activeEmployeeCount += r.activeEmployeeCount;
    sum.resignedEmployeeCount += r.resignedEmployeeCount;
    sum.lineCount += r.lineCount;
  }
  return {
    salaries: journalRound2(sum.salaries),
    companySocial: journalRound2(sum.companySocial),
    penalties: journalRound2(sum.penalties),
    longAdvance: journalRound2(sum.longAdvance),
    shortAdvance: journalRound2(sum.shortAdvance),
    checks: journalRound2(sum.checks),
    manualDebit: journalRound2(sum.manualDebit),
    socialLib: journalRound2(sum.socialLib),
    medicalLib: journalRound2(sum.medicalLib),
    netSalaries: journalRound2(sum.netSalaries),
    cashTotal: journalRound2(sum.cashTotal),
    fawryGrandTotal: journalRound2(sum.fawryGrandTotal),
    fawryCommission: journalRound2(sum.fawryCommission),
    activeEmployeeCount: sum.activeEmployeeCount,
    resignedEmployeeCount: sum.resignedEmployeeCount,
    lineCount: sum.lineCount,
  };
}

async function loadPeriodPayrolls(from: Date, to: Date) {
  return prisma.payroll.findMany({
    where: { dateFrom: from, dateTo: to },
    include: {
      shiftGrid: { include: { location: true } },
      lines: {
        include: {
          employee: true,
        },
        orderBy: { sequence: 'asc' },
      },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
}

export async function buildPeriodPayrollSummaryRows(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<{
  dateFrom: string;
  dateTo: string;
  monthLabel: string;
  rows: PeriodPayrollSummaryRow[];
  totals: ReturnType<typeof sumPeriodPayrollSummaryRows>;
}> {
  const { from, to, fromStr, toStr } = requirePeriod(params.dateFrom, params.dateTo);
  const payrolls = await loadPeriodPayrolls(from, to);
  if (!payrolls.length) {
    throw new AppError('لا توجد كشوف رواتب في هذه الدورة', 400, 'ACTION_ERROR');
  }

  const rows: PeriodPayrollSummaryRow[] = [];
  for (const p of payrolls) {
    rows.push(
      buildPeriodPayrollSummaryRow({
        journalDate: isoDate(p.dateTo),
        branchName: branchOf(p),
        payrollName: p.name ?? '',
        payrollId: p.id,
        lines: p.lines,
      }),
    );
  }
  rows.sort((a, b) => a.branchName.localeCompare(b.branchName, 'ar'));
  return {
    dateFrom: fromStr,
    dateTo: toStr,
    monthLabel: monthYearLabel(to),
    rows,
    totals: sumPeriodPayrollSummaryRows(rows),
  };
}

const SUMMARY_HEADERS = [
  'تاريخ القيد',
  'الفرع',
  'إجمالي',
  'مصروف تأمينات اجتماعية حصة الشركة',
  'جزاءات العاملين',
  'سلف طويلة الأجل',
  'سلفة مؤقتة',
  'تحميلات / شيكات شخصية',
  'المانيوال ديبت',
  'مستحق تأمينات اجتماعية (إجمالي)',
  'مقدم تأمينات طبية (إجمالي)',
  'صافي',
  'إجمالي الكاش',
  'إجمالي الفوري (شامل العمولة)',
  'عمولة فوري (0.15%)',
  'عدد الموظفين',
  'عدد الاستقالات',
] as const;

export async function exportPeriodPayrollSummaryXlsx(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<{ base64: string; filename: string }> {
  const { dateFrom, dateTo, monthLabel, rows, totals } =
    await buildPeriodPayrollSummaryRows(params);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('ملخص رواتب شهر');
  sheet.views = [{ rightToLeft: true }];

  const title = `ملخص رواتب شهر ${monthLabel}`;
  sheet.mergeCells(1, 1, 1, SUMMARY_HEADERS.length);
  sheet.getCell(1, 1).value = title;
  sheet.getCell(1, 1).font = { bold: true, size: 14 };
  sheet.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 24;

  const headerRow = sheet.getRow(3);
  SUMMARY_HEADERS.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1A5276' },
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  headerRow.height = 32;

  const moneyCols = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  let r = 4;
  for (const row of rows) {
    const values: (string | number)[] = [
      row.journalDate,
      row.branchName,
      row.salaries,
      row.companySocial,
      row.penalties,
      row.longAdvance,
      row.shortAdvance,
      row.checks,
      row.manualDebit,
      row.socialLib,
      row.medicalLib,
      row.netSalaries,
      row.cashTotal,
      row.fawryGrandTotal,
      row.fawryCommission,
      row.activeEmployeeCount,
      row.resignedEmployeeCount,
    ];
    values.forEach((v, i) => {
      const cell = sheet.getCell(r, i + 1);
      cell.value = v;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      if (moneyCols.has(i + 1)) cell.numFmt = '#,##0.00';
    });
    r += 1;
  }

  const totalValues: (string | number)[] = [
    'الإجمالي',
    '',
    totals.salaries,
    totals.companySocial,
    totals.penalties,
    totals.longAdvance,
    totals.shortAdvance,
    totals.checks,
    totals.manualDebit,
    totals.socialLib,
    totals.medicalLib,
    totals.netSalaries,
    totals.cashTotal,
    totals.fawryGrandTotal,
    totals.fawryCommission,
    totals.activeEmployeeCount,
    totals.resignedEmployeeCount,
  ];
  totalValues.forEach((v, i) => {
    const cell = sheet.getCell(r, i + 1);
    cell.value = v;
    cell.font = { bold: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E9EE' },
    };
    if (moneyCols.has(i + 1)) cell.numFmt = '#,##0.00';
  });

  SUMMARY_HEADERS.forEach((_, i) => {
    sheet.getColumn(i + 1).width = i === 1 ? 28 : i === 0 ? 14 : 16;
  });

  const buf = Buffer.from(await workbook.xlsx.writeBuffer());
  const filename = `ملخص_رواتب_${sanitizePayrollFilenamePart(monthLabel)}_${dateFrom}_${dateTo}.xlsx`;
  return { base64: buf.toString('base64'), filename };
}

/** ZIP of Cash+Fawry workbooks (same as detail «نقدي») — one file per payroll in the cycle. */
export async function exportPeriodCashFawryZip(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<{ base64: string; filename: string; fileCount: number }> {
  const { from, to, fromStr, toStr } = requirePeriod(params.dateFrom, params.dateTo);
  const payrolls = await prisma.payroll.findMany({
    where: { dateFrom: from, dateTo: to },
    include: { shiftGrid: { include: { location: true } }, _count: { select: { lines: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  if (!payrolls.length) {
    throw new AppError('لا توجد كشوف رواتب في هذه الدورة', 400, 'ACTION_ERROR');
  }

  const zip = new JSZip();
  let fileCount = 0;
  const usedNames = new Set<string>();

  for (const p of payrolls) {
    if (!p._count.lines) continue;
    const { base64, filename } = await getSentSnapshotOrGenerate(p.id, 'cashFawry', () =>
      exportCashFawryXlsx(p.id),
    );
    let name = filename;
    if (usedNames.has(name)) {
      name = filename.replace(/\.xlsx$/i, `_${p.id.slice(-6)}.xlsx`);
    }
    usedNames.add(name);
    zip.file(name, Buffer.from(base64, 'base64'));
    fileCount += 1;
  }

  if (!fileCount) {
    throw new AppError('لا توجد سطور رواتب في كشوف هذه الدورة', 400, 'ACTION_ERROR');
  }

  const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    base64: zipBuf.toString('base64'),
    filename: `payroll_cash_fawry_${fromStr}_${toStr}.zip`,
    fileCount,
  };
}

export function exportZipFileResponse(base64: string, filename: string) {
  return {
    file: base64,
    base64,
    filename,
    mimeType: 'application/zip',
  };
}
