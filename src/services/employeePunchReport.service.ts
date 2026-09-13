import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { resolveEmployeeDisplayName } from './serialize.service';
import * as syncService from './biotime/sync.service';
import { exportFileResponse } from './payrollExport.service';

const COLORS = {
  titleBg: 'FF4F46E5',
  titleFg: 'FFFFFFFF',
  subtitleBg: 'FF6366F1',
  subtitleFg: 'FFFFFFFF',
  infoBg: 'FFEEF2FF',
  infoFg: 'FF3730A3',
  headerBg: 'FF312E81',
  headerFg: 'FFFFFFFF',
  border: 'FFD9DEE7',
  zebra: 'FFF6F7FB',
  checkInBg: 'FFE8F7EF',
  checkInFg: 'FF0F7A4E',
  checkOutBg: 'FFFDECEC',
  checkOutFg: 'FFB42318',
  summaryBg: 'FFF1F5F9',
  summaryFg: 'FF1E293B',
} as const;

type EmpWithRelations = Awaited<ReturnType<typeof loadEmployee>>;

async function loadEmployee(employeeId: string) {
  const emp = await prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    include: { mapping: true, department: true, workLocation: true },
  });
  if (!emp) throw new NotFoundError('Employee not found');
  return emp;
}

function employeeCodes(emp: {
  code?: string | null;
  identificationId?: string | null;
  barcode?: string | null;
  mapping?: { biotimeEmpCode: string | null } | null;
}): string[] {
  const codes = new Set<string>();
  for (const c of [
    emp.code,
    emp.identificationId,
    emp.barcode,
    emp.mapping?.biotimeEmpCode,
  ]) {
    const t = c?.trim();
    if (t) codes.add(t);
  }
  return [...codes];
}

function punchStateLabel(state: string | null | undefined): string {
  const s = (state ?? '').toLowerCase();
  if (s.includes('check_in') || s === '0' || s === 'in') return 'حضور';
  if (s.includes('check_out') || s === '1' || s === 'out') return 'انصراف';
  return state?.trim() || '—';
}

