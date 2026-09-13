/**
 * Period-level payroll diagnostics: zero basic salary + cross-branch duplicates
 * + over-deducted (stored net clamped at 0).
 */
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { utcDateOnly } from '../utils/payrollPeriod';
import { isOverDeductedLine, overDeductionExcess, round2 } from './payrollLine.service';

export type PeriodZeroBasicRow = {
  lineId: string;
  payrollId: string;
  branchName: string;
  payrollName: string;
  payrollState: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  basicSalary: number;
  profileBasicSalary: number;
  netSalary: number;
};

export type PeriodDuplicateRow = {
  lineId: string;
  payrollId: string;
  branchName: string;
  payrollName: string;
  payrollState: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  occurrenceCount: number;
  otherBranches: string;
  note: string;
  basicSalary: number;
  netSalary: number;
};

export type PeriodNegativeNetRow = {
  lineId: string;
  payrollId: string;
  branchName: string;
  payrollName: string;
  payrollState: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  totalEarnings: number;
  totalDeductions: number;
  excess: number;
  signedNet: number;
  netSalary: number;
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

async function loadPeriodLines(from: Date, to: Date) {
  return prisma.payrollLine.findMany({
    where: {
      payroll: {
        dateFrom: from,
        dateTo: to,
      },
    },
    include: {
      employee: { select: { id: true, name: true, code: true, basicSalary: true } },
      payroll: {
        include: {
          shiftGrid: { include: { location: true } },
        },
      },
    },
    orderBy: [{ employeeCode: 'asc' }, { id: 'asc' }],
  });
}

function empKey(line: {
  employeeId: string;
  employeeCode: string | null;
  employee?: { code?: string | null } | null;
}): string {
  return (
    line.employeeId ||
    (line.employeeCode || line.employee?.code || '').trim().toLowerCase() ||
    ''
  );
}

export async function listPeriodZeroBasicSalary(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<{ dateFrom: string; dateTo: string; count: number; items: PeriodZeroBasicRow[] }> {
  const { from, to, fromStr, toStr } = requirePeriod(params.dateFrom, params.dateTo);
  const lines = await loadPeriodLines(from, to);
  const items: PeriodZeroBasicRow[] = [];
  for (const line of lines) {
    if ((line.basicSalary || 0) !== 0) continue;
    items.push({
      lineId: line.id,
      payrollId: line.payrollId,
      branchName: branchOf(line.payroll),
      payrollName: line.payroll.name ?? '',
      payrollState: line.payroll.state,
      employeeId: line.employeeId,
      employeeCode: line.employeeCode || line.employee?.code || '',
      employeeName: line.employee?.name || '',
      basicSalary: line.basicSalary || 0,
      profileBasicSalary: line.employee?.basicSalary || 0,
      netSalary: line.netSalary || 0,
    });
  }
  items.sort((a, b) => {
    const br = a.branchName.localeCompare(b.branchName, 'ar');
    if (br !== 0) return br;
    return a.employeeCode.localeCompare(b.employeeCode, 'en');
  });
  return { dateFrom: fromStr, dateTo: toStr, count: items.length, items };
}

export async function listPeriodDuplicates(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<{ dateFrom: string; dateTo: string; count: number; items: PeriodDuplicateRow[] }> {
  const { from, to, fromStr, toStr } = requirePeriod(params.dateFrom, params.dateTo);
  const lines = await loadPeriodLines(from, to);
  const grouped = new Map<string, typeof lines>();
  for (const line of lines) {
    const k = empKey(line);
    if (!k) continue;
    const list = grouped.get(k) ?? [];
    list.push(line);
    grouped.set(k, list);
  }

  const items: PeriodDuplicateRow[] = [];
  for (const [, group] of grouped) {
    if (group.length < 2) continue;
    const branches = [...new Set(group.map((l) => branchOf(l.payroll)))];
    for (const line of group) {
      const mine = branchOf(line.payroll);
      const others = branches.filter((b) => b !== mine);
      items.push({
        lineId: line.id,
        payrollId: line.payrollId,
        branchName: mine,
        payrollName: line.payroll.name ?? '',
        payrollState: line.payroll.state,
        employeeId: line.employeeId,
        employeeCode: line.employeeCode || line.employee?.code || '',
        employeeName: line.employee?.name || '',
        occurrenceCount: group.length,
        otherBranches: others.join('، '),
        note:
          branches.length > 1
            ? `مكرر ${group.length} مرات عبر فروع: ${branches.join('، ')}`
            : `مكرر ${group.length} مرات داخل نفس الفرع`,
        basicSalary: line.basicSalary || 0,
        netSalary: line.netSalary || 0,
      });
    }
  }

  items.sort((a, b) => {
    const c = a.employeeCode.localeCompare(b.employeeCode, 'en');
    if (c !== 0) return c;
    return a.branchName.localeCompare(b.branchName, 'ar');
  });
  return { dateFrom: fromStr, dateTo: toStr, count: items.length, items };
}

export async function listPeriodNegativeNet(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<{ dateFrom: string; dateTo: string; count: number; items: PeriodNegativeNetRow[] }> {
  const { from, to, fromStr, toStr } = requirePeriod(params.dateFrom, params.dateTo);
  const lines = await loadPeriodLines(from, to);
  const items: PeriodNegativeNetRow[] = [];
  for (const line of lines) {
    if (!isOverDeductedLine(line)) continue;
    const totalEarnings = round2(line.totalEarnings || 0);
    const totalDeductions = round2(line.totalDeductions || 0);
    items.push({
      lineId: line.id,
      payrollId: line.payrollId,
      branchName: branchOf(line.payroll),
      payrollName: line.payroll.name ?? '',
      payrollState: line.payroll.state,
      employeeId: line.employeeId,
      employeeCode: line.employeeCode || line.employee?.code || '',
      employeeName: line.employee?.name || '',
      totalEarnings,
      totalDeductions,
      excess: overDeductionExcess(totalEarnings, totalDeductions),
      signedNet: round2(totalEarnings - totalDeductions),
      netSalary: round2(line.netSalary || 0),
    });
  }
  items.sort((a, b) => {
    const br = a.branchName.localeCompare(b.branchName, 'ar');
    if (br !== 0) return br;
    const ex = b.excess - a.excess;
    if (ex !== 0) return ex;
    return a.employeeCode.localeCompare(b.employeeCode, 'en');
  });
  return { dateFrom: fromStr, dateTo: toStr, count: items.length, items };
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

function safeSheetName(raw: string, used: Set<string>): string {
  let base = (raw || 'sheet').replace(/[\\/*?:\[\]]/g, '_').trim().slice(0, 28) || 'sheet';
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = `_${i++}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function writeHeader(sheet: ExcelJS.Worksheet, headers: string[]) {
  const row = sheet.addRow(headers);
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8EEF5' },
    };
  });
}

/** One sheet per branch + «الكل», rows already sorted by branch. */
async function exportGroupedByBranchXlsx(params: {
  filenamePrefix: string;
  dateFrom: string;
  dateTo: string;
  headers: string[];
  rows: Array<{ branchName: string; cells: (string | number)[] }>;
}): Promise<{ base64: string; filename: string }> {
  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>();
  const all = workbook.addWorksheet(safeSheetName('الكل', used));
  writeHeader(all, params.headers);
  for (const r of params.rows) all.addRow(r.cells);
  all.columns.forEach((col) => {
    col.width = 16;
  });

  const byBranch = new Map<string, typeof params.rows>();
  for (const r of params.rows) {
    const list = byBranch.get(r.branchName) ?? [];
    list.push(r);
    byBranch.set(r.branchName, list);
  }
  const branchNames = [...byBranch.keys()].sort((a, b) => a.localeCompare(b, 'ar'));
  for (const branch of branchNames) {
    const sheet = workbook.addWorksheet(safeSheetName(branch, used));
    writeHeader(sheet, params.headers);
    for (const r of byBranch.get(branch)!) sheet.addRow(r.cells);
    sheet.columns.forEach((col) => {
      col.width = 16;
    });
  }

  return {
    base64: await workbookToBase64(workbook),
    filename: `${params.filenamePrefix}_${params.dateFrom}_${params.dateTo}.xlsx`,
  };
}

export async function exportPeriodZeroBasicSalaryXlsx(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<{ base64: string; filename: string }> {
  const { dateFrom, dateTo, items } = await listPeriodZeroBasicSalary(params);
  return exportGroupedByBranchXlsx({
    filenamePrefix: 'payroll_zero_basic',
    dateFrom,
    dateTo,
    headers: [
      'الفرع',
      'اسم الكشف',
      'حالة الكشف',
      'كود الموظف',
      'اسم الموظف',
      'أساسي (الكشف)',
      'أساسي (الملف)',
      'صافي',
    ],
    rows: items.map((r) => ({
      branchName: r.branchName,
      cells: [
        r.branchName,
        r.payrollName,
        r.payrollState,
        r.employeeCode,
        r.employeeName,
        r.basicSalary,
        r.profileBasicSalary,
        r.netSalary,
      ],
    })),
  });
}

export async function exportPeriodDuplicatesXlsx(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<{ base64: string; filename: string }> {
  const { dateFrom, dateTo, items } = await listPeriodDuplicates(params);
  return exportGroupedByBranchXlsx({
    filenamePrefix: 'payroll_period_duplicates',
    dateFrom,
    dateTo,
    headers: [
      'الفرع',
      'اسم الكشف',
      'حالة الكشف',
      'كود الموظف',
      'اسم الموظف',
      'عدد التكرار',
      'فروع أخرى',
      'أساسي',
      'صافي',
      'ملاحظة',
    ],
    rows: items.map((r) => ({
      branchName: r.branchName,
      cells: [
        r.branchName,
        r.payrollName,
        r.payrollState,
        r.employeeCode,
        r.employeeName,
        r.occurrenceCount,
        r.otherBranches,
        r.basicSalary,
        r.netSalary,
        r.note,
      ],
    })),
  });
}

export async function exportPeriodNegativeNetXlsx(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<{ base64: string; filename: string }> {
  const { dateFrom, dateTo, items } = await listPeriodNegativeNet(params);
  return exportGroupedByBranchXlsx({
    filenamePrefix: 'payroll_negative_net',
    dateFrom,
    dateTo,
    headers: [
      'الفرع',
      'اسم الكشف',
      'حالة الكشف',
      'كود الموظف',
      'اسم الموظف',
      'استحقاق',
      'خصومات',
      'صافي حقيقي',
      'زيادة الخصم',
      'صافي محفوظ',
    ],
    rows: items.map((r) => ({
      branchName: r.branchName,
      cells: [
        r.branchName,
        r.payrollName,
        r.payrollState,
        r.employeeCode,
        r.employeeName,
        r.totalEarnings,
        r.totalDeductions,
        r.signedNet,
        r.excess,
        r.netSalary,
      ],
    })),
  });
}

