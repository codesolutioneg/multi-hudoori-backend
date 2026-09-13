/**
 * Port of Odoo biotime_integration/reports/punch_report_xlsx.py
 */
import ExcelJS from 'exceljs';
import {
  type PunchReportExportLine,
  computeEmployeeSummary,
  formatTimeAmPm,
  formatTimeShortAmPm,
  generatePunchReportLines,
  getIgnoredLateLineIds,
  type GeneratePunchReportLinesOptions,
} from './punchReportLine.service';
import { exportFileResponse } from './payrollExport.service';
import { getLatePolicy, lateDayFraction, type LatePolicy } from './latePolicy.service';
import { getPayablePeriodPolicy, resolveFullPayrollPeriodDays, resolvePayablePeriodDays } from './payablePeriod.service';
import { cairoDateOnly } from '../utils/payrollPeriod';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';

const DAY_NAMES: Record<number, string> = {
  0: 'الإثنين',
  1: 'الثلاثاء',
  2: 'الأربعاء',
  3: 'الخميس',
  4: 'الجمعة',
  5: 'السبت',
  6: 'الأحد',
};

const COLORS = {
  titleBg: 'FF4472C4',
  titleFg: 'FFFFFFFF',
  headerBg: 'FFD9E2F3',
  border: 'FFCCCCCC',
  offBg: 'FFFFF2CC',
  offFg: 'FFBF8F00',
  sickBg: 'FFFFD6D6',
  sickFg: 'FF842029',
  annualBg: 'FFCFE2FF',
  annualFg: 'FF084298',
  absentBg: 'FFFFC7CE',
  absentFg: 'FF9C0006',
  ignoredLateBg: 'FFC6EFCE',
  ignoredLateFg: 'FF006100',
  missingInBg: 'FFBDD7EE',
  missingInFg: 'FF1F4E79',
  missingOutBg: 'FFFFE699',
  missingOutFg: 'FF7F6000',
  summaryBg: 'FFD6DCE4',
  totalPenaltyBg: 'FFF4B084',
  totalPenaltyFg: 'FF7F2704',
  grandBg: 'FFE2EFDA',
} as const;

const HEADERS = [
  '#',
  'اسم الموظف',
  'الوظيفة',
  'كود الموظف',
  'التاريخ',
  'اليوم',
  'الشيفت',
  'وقت الحضور',
  'وقت الانصراف',
  'الحضور المتوقع',
  'الانصراف المتوقع',
  'إذن',
  'تأخير الحضور',
  'انصراف مبكر',
  'صافي الساعات',
  'الجهاز',
  'Line ID',
];

const SUMMARY_HEADERS = [
  'عدد أيام العمل',
  'أيام الإجازة المستحقة',
  'أيام العمل الفعلية',
  'إجمالي أيام الفترة',
  'عدم تكرار البصمة',
  'خصم تكرار البصمة',
  'غياب بدون إذن',
  'جزاء إداري',
  'الإضافي',
  'تأخير الحضور',
  'تأخير الانصراف',
  'أيام الإجازة المرضية',
  'خصم الإجازة المرضية',
  'إجمالي الجزاءات',
];

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: 'thin' as const, color: { argb: COLORS.border } };
  return { top: side, left: side, bottom: side, right: side };
}

function solidFill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function applyStyle(cell: ExcelJS.Cell, style: Partial<ExcelJS.Style>) {
  if (style.font) cell.font = style.font as ExcelJS.Font;
  if (style.fill) cell.fill = style.fill as ExcelJS.Fill;
  if (style.alignment) cell.alignment = style.alignment as ExcelJS.Alignment;
  if (style.border) cell.border = style.border as ExcelJS.Borders;
  if (style.protection) cell.protection = style.protection as Partial<ExcelJS.Protection>;
}

function fmt(overrides: Partial<ExcelJS.Style>): Partial<ExcelJS.Style> {
  return { border: thinBorder(), alignment: { vertical: 'middle', horizontal: 'center' }, ...overrides };
}