function formatDateLocal(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTimeLocal(d: Date): string {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

const ARABIC_WEEKDAYS = [
  'الأحد',
  'الإثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت',
] as const;

function weekdayLabel(d: Date): string {
  return ARABIC_WEEKDAYS[d.getUTCDay()] ?? '';
}

async function resolveDeviceFromTransactions(
  emp: EmpWithRelations,
  dateFrom: Date,
  dateTo: Date,
) {
  const codes = employeeCodes(emp);
  const txs = await prisma.transaction.findMany({
    where: {
      punchTime: { gte: dateFrom, lte: dateTo },
      OR: [
        { employeeId: emp.id },
        ...(codes.length ? [{ empCode: { in: codes } }] : []),
      ],
    },
    orderBy: { punchTime: 'desc' },
    take: 2000,
  });

  const snCounts = new Map<string, number>();
  const aliasCounts = new Map<string, number>();
  for (const tx of txs) {
    const sn = tx.terminalSn?.trim();
    if (sn) snCounts.set(sn, (snCounts.get(sn) ?? 0) + 1);
    const alias = tx.terminalAlias?.trim();
    if (alias) aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
  }

  const byCount = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  for (const sn of byCount(snCounts)) {
    const device = await prisma.device.findFirst({ where: { serialNumber: sn } });
    if (device) return device;
  }
  for (const alias of byCount(aliasCounts)) {
    const device = await prisma.device.findFirst({
      where: {
        OR: [
          { alias: { equals: alias, mode: 'insensitive' } },
          { name: { equals: alias, mode: 'insensitive' } },
        ],
      },
    });
    if (device) return device;
  }
  return null;
}

function transactionWhere(emp: EmpWithRelations, dateFrom: Date, dateTo: Date) {
  const codes = employeeCodes(emp);
  return {
    punchTime: { gte: dateFrom, lte: dateTo },
    OR: [
      { employeeId: emp.id },
      ...(codes.length ? [{ empCode: { in: codes } }] : []),
    ],
  };
}

/** Resolve the set of BioTime emp codes for an employee (throws if not found). */
export async function resolveEmployeeBiotimeCodes(employeeId: string): Promise<string[]> {
  const emp = await loadEmployee(employeeId);
  return employeeCodes(emp);
}

/** Resolve BioTime emp codes for many employees (skips missing / code-less). */
export async function resolveEmployeesBiotimeCodes(employeeIds: string[]): Promise<{
  codes: string[];
  resolved: Array<{ employeeId: string; codes: string[] }>;
  missing: string[];
}> {
  const ids = [...new Set(employeeIds.map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) return { codes: [], resolved: [], missing: [] };

  const employees = await prisma.employeeProfile.findMany({
    where: { id: { in: ids } },
    include: { mapping: true },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));
  const resolved: Array<{ employeeId: string; codes: string[] }> = [];
  const missing: string[] = [];
  const codes = new Set<string>();

  for (const id of ids) {
    const emp = byId.get(id);
    if (!emp) {
      missing.push(id);
      continue;
    }
    const empCodes = employeeCodes(emp);
    if (!empCodes.length) {
      missing.push(id);
      continue;
    }
    resolved.push({ employeeId: id, codes: empCodes });
    for (const c of empCodes) codes.add(c);
  }

  return { codes: [...codes], resolved, missing };
}

export type EmployeePunchReportOptions = {
  dateFrom?: Date;
  dateTo?: Date;
  /** false = cache only; true | 'full' = BioTime pull for date range; 'incremental' = new punches since last sync */
  sync?: boolean | 'incremental' | 'full';
};

export async function fetchEmployeePunchReport(
  employeeId: string,
  options: EmployeePunchReportOptions = {},
) {
  const emp = await loadEmployee(employeeId);
  const dateTo = options.dateTo ?? new Date();
  const dateFrom =
    options.dateFrom ?? new Date(dateTo.getTime() - 90 * 24 * 60 * 60 * 1000);

  let syncedCount = 0;
  if (options.sync === 'incremental') {
    syncedCount = await syncService.syncTransactionsIncremental();
  } else if (options.sync === 'full') {
    syncedCount = await syncService.syncTransactions(dateFrom, dateTo);
  } else if (options.sync === true) {
    // Targeted sync for just this employee — fast enough to stay within request timeouts.
    syncedCount = await syncService.syncEmployeeTransactions(
      employeeCodes(emp),
      dateFrom,
      dateTo,
    );
  }

  const device = await resolveDeviceFromTransactions(emp, dateFrom, dateTo);
  let deviceUpdated = false;
  if (device && emp.biotimeDeviceId !== device.id) {
    await prisma.employeeProfile.update({
      where: { id: emp.id },
      data: { biotimeDeviceId: device.id },
    });
    deviceUpdated = true;
  }

  const punches = await prisma.transaction.findMany({
    where: transactionWhere(emp, dateFrom, dateTo),
    orderBy: { punchTime: 'desc' },
    take: 5000,
  });

  const displayName = resolveEmployeeDisplayName(emp);
  const code = employeeCodes(emp)[0] ?? '';

  const items = punches.map((t) => ({
    id: t.id,
    punchTime: t.punchTime.toISOString(),
    date: formatDateLocal(t.punchTime),
    weekday: weekdayLabel(t.punchTime),
    time: formatTimeLocal(t.punchTime),
    punchState: t.punchState ?? '',
    punchStateLabel: punchStateLabel(t.punchState),
    terminalAlias: t.terminalAlias ?? '',
    terminalSn: t.terminalSn ?? '',
    empCode: t.empCode ?? '',
  }));

  const terminalSet = new Set(
    items.map((i) => i.terminalAlias || i.terminalSn).filter(Boolean),
  );

  return {
    employeeId: emp.id,
    employeeName: displayName,
    employeeCode: code,
    deviceId: device?.id ?? emp.biotimeDeviceId ?? null,
    deviceName: device?.name ?? device?.alias ?? '',
    dateFrom: formatDateLocal(dateFrom),
    dateTo: formatDateLocal(dateTo),
    syncedCount,
    deviceUpdated,
    items,
    count: items.length,
    terminalCount: terminalSet.size,
    message:
      items.length > 0
        ? `تم جلب ${items.length} بصمة${deviceUpdated ? ' — وتم تحديث جهاز البصمة' : ''}`
        : syncedCount > 0
          ? 'تمت المزامنة — لا توجد بصمات لهذا الموظف في الفترة'
          : 'لا توجد بصمات في الفترة المحددة — جرّب مزامنة البصمات من الإعدادات',
  };
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

export async function exportEmployeePunchReportXlsx(
  employeeId: string,
  options: EmployeePunchReportOptions = {},
) {
  const report = await fetchEmployeePunchReport(employeeId, options);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hudoori';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('بصمات الموظف', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 5, activeCell: 'A6' }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const headers = ['#', 'التاريخ', 'اليوم', 'الوقت', 'نوع البصمة', 'الجهاز', 'الرقم التسلسلي'];
  const colCount = headers.length;

  const thinBorder = (): Partial<ExcelJS.Borders> => {
    const side = { style: 'thin' as const, color: { argb: COLORS.border } };
    return { top: side, left: side, bottom: side, right: side };
  };

  const widths = [6, 14, 12, 12, 14, 22, 18];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

  // Row 1 — Title
  sheet.mergeCells(1, 1, 1, colCount);
  const title = sheet.getCell(1, 1);
  title.value = `تقرير بصمات الموظف`;
  title.font = { bold: true, size: 16, color: { argb: COLORS.titleFg } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.titleBg } };
  title.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 34;

  // Row 2 — Employee name / code
  sheet.mergeCells(2, 1, 2, colCount);
  const sub = sheet.getCell(2, 1);
  sub.value = `${report.employeeName}${report.employeeCode ? `  —  كود: ${report.employeeCode}` : ''}`;
  sub.font = { bold: true, size: 12, color: { argb: COLORS.subtitleFg } };
  sub.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.subtitleBg } };
  sub.alignment = { vertical: 'middle', horizontal: 'center', readingOrder: 'rtl' };
  sheet.getRow(2).height = 24;

  // Row 3 — Period + device
  sheet.mergeCells(3, 1, 3, colCount);
  const info = sheet.getCell(3, 1);
  info.value = `الفترة: من ${report.dateFrom} إلى ${report.dateTo}    •    الجهاز: ${report.deviceName || '—'}`;
  info.font = { size: 11, color: { argb: COLORS.infoFg } };
  info.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.infoBg } };
  info.alignment = { vertical: 'middle', horizontal: 'center', readingOrder: 'rtl' };
  info.border = thinBorder();
  sheet.getRow(3).height = 20;

  // Row 4 — Summary (totals / check-in / check-out)
  const checkInCount = report.items.filter((p) => p.punchStateLabel === 'حضور').length;
  const checkOutCount = report.items.filter((p) => p.punchStateLabel === 'انصراف').length;
  sheet.mergeCells(4, 1, 4, colCount);
  const summary = sheet.getCell(4, 1);
  summary.value = `إجمالي البصمات: ${report.count}    •    حضور: ${checkInCount}    •    انصراف: ${checkOutCount}`;
  summary.font = { bold: true, size: 11, color: { argb: COLORS.summaryFg } };
  summary.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.summaryBg } };
  summary.alignment = { vertical: 'middle', horizontal: 'center', readingOrder: 'rtl' };
  summary.border = thinBorder();
  sheet.getRow(4).height = 20;

  // Row 5 — Column headers
  const headerRow = sheet.getRow(5);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10.5, color: { argb: COLORS.headerFg } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    cell.border = thinBorder();
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  headerRow.height = 26;

  const firstDataRow = 6;
  report.items.forEach((p, idx) => {
    const rowIndex = firstDataRow + idx;
    const row = sheet.getRow(rowIndex);
    const isCheckIn = p.punchStateLabel === 'حضور';
    const isCheckOut = p.punchStateLabel === 'انصراف';
    const values = [idx + 1, p.date, p.weekday, p.time, p.punchStateLabel, p.terminalAlias, p.terminalSn];
    values.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      cell.border = thinBorder();
      cell.alignment = { vertical: 'middle', horizontal: 'center', readingOrder: 'rtl' };
      if (idx % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.zebra } };
      }
      // Punch-type column: color code حضور / انصراف
      if (i === 4) {
        cell.font = {
          bold: true,
          size: 10,
          color: { argb: isCheckIn ? COLORS.checkInFg : isCheckOut ? COLORS.checkOutFg : COLORS.summaryFg },
        };
        if (isCheckIn || isCheckOut) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: isCheckIn ? COLORS.checkInBg : COLORS.checkOutBg },
          };
        }
      }
    });
    row.height = 20;
  });

  // Auto-filter over the header + data
  const lastRow = Math.max(firstDataRow, firstDataRow + report.items.length - 1);
  sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: lastRow, column: colCount } };

  const base64 = await workbookToBase64(workbook);
  const safeName = report.employeeCode || report.employeeId.slice(-6);
  return exportFileResponse(base64, `punches_${safeName}_${report.dateFrom}_${report.dateTo}.xlsx`);
}

/**
 * Combined raw-punches export for multiple selected employees within a date range.
 * Produces a single styled sheet (one row per punch) with employee columns,
 * sorted by employee then punch time. Reads from cache only — fast and safe
 * within proxy request limits.
 */
export async function exportEmployeesPunchesXlsx(
  employeeIds: string[],
  options: { dateFrom?: Date; dateTo?: Date; title?: string; filenamePrefix?: string } = {},
) {
  const dateTo = options.dateTo ?? new Date();
  const dateFrom =
    options.dateFrom ?? new Date(dateTo.getTime() - 90 * 24 * 60 * 60 * 1000);

  const emps = await prisma.employeeProfile.findMany({
    where: { id: { in: employeeIds } },
    include: { mapping: true, department: true, workLocation: true },
  });
  emps.sort((a, b) =>
    resolveEmployeeDisplayName(a).localeCompare(resolveEmployeeDisplayName(b), 'ar'),
  );

  type PunchRow = {
    employeeCode: string;
    employeeName: string;
    date: string;
    weekday: string;
    time: string;
    punchStateLabel: string;
    terminalAlias: string;
    terminalSn: string;
    sortKey: number;
  };

  const rows: PunchRow[] = [];
  let checkInCount = 0;
  let checkOutCount = 0;

  for (const emp of emps) {
    const code = employeeCodes(emp)[0] ?? '';
    const name = resolveEmployeeDisplayName(emp);
    const punches = await prisma.transaction.findMany({
      where: transactionWhere(emp, dateFrom, dateTo),
      orderBy: { punchTime: 'asc' },
      take: 5000,
    });
    for (const t of punches) {
      const label = punchStateLabel(t.punchState);
      if (label === 'حضور') checkInCount++;
      else if (label === 'انصراف') checkOutCount++;
      rows.push({
        employeeCode: code,
        employeeName: name,
        date: formatDateLocal(t.punchTime),
        weekday: weekdayLabel(t.punchTime),
        time: formatTimeLocal(t.punchTime),
        punchStateLabel: label,
        terminalAlias: t.terminalAlias ?? '',
        terminalSn: t.terminalSn ?? '',
        sortKey: t.punchTime.getTime(),
      });
    }
  }

  rows.sort((a, b) => {
    const byName = a.employeeName.localeCompare(b.employeeName, 'ar');
    return byName !== 0 ? byName : a.sortKey - b.sortKey;
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hudoori';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('بصمات الموظفين', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 4, activeCell: 'A5' }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const headers = [
    '#',
    'كود الموظف',
    'اسم الموظف',
    'التاريخ',
    'اليوم',
    'الوقت',
    'نوع البصمة',
    'الجهاز',
    'الرقم التسلسلي',
  ];
  const colCount = headers.length;

  const thinBorder = (): Partial<ExcelJS.Borders> => {
    const side = { style: 'thin' as const, color: { argb: COLORS.border } };
    return { top: side, left: side, bottom: side, right: side };
  };

  const widths = [6, 14, 24, 14, 12, 12, 14, 20, 16];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

  const fromLabel = formatDateLocal(dateFrom);
  const toLabel = formatDateLocal(dateTo);

  sheet.mergeCells(1, 1, 1, colCount);
  const title = sheet.getCell(1, 1);
  title.value = options.title ?? 'تقرير بصمات الموظفين المحددين';
  title.font = { bold: true, size: 16, color: { argb: COLORS.titleFg } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.titleBg } };
  title.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 34;

  sheet.mergeCells(2, 1, 2, colCount);
  const info = sheet.getCell(2, 1);
  info.value = `الفترة: من ${fromLabel} إلى ${toLabel}    •    عدد الموظفين: ${emps.length}`;
  info.font = { size: 11, color: { argb: COLORS.infoFg } };
  info.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.infoBg } };
  info.alignment = { vertical: 'middle', horizontal: 'center', readingOrder: 'rtl' };
  info.border = thinBorder();
  sheet.getRow(2).height = 20;

  sheet.mergeCells(3, 1, 3, colCount);
  const summary = sheet.getCell(3, 1);
  summary.value = `إجمالي البصمات: ${rows.length}    •    حضور: ${checkInCount}    •    انصراف: ${checkOutCount}`;
  summary.font = { bold: true, size: 11, color: { argb: COLORS.summaryFg } };
  summary.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.summaryBg } };
  summary.alignment = { vertical: 'middle', horizontal: 'center', readingOrder: 'rtl' };
  summary.border = thinBorder();
  sheet.getRow(3).height = 20;

  const headerRow = sheet.getRow(4);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10.5, color: { argb: COLORS.headerFg } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    cell.border = thinBorder();
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  headerRow.height = 26;

  const firstDataRow = 5;
  let prevName = '';
  let zebra = false;
  rows.forEach((p, idx) => {
    if (p.employeeName !== prevName) {
      zebra = !zebra;
      prevName = p.employeeName;
    }
    const row = sheet.getRow(firstDataRow + idx);
    const isCheckIn = p.punchStateLabel === 'حضور';
    const isCheckOut = p.punchStateLabel === 'انصراف';
    const values = [
      idx + 1,
      p.employeeCode,
      p.employeeName,
      p.date,
      p.weekday,
      p.time,
      p.punchStateLabel,
      p.terminalAlias,
      p.terminalSn,
    ];
    values.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      cell.border = thinBorder();
      cell.alignment = {
        vertical: 'middle',
        horizontal: i === 2 ? 'right' : 'center',
        readingOrder: 'rtl',
      };
      if (zebra) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.zebra } };
      }
      if (i === 6) {
        cell.font = {
          bold: true,
          size: 10,
          color: { argb: isCheckIn ? COLORS.checkInFg : isCheckOut ? COLORS.checkOutFg : COLORS.summaryFg },
        };
        if (isCheckIn || isCheckOut) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: isCheckIn ? COLORS.checkInBg : COLORS.checkOutBg },
          };
        }
      }
    });
    row.height = 20;
  });

  const lastRow = Math.max(firstDataRow, firstDataRow + rows.length - 1);
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: lastRow, column: colCount } };

  const base64 = await workbookToBase64(workbook);
  const prefix = options.filenamePrefix ?? 'punches_selected';
  return exportFileResponse(base64, `${prefix}_${fromLabel}_${toLabel}.xlsx`);
}