const titleFmt = fmt({
  font: { bold: true, size: 16, color: { argb: COLORS.titleFg } },
  fill: solidFill(COLORS.titleBg),
});
const headerFmt = fmt({
  font: { bold: true, size: 11 },
  fill: solidFill(COLORS.headerBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});
const cellFmt = fmt({ font: { size: 10 } });
const offFmt = fmt({ font: { size: 10, color: { argb: COLORS.offFg } }, fill: solidFill(COLORS.offBg) });
const sickFmt = fmt({ font: { size: 10, color: { argb: COLORS.sickFg } }, fill: solidFill(COLORS.sickBg) });
const annualFmt = fmt({
  font: { bold: true, size: 10, color: { argb: COLORS.annualFg } },
  fill: solidFill(COLORS.annualBg),
});
const absentFmt = fmt({ font: { size: 10, color: { argb: COLORS.absentFg } }, fill: solidFill(COLORS.absentBg) });
const ignoredLateFmt = fmt({
  font: { bold: true, size: 10, color: { argb: COLORS.ignoredLateFg } },
  fill: solidFill(COLORS.ignoredLateBg),
});
const missingInFmt = fmt({
  font: { bold: true, size: 10, color: { argb: COLORS.missingInFg } },
  fill: solidFill(COLORS.missingInBg),
});
const missingOutFmt = fmt({
  font: { bold: true, size: 10, color: { argb: COLORS.missingOutFg } },
  fill: solidFill(COLORS.missingOutBg),
});
const summaryLabelFmt = fmt({
  font: { bold: true, size: 10 },
  fill: solidFill(COLORS.summaryBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});
const summaryValFmt = fmt({ font: { bold: true, size: 10 }, fill: solidFill(COLORS.summaryBg) });
const totalPenaltyFmt = fmt({
  font: { bold: true, size: 10, color: { argb: COLORS.totalPenaltyFg } },
  fill: solidFill(COLORS.totalPenaltyBg),
});
const grandFmt = fmt({ font: { bold: true, size: 10 }, fill: solidFill(COLORS.grandBg) });

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function safeFilenameToken(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'branch'
  );
}

/** Describes the excused-late-days allowance, so the sheet never states a stale rule. */
function forgivenAllowanceLabel(policy: LatePolicy): string {
  const which =
    policy.forgivenDaysSelection === 'largest'
      ? 'أكبر'
      : policy.forgivenDaysSelection === 'smallest'
        ? 'أصغر'
        : 'أقدم';
  return `${which} ${policy.forgivenDaysCount} من أيام التأخير`;
}

function pyWeekday(d: Date): number {
  const wd = d.getUTCDay();
  return wd === 0 ? 6 : wd - 1;
}

function lineRowFormat(line: PunchReportExportLine): Partial<ExcelJS.Style> {
  const isSickDay = line.isOffDay && line.shiftName === 'إجازة مرضية';
  if (line.isAnnualLeave) return annualFmt;
  if (isSickDay) return sickFmt;
  if (line.isOffDay) return offFmt;
  if (line.isAbsent) return absentFmt;
  return cellFmt;
}

function fmtHmMinutes(mins: number): string {
  if (mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = Math.floor(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtNetHours(hours: number): string {
  if (!hours) return '00:00';
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function writeHeaderRow(sheet: ExcelJS.Worksheet, row: number) {
  HEADERS.forEach((h, i) => {
    const c = sheet.getCell(row, i + 1);
    c.value = h;
    applyStyle(c, headerFmt);
  });
}

function writeDataRow(
  sheet: ExcelJS.Worksheet,
  row: number,
  idx: number,
  line: PunchReportExportLine,
  ignoredLate: Set<number>,
  empDeviceName: string,
) {
  const baseFmt = lineRowFormat(line);
  const isSickDay = line.isOffDay && line.shiftName === 'إجازة مرضية';
  const isIgnoredLate = ignoredLate.has(line.id);
  const permissionStr = isIgnoredLate ? 'إذن' : '';
  const lateStr = line.lateMinutes > 0 && !line.isOffDay && !line.isAbsent ? fmtHmMinutes(line.lateMinutes) : '';
  const earlyStr = line.earlyLeaveMinutes > 0 ? fmtHmMinutes(line.earlyLeaveMinutes) : '';

  const isNormalDay = !line.isOffDay && !line.isAbsent && line.punchCount === 1;
  const missingInCell = isNormalDay && line.checkInCount === 0 && line.checkOutCount > 0;
  const missingOutCell = isNormalDay && line.checkOutCount === 0 && line.checkInCount > 0;

  const values: (string | number)[] = [
    idx,
    line.employeeName,
    line.jobTitle,
    line.employeeCode,
    dateKey(line.punchDate),
    DAY_NAMES[pyWeekday(line.punchDate)] ?? '',
    line.shiftName,
    formatTimeAmPm(line.firstCheckIn),
    formatTimeAmPm(line.lastCheckOut),
    formatTimeShortAmPm(line.expectedCheckIn),
    formatTimeShortAmPm(line.expectedCheckOut),
    permissionStr,
    lateStr,
    earlyStr,
    fmtNetHours(line.netWorkedHours),
    line.deviceName || empDeviceName,
    line.id,
  ];

  values.forEach((v, i) => {
    const c = sheet.getCell(row, i + 1);
    c.value = v;
    if (i === 7) applyStyle(c, missingInCell ? missingInFmt : baseFmt);
    else if (i === 8) applyStyle(c, missingOutCell ? missingOutFmt : baseFmt);
    else if (i === 11) applyStyle(c, isIgnoredLate ? ignoredLateFmt : baseFmt);
    else applyStyle(c, baseFmt);
  });
}

function writeEmployeeSummary(
  sheet: ExcelJS.Worksheet,
  row: number,
  empLines: PunchReportExportLine[],
  periodDays: number,
  fullPeriodDays: number,
  policy: LatePolicy,
  absentForgivenDaysCount: number,
): number {
  const summary = computeEmployeeSummary(
    empLines,
    periodDays,
    0,
    policy,
    absentForgivenDaysCount,
  );
  const deviceName = empLines.find((l) => l.deviceName)?.deviceName ?? '';

  SUMMARY_HEADERS.forEach((h, i) => {
    const c = sheet.getCell(row, i + 1);
    c.value = h;
    applyStyle(c, summaryLabelFmt);
  });
  if (SUMMARY_HEADERS.length < 19) {
    sheet.mergeCells(row, SUMMARY_HEADERS.length + 1, row, 19);
    applyStyle(sheet.getCell(row, SUMMARY_HEADERS.length + 1), summaryLabelFmt);
  }
  sheet.getCell(row, 20).value = deviceName;
  applyStyle(sheet.getCell(row, 20), summaryLabelFmt);
  row++;

  const summaryValues: number[] = [
    summary.workingDays,
    summary.earnedLeaveCapped,
    summary.actualWorkingDays,
    fullPeriodDays,
    summary.singlePunch,
    summary.punchDeduction,
    summary.absentCount,
    summary.adminPenalty,
    summary.overtime,
    summary.lateDeduction,
    summary.earlyDeduction,
    summary.sickDayCount,
    summary.sickDeduction,
    summary.totalPenalties,
  ];

  summaryValues.forEach((v, i) => {
    const c = sheet.getCell(row, i + 1);
    // إجمالي الجزاءات must recalculate when HR edits any related penalty cell:
    // E خصم بصمة + F غياب + G جزاء إداري + I تأخير حضور
    // + J تأخير انصراف + L خصم إجازة مرضية.
    c.value =
      i === summaryValues.length - 1
        ? { formula: `ROUND(F${row}+G${row}+H${row}+J${row}+K${row}+M${row},2)`, result: v }
        : v;
    applyStyle(c, i === summaryValues.length - 1 ? totalPenaltyFmt : summaryValFmt);
  });
  if (SUMMARY_HEADERS.length < 19) {
    sheet.mergeCells(row, SUMMARY_HEADERS.length + 1, row, 19);
    applyStyle(sheet.getCell(row, SUMMARY_HEADERS.length + 1), summaryValFmt);
  }
  sheet.getCell(row, 20).value = deviceName;
  applyStyle(sheet.getCell(row, 20), summaryValFmt);

  return row + 1;
}

function addBreakdownSheet(
  workbook: ExcelJS.Workbook,
  lines: PunchReportExportLine[],
  policy: LatePolicy,
) {
  const sheet = workbook.addWorksheet('تفاصيل الحسابات', {
    views: [{ rightToLeft: true }],
  });
  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 14;
  sheet.getColumn(3).width = 14;
  sheet.getColumn(4).width = 18;
  sheet.getColumn(5).width = 18;
  sheet.getColumn(6).width = 16;
  sheet.getColumn(7).width = 40;

  const byEmp = new Map<string, PunchReportExportLine[]>();
  for (const l of lines) {
    const k = l.employeeCode || l.employeeName;
    const arr = byEmp.get(k) ?? [];
    arr.push(l);
    byEmp.set(k, arr);
  }

  let row = 1;
  for (const [, empLines] of byEmp) {
    const first = empLines[0];
    sheet.mergeCells(row, 1, row, 7);
    const title = sheet.getCell(row, 1);
    title.value = `${first.employeeName} — كود: ${first.employeeCode} — وظيفة: ${first.jobTitle || '-'}`;
    applyStyle(title, fmt({
      font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } },
      fill: solidFill('FF1F4E79'),
      alignment: { horizontal: 'right' },
    }));
    row += 2;

    const ignored = getIgnoredLateLineIds(empLines, policy);
    const lateLines = empLines
      .filter((l) => !l.isOffDay && !l.isAbsent && l.lateMinutes > 0)
      .sort((a, b) => dateKey(a.punchDate).localeCompare(dateKey(b.punchDate)));

    sheet.mergeCells(row, 1, row, 7);
    applyStyle(sheet.getCell(row, 1), fmt({ font: { bold: true }, fill: solidFill('FFD9E1F2') }));
    sheet.getCell(row, 1).value = 'تفاصيل التأخير';
    row++;

    if (lateLines.length === 0) {
      sheet.mergeCells(row, 1, row, 7);
      sheet.getCell(row, 1).value = 'لا توجد أيام تأخير';
      row += 2;
      continue;
    }

    let lateTotal = 0;
    lateLines.forEach((l, i) => {
      const isPerm = ignored.has(l.id);
      const ded = isPerm ? 0 : lateDayFraction(l.lateMinutes, policy);
      lateTotal += ded;
      const rule = isPerm ? `إذن (${forgivenAllowanceLabel(policy)})` : `${l.lateMinutes}د = ${ded}`;
      [i + 1, dateKey(l.punchDate), DAY_NAMES[pyWeekday(l.punchDate)] ?? '', formatTimeShortAmPm(l.expectedCheckIn), formatTimeShortAmPm(l.firstCheckIn), String(Math.round(l.lateMinutes)), rule].forEach((v, ci) => {
        const c = sheet.getCell(row, ci + 1);
        c.value = v;
        applyStyle(c, isPerm ? ignoredLateFmt : cellFmt);
      });
      row++;
    });
    sheet.mergeCells(row, 1, row, 6);
    sheet.getCell(row, 1).value =
      policy.forgivenDaysCount > 0
        ? `إجمالي خصم التأخير (بعد استثناء ${forgivenAllowanceLabel(policy)} كإذن)`
        : 'إجمالي خصم التأخير';
    sheet.getCell(row, 7).value = `${lateTotal.toFixed(2)} يوم`;
    row += 3;
  }
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

export async function exportPunchReportXlsx(
  options: GeneratePunchReportLinesOptions & {
    exportId?: number;
    /** Branch/location label for download filename (e.g. Zayed). */
    locationName?: string | null;
  },
): Promise<{ base64: string; filename: string; lineCount: number }> {
  const lines = await generatePunchReportLines(options);
  if (!lines.length) {
    throw new Error('لا توجد بصمات في الفترة المحددة');
  }
  const latePolicy = await getLatePolicy();
  const payablePolicy = await getPayablePeriodPolicy();

  const dateFrom = options.dateFrom;
  const dateTo = options.dateTo;
  const fullPeriodDays = resolveFullPayrollPeriodDays(dateFrom, dateTo, payablePolicy);
  const periodDays = resolvePayablePeriodDays(dateFrom, dateTo, payablePolicy);
  const exportId = options.exportId ?? Math.floor(Date.now() / 1000);
  const midCycle = periodDays < fullPeriodDays;
  const headerRow = midCycle ? 5 : 4;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hudoori';

  const sheet = workbook.addWorksheet('تقرير البصمات', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: headerRow, activeCell: `A${headerRow + 1}` }],
  });

  const widths = [5, 25, 20, 12, 12, 12, 15, 15, 15, 15, 15, 12, 12, 12, 12, 20, 10];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

  const lastCol = HEADERS.length;
  sheet.mergeCells(1, 1, 1, lastCol);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = 'تقرير البصمات';
  applyStyle(titleCell, titleFmt);

  sheet.mergeCells(2, 1, 2, lastCol);
  sheet.getCell(2, 1).value =
    `من ${dateKey(dateFrom)} إلى ${dateKey(dateTo)} — إجمالي أيام فترة الشهر: ${fullPeriodDays}`;
  applyStyle(sheet.getCell(2, 1), fmt({ font: { size: 10 }, alignment: { horizontal: 'center' } }));

  if (midCycle) {
    sheet.mergeCells(3, 1, 3, lastCol);
    sheet.getCell(3, 1).value =
      `أيام العمل الفعلية (من ${dateKey(dateFrom)} حتى ${dateKey(cairoDateOnly())}): ${periodDays}`;
    applyStyle(sheet.getCell(3, 1), fmt({ font: { size: 10 }, alignment: { horizontal: 'center' } }));
  }

  writeHeaderRow(sheet, headerRow);

  let row = headerRow + 1;
  let idx = 0;
  let currentEmp: string | null = null;
  let empBuffer: PunchReportExportLine[] = [];

  const flushEmployee = () => {
    if (!empBuffer.length) return;
    const empDevice = empBuffer.find((l) => l.deviceName)?.deviceName ?? '';
    const ignored = getIgnoredLateLineIds(empBuffer, latePolicy);
    for (const line of empBuffer) {
      idx++;
      writeDataRow(sheet, row, idx, line, ignored, empDevice);
      row++;
    }
    row = writeEmployeeSummary(
      sheet,
      row,
      empBuffer,
      periodDays,
      fullPeriodDays,
      latePolicy,
      payablePolicy.absentForgivenDaysCount,
    );
    writeHeaderRow(sheet, row);
    row++;
    empBuffer = [];
  };

  for (const line of lines) {
    const empKey = line.employeeCode || line.employeeName;
    if (currentEmp !== null && empKey !== currentEmp) flushEmployee();
    currentEmp = empKey;
    empBuffer.push(line);
  }
  flushEmployee();

  sheet.mergeCells(row, 2, row, 14);
  sheet.getCell(row, 1).value = '';
  sheet.getCell(row, 2).value = `إجمالي عدد السجلات: ${lines.length}`;
  applyStyle(sheet.getCell(row, 2), grandFmt);
  const totalNet = lines.reduce((s, l) => s + l.netWorkedHours, 0);
  sheet.getCell(row, 15).value = fmtNetHours(totalNet);
  applyStyle(sheet.getCell(row, 15), grandFmt);

  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: Math.max(headerRow, row - 1), column: lastCol } };

  const meta = workbook.addWorksheet('_meta');
  meta.getCell(1, 1).value = 'wizard_id';
  meta.getCell(1, 2).value = exportId;
  meta.getCell(2, 1).value = 'date_from';
  meta.getCell(2, 2).value = dateKey(dateFrom);
  meta.getCell(3, 1).value = 'date_to';
  meta.getCell(3, 2).value = dateKey(dateTo);
  meta.getCell(4, 1).value = 'full_period_days';
  meta.getCell(4, 2).value = fullPeriodDays;
  meta.getCell(5, 1).value = 'elapsed_period_days';
  meta.getCell(5, 2).value = periodDays;
  meta.getCell(6, 1).value = 'shift_grid_id';
  meta.getCell(6, 2).value = options.shiftGridId ?? '';
  if (options.locationName) {
    meta.getCell(7, 1).value = 'location_name';
    meta.getCell(7, 2).value = options.locationName;
  }
  meta.state = 'veryHidden';

  addBreakdownSheet(workbook, lines, latePolicy);

  // Editable for HR: unlock so they can adjust summary rows then re-import.
  // (_meta stays veryHidden; do not protect the main sheets.)

  const base64 = await workbookToBase64(workbook);
  const branchToken = options.locationName
    ? `_${safeFilenameToken(options.locationName)}`
    : '';
  return {
    base64,
    filename: `punch_report${branchToken}_${dateKey(dateFrom)}_${dateKey(dateTo)}.xlsx`,
    lineCount: lines.length,
  };
}