/**
 * Export raw punches for all employees that have NO work location assigned
 * but do have punches within the date range. Useful to spot employees who
 * still need a location before payroll.
 */
export async function exportUnlocatedEmployeesPunchesXlsx(
  options: { dateFrom?: Date; dateTo?: Date } = {},
) {
  const dateTo = options.dateTo ?? new Date();
  // Default to all-time so every unlocated employee with any punch is included.
  const dateFrom = options.dateFrom ?? new Date('2015-01-01T00:00:00.000Z');

  const emps = await prisma.employeeProfile.findMany({
    where: { locationId: null },
    include: { mapping: true, department: true, workLocation: true },
  });

  const punchRefs = await prisma.transaction.findMany({
    where: { punchTime: { gte: dateFrom, lte: dateTo } },
    select: { employeeId: true, empCode: true },
  });
  const punchEmpIds = new Set<string>();
  const punchCodes = new Set<string>();
  for (const t of punchRefs) {
    if (t.employeeId) punchEmpIds.add(t.employeeId);
    const c = t.empCode?.trim();
    if (c) punchCodes.add(c);
  }

  const withPunches = emps
    .filter(
      (emp) =>
        punchEmpIds.has(emp.id) || employeeCodes(emp).some((c) => punchCodes.has(c)),
    )
    .map((e) => e.id);

  if (!withPunches.length) {
    throw new AppError(
      'لا يوجد موظفون بدون لوكيشن لديهم بصمات في الفترة المحددة',
      404,
      'NOT_FOUND',
    );
  }

  return exportEmployeesPunchesXlsx(withPunches, {
    dateFrom,
    dateTo,
    title: 'بصمات الموظفين غير المرتبطين بلوكيشن',
    filenamePrefix: 'punches_no_location',
  });
}