export async function exportPunchReportFileResponse(
  options: GeneratePunchReportLinesOptions & { locationName?: string | null },
) {
  const { base64, filename } = await exportPunchReportXlsx(options);
  return exportFileResponse(base64, filename);
}

/** Odoo biotime.shift.grid action_export_punch_report — grid employees + date range, all devices. */
export async function exportShiftGridPunchReportXlsx(gridId: string) {
  const grid = await prisma.shiftGrid.findUnique({
    where: { id: gridId },
    select: {
      id: true,
      dateFrom: true,
      dateTo: true,
      location: { select: { name: true, actualName: true } },
    },
  });
  if (!grid) throw new NotFoundError('Grid not found');

  const lineRows = await prisma.shiftGridLine.findMany({
    where: { gridId },
    select: { employeeId: true },
    distinct: ['employeeId'],
  });
  const employeeIds = lineRows.map((l) => l.employeeId);
  if (!employeeIds.length) {
    throw new AppError('لا يوجد موظفون في جدول الشيفتات', 404, 'NOT_FOUND');
  }

  const locationName =
    grid.location?.actualName?.trim() || grid.location?.name?.trim() || null;

  // Include archived/inactive grid members — they still get a payslip for the
  // days they worked before إنهاء / استقالة.
  return exportPunchReportFileResponse({
    dateFrom: grid.dateFrom,
    dateTo: grid.dateTo,
    employeeIds,
    shiftGridId: gridId,
    locationName,
    includeInactive: true,
  });
}

/**
 * Same punch-report schema as {@link exportShiftGridPunchReportXlsx} but limited
 * to a caller-selected subset of the grid's employees (and optional sub-range).
 */
export async function exportSelectedGridPunchReportXlsx(
  gridId: string,
  employeeIds: string[],
  dateFrom?: Date,
  dateTo?: Date,
) {
  const grid = await prisma.shiftGrid.findUnique({
    where: { id: gridId },
    select: { id: true, dateFrom: true, dateTo: true },
  });
  if (!grid) throw new NotFoundError('Grid not found');
  if (!employeeIds.length) {
    throw new AppError('لم يتم تحديد أي موظف', 400, 'VALIDATION_ERROR');
  }

  return exportPunchReportFileResponse({
    dateFrom: dateFrom ?? grid.dateFrom,
    dateTo: dateTo ?? grid.dateTo,
    employeeIds,
    shiftGridId: gridId,
    includeInactive: true,
  });
}
