import ExcelJS from 'exceljs';
import { ShiftGridState, type EmployeeMapping, type EmployeeProfile, type Shift, type ShiftGridLine } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { buildWeekGroups, parseWeekStartDay } from './shiftGridExcelWeeks';
import {
  compareForGrouping,
  DEFAULT_GRID_GROUPING,
  groupKeyFor,
  UNGROUPED_DEPARTMENT_LABEL,
  ungroupedLabelFor,
  type GridGrouping,
} from './shiftGridGrouping.service';
import { countGridSummary, flagsToLineData, type CellFlags } from './shiftGridData.service';
import {
  applyMergedLifecycleAction,
  lifecycleActionFromFlags,
  mergeLifecycleActions,
  type LifecycleAction,
} from './shiftGridEmployeeLifecycle.service';
import {
  LABEL_DEPARTED,
  LABEL_FINISHED,
  LABEL_OFF,
  LABEL_RESIGNATION,
  LABEL_WORK_ABSENCE,
  LABEL_WORK_INJURY,
  LABEL_MARRIAGE,
  buildDropdownOptionLabels,
  excelLabelToCellFlags,
  lineToExcelDropdownLabel,
} from './shiftGridExcelLabels';

/** Port of Odoo biotime_integration/reports/shift_grid_xlsx.py (xlsxwriter → ExcelJS). */

/** Monday=0 … Sunday=6 (matches Python weekday on UTC calendar dates). */
function pyWeekday(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

const DAY_NAMES_AR = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TITLE_ROW = 1;
const INFO_ROW = 2;
const WEEK_ROW = 3;
const HEADER_ROW = 4;
const DATA_START_ROW = 5;
const FIXED_COLS = 4;
const TEMPLATE_ROW_COUNT = 20;
const CODE_COL = 4;

const COLORS = {
  titleBg: 'FF1A237E',
  titleFg: 'FFFFFFFF',
  infoBg: 'FFE8EAF6',
  weekBg: 'FF1A237E',
  weekFg: 'FFFFFFFF',
  headerBg: 'FF343A40',
  headerFg: 'FFFFFFFF',
  fridayHeaderBg: 'FF4A5568',
  fridayHeaderFg: 'FFFFD700',
  jobBg: 'FFF0C040',
  jobFg: 'FF333333',
  border: 'FFCCCCCC',
  shiftBg: 'FFE8F5E9',
  shiftFg: 'FF2E7D32',
  offBg: 'FFFFEB3B',
  offFg: 'FF333333',
  sickBg: 'FFFFEBEE',
  sickFg: 'FFC62828',
  annualBg: 'FFFFF3E0',
  annualFg: 'FFE65100',
  excludedBg: 'FF6C757D',
  excludedFg: 'FFFFFFFF',
  busBg: 'FFFFF8E1',
  busFg: 'FFE65100',
  finishedBg: 'FFE8DEF8',
  finishedFg: 'FF4A148C',
  resignationBg: 'FFFFE0E0',
  resignationFg: 'FF7F1D1D',
  workAbsenceBg: 'FFFFF0E6',
  workAbsenceFg: 'FF9A3412',
  workInjuryBg: 'FFFFCDD2',
  workInjuryFg: 'FFB71C1C',
  departedBg: 'FF424242',
  departedFg: 'FFBDBDBD',
} as const;

type GridLine = ShiftGridLine & {
  shift?: Shift | null;
  employee: EmpWithRelations;
};
type LineWithShift = ShiftGridLine & { shift?: Shift | null };
type EmpWithRelations = EmployeeProfile & {
  department?: { name: string } | null;
  mapping?: EmployeeMapping | null;
};

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

/**
 * Reject importing a shift-grid Excel into the wrong grid.
 * New exports stamp `_meta.shift_grid_id`; older files without `_meta` are also
 * rejected so accidental cross-grid uploads can't silently rewrite rosters.
 */
export function assertShiftGridExcelMeta(
  workbook: ExcelJS.Workbook,
  expectedGridId: string,
  expectedGridName?: string,
): void {
  const meta = workbook.getWorksheet('_meta');
  if (!meta) {
    throw new AppError(
      'ملف Excel هذا غير مرتبط بجدول شيفتات (لا توجد ورقة _meta). صدّر الملف من جديد من الجدول نفسه ثم استورد.',
      400,
      'GRID_MISMATCH',
    );
  }
  const map = new Map<string, string>();
  for (let r = 1; r <= 12; r++) {
    const k = String(meta.getCell(r, 1).value ?? '').trim().toLowerCase();
    const v = String(meta.getCell(r, 2).value ?? '').trim();
    if (k) map.set(k, v);
  }
  const fileGridId = map.get('shift_grid_id') || map.get('grid_id') || '';
  if (!fileGridId) {
    throw new AppError(
      'ملف Excel ناقص معرّف الجدول — صدّر من جديد من نفس الجدول ثم استورد.',
      400,
      'GRID_MISMATCH',
    );
  }
  if (fileGridId !== expectedGridId) {
    const fileName = map.get('grid_name') || '';
    const target = expectedGridName?.trim() || expectedGridId;
    const source = fileName || fileGridId;
    throw new AppError(
      `هذا الملف لجدول «${source}» وليس للجدول الحالي «${target}». لن يُطبَّق حتى لا يتغيّر الموظفون عن طريق الخطأ.`,
      400,
      'GRID_MISMATCH',
    );
  }
}

function solidFill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: 'thin' as const, color: { argb: COLORS.border } };
  return { top: side, left: side, bottom: side, right: side };
}

function fmt(
  overrides: Partial<ExcelJS.Style>,
): Partial<ExcelJS.Style> {
  return { border: thinBorder(), ...overrides };
}

const titleFmt = fmt({
  font: { bold: true, size: 16, color: { argb: COLORS.titleFg } },
  fill: solidFill(COLORS.titleBg),
  alignment: { vertical: 'middle', horizontal: 'center' },
});

const infoFmt = fmt({
  font: { bold: true, size: 12 },
  fill: solidFill(COLORS.infoBg),
  alignment: { vertical: 'middle', horizontal: 'center' },
});

const weekFmt = fmt({
  font: { bold: true, size: 12, color: { argb: COLORS.weekFg } },
  fill: solidFill(COLORS.weekBg),
  alignment: { vertical: 'middle', horizontal: 'center' },
});

const headerFmt = fmt({
  font: { bold: true, size: 10, color: { argb: COLORS.headerFg } },
  fill: solidFill(COLORS.headerBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const fridayHeaderFmt = fmt({
  font: { bold: true, size: 10, color: { argb: COLORS.fridayHeaderFg } },
  fill: solidFill(COLORS.fridayHeaderBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const jobFmt = fmt({
  font: { bold: true, size: 11, color: { argb: COLORS.jobFg } },
  fill: solidFill(COLORS.jobBg),
  alignment: { vertical: 'middle', horizontal: 'center' },
});

const cellFmt = fmt({
  font: { bold: true, size: 13 },
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const nameFmt = fmt({
  font: { bold: true, size: 12 },
  alignment: { vertical: 'middle', horizontal: 'right' },
});

const shiftCellFmt = fmt({
  font: { bold: true, size: 13, color: { argb: COLORS.shiftFg } },
  fill: solidFill(COLORS.shiftBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const offFmt = fmt({
  font: { bold: true, size: 13, color: { argb: COLORS.offFg } },
  fill: solidFill(COLORS.offBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const sickFmt = fmt({
  font: { bold: true, size: 13, color: { argb: COLORS.sickFg } },
  fill: solidFill(COLORS.sickBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const annualFmt = fmt({
  font: { bold: true, size: 13, color: { argb: COLORS.annualFg } },
  fill: solidFill(COLORS.annualBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const excludedFmt = fmt({
  font: { bold: true, size: 13, color: { argb: COLORS.excludedFg } },
  fill: solidFill(COLORS.excludedBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const busFmt = fmt({
  font: { bold: true, size: 13, color: { argb: COLORS.busFg } },
  fill: solidFill(COLORS.busBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const finishedFmt = fmt({
  font: { bold: true, size: 13, color: { argb: COLORS.finishedFg } },
  fill: solidFill(COLORS.finishedBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const resignationFmt = fmt({
  font: { bold: true, size: 13, color: { argb: COLORS.resignationFg } },
  fill: solidFill(COLORS.resignationBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const workAbsenceFmt = fmt({
  font: { bold: true, size: 13, color: { argb: COLORS.workAbsenceFg } },
  fill: solidFill(COLORS.workAbsenceBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const workInjuryFmt = fmt({
  font: { bold: true, size: 13, color: { argb: COLORS.workInjuryFg } },
  fill: solidFill(COLORS.workInjuryBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const departedFmt = fmt({
  font: { italic: true, size: 11, color: { argb: COLORS.departedFg } },
  fill: solidFill(COLORS.departedBg),
  alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
});

const codeInputFmt = fmt({
  font: { bold: true, size: 12, color: { argb: 'FF1565C0' } },
  fill: solidFill('FFFFFDE7'),
  alignment: { vertical: 'middle', horizontal: 'center' },
});

const emptyHeaderFmt = fmt({ fill: solidFill(COLORS.headerBg) });

function applyStyle(cell: ExcelJS.Cell, style: Partial<ExcelJS.Style>) {
  if (style.font) cell.font = style.font as ExcelJS.Font;
  if (style.fill) cell.fill = style.fill as ExcelJS.Fill;
  if (style.alignment) cell.alignment = style.alignment as ExcelJS.Alignment;
  if (style.border) cell.border = style.border as ExcelJS.Borders;
}

/** Apply style to every cell in a merge range (Excel renders fills/borders correctly). */
function mergeRangeStyle(
  sheet: ExcelJS.Worksheet,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  value: string | number | undefined,
  style: Partial<ExcelJS.Style>,
) {
  if (r1 !== r2 || c1 !== c2) {
    sheet.mergeCells(r1, c1, r2, c2);
  }
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      applyStyle(sheet.getCell(r, c), style);
    }
  }
  if (value !== undefined) {
    sheet.getCell(r1, c1).value = value;
  }
}

function dateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateDisplay(d: Date): string {
  return dateKey(d);
}

function buildDates(dateFrom: Date, dateTo: Date): Date[] {
  const dates: Date[] = [];
  let d = new Date(dateFrom);
  const end = new Date(dateTo);
  while (dateKey(d) <= dateKey(end)) {
    dates.push(new Date(d));
    d = new Date(d.getTime() + 86400000);
  }
  return dates;
}

function parseUtcDay(value: string | Date | undefined | null): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const s = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve an optional export/import window inside the grid's dateFrom–dateTo.
 * Defaults to the full grid period when omitted.
 */
export function resolveGridExcelDateRange(
  gridFrom: Date,
  gridTo: Date,
  dateFrom?: string | Date | null,
  dateTo?: string | Date | null,
): { from: Date; to: Date } {
  const gFrom = parseUtcDay(gridFrom)!;
  const gTo = parseUtcDay(gridTo)!;
  let from = parseUtcDay(dateFrom) ?? gFrom;
  let to = parseUtcDay(dateTo) ?? gTo;

  if (from < gFrom) from = gFrom;
  if (to > gTo) to = gTo;
  if (from > gTo) from = gTo;
  if (to < gFrom) to = gFrom;
  if (from > to) {
    throw new AppError(
      `نطاق التاريخ غير صالح: ${dateKey(from)} → ${dateKey(to)} (فترة الجدول ${dateKey(gFrom)} → ${dateKey(gTo)})`,
      400,
      'VALIDATION_ERROR',
    );
  }
  return { from, to };
}

function employeeDisplayJob(emp: EmpWithRelations): string {
  return (emp.jobTitle ?? '').trim();
}

function employeeDisplayCode(emp: EmpWithRelations): string {
  return (
    emp.mapping?.biotimeEmpCode?.trim() ||
    emp.identificationId?.trim() ||
    emp.code?.trim() ||
    emp.barcode?.trim() ||
    ''
  );
}

function columnLetter(col: number): string {
  let n = col;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellStyleForLabel(text: string): Partial<ExcelJS.Style> {
  if (text === LABEL_DEPARTED) return departedFmt;
  if (text === LABEL_MARRIAGE || text.includes('إجازة جواز') || text.includes('اجازة جواز')) {
    return shiftCellFmt;
  }
  if (text.includes('إجازة مرضية')) return sickFmt;
  if (text.includes('إجازة سنوية')) return annualFmt;
  if (text.includes('إجازة')) return offFmt;
  if (text.includes('عدم احتساب')) return excludedFmt;
  if (text.includes('🚌') || text.includes('تأخير باص')) return busFmt;
  if (text === LABEL_FINISHED || text.includes('انهاء') || text.includes('إنهاء')) return finishedFmt;
  if (text === LABEL_RESIGNATION || text === 'استقاله') return resignationFmt;
  if (text === LABEL_WORK_ABSENCE || text.includes('انقطاع عن العمل')) return workAbsenceFmt;
  if (text === LABEL_WORK_INJURY || text.includes('اصابه عمل') || text.includes('إصابة عمل') || text.includes('اصابة عمل')) return workInjuryFmt;
  if (text === 'حاضر') return shiftCellFmt;
  if (text.includes(' - ')) return shiftCellFmt;
  return cellFmt;
}

function exportCellLabel(
  line: LineWithShift | undefined,
  emp: EmpWithRelations,
  day: Date,
  _departureDate?: Date | null,
): { text: string; style: Partial<ExcelJS.Style>; locked: boolean } {
  // Departed employees stay editable in Excel/import — do not hard-lock cells.
  void emp;
  void day;
  if (!line) {
    return { text: '', style: cellFmt, locked: false };
  }
  const text = lineToExcelDropdownLabel(line);
  return { text, style: cellStyleForLabel(text), locked: false };
}

function addListValidation(
  sheet: ExcelJS.Worksheet,
  address: string,
  optionRange: string,
) {
  const validations = (sheet as ExcelJS.Worksheet & {
    dataValidations: { add: (address: string, validation: Record<string, unknown>) => void };
  }).dataValidations;
  validations.add(address, {
    type: 'list',
    allowBlank: true,
    formulae: [optionRange],
    showErrorMessage: true,
    errorStyle: 'stop',
    errorTitle: 'قيمة غير مسموحة',
    error:
      'اللصق من خارج الملف مرفوض. انسخ من ورقة «مرجع الشيفتات» أو من خلية أخرى داخل الجدول فقط',
    showInputMessage: false,
  });
}

async function protectGridSheet(
  sheet: ExcelJS.Worksheet,
  dataRows: {
    row: number;
    dateColStart: number;
    dateColEnd: number;
    skipValidation: boolean;
    unlockCode?: boolean;
  }[],
) {
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (!cell.protection) cell.protection = { locked: true };
    });
  });

  for (const spec of dataRows) {
    if (spec.unlockCode) {
      sheet.getCell(spec.row, CODE_COL).protection = { locked: false };
    }
    for (let c = spec.dateColStart; c <= spec.dateColEnd; c++) {
      const cell = sheet.getCell(spec.row, c);
      cell.protection = { locked: spec.skipValidation };
    }
  }

  await sheet.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    insertHyperlinks: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    autoFilter: false,
    pivotTables: false,
  });
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String((value as { text: string }).text ?? '').trim();
  }
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return String(value).trim();
}

function normalizeEmployeeCode(value: unknown): string {
  const txt = cellText(value);
  if (txt.endsWith('.0') && txt.slice(0, -2).match(/^\d+$/)) return txt.slice(0, -2);
  return txt;
}

function parseHeaderDate(headerVal: unknown, defaultYear: number): string | null {
  if (headerVal == null || headerVal === '') return null;
  if (headerVal instanceof Date) return dateKey(headerVal);

  const text = cellText(headerVal);
  if (!text) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const cand of lines) {
    const iso = cand.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) {
      return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    }
    const dmy = cand.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (dmy) {
      return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
    const md = cand.match(/(\d{1,2})[-/]([A-Za-z]{3})/);
    if (md) {
      const monthIdx = MONTHS_EN.findIndex((m) => m.toLowerCase() === md[2].toLowerCase());
      if (monthIdx >= 0) {
        return `${defaultYear}-${String(monthIdx + 1).padStart(2, '0')}-${md[1].padStart(2, '0')}`;
      }
    }
  }
  return null;
}

function findHeaderRow(sheet: ExcelJS.Worksheet): number {
  for (let r = 1; r <= Math.min(8, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= Math.min(6, sheet.columnCount); c++) {
      const v = cellText(row.getCell(c).value);
      if (v === 'الكود' || v === 'كود الموظف' || v === 'الاسم' || v.toLowerCase() === 'code') return r;
    }
  }
  return HEADER_ROW;
}

function looksLikeEmployeeCode(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const normalized = v.endsWith('.0') && /^\d+\.0$/.test(v) ? v.slice(0, -2) : v;
  if (/^\d+$/.test(normalized)) return true;
  if (/^[A-Za-z0-9_-]+$/.test(normalized) && normalized.length <= 24) return true;
  // Arabic text or spaces → section/job title from merged Excel rows, not employee codes
  if (/[\u0600-\u06FF]/.test(normalized)) return false;
  if (/\s/.test(normalized)) return false;
  return normalized.length <= 16;
}

function isJobGroupRow(sheet: ExcelJS.Worksheet, rowNum: number): boolean {
  const row = sheet.getRow(rowNum);
  const seq = cellText(row.getCell(1).value);
  const job = cellText(row.getCell(2).value);
  const name = cellText(row.getCell(3).value);
  const code = normalizeEmployeeCode(row.getCell(CODE_COL).value);
  const seqIsNumber = /^\d+$/.test(seq);

  // Merged section header row: same label repeated in job / name / code columns
  const sectionLabels = [job, name, code].filter(Boolean);
  if (sectionLabels.length >= 2 && sectionLabels.every((l) => l === sectionLabels[0])) {
    return true;
  }

  // Section row: no employee sequence number and no employee name column
  if (!seqIsNumber && !name) {
    if (job && !code) return true;
    if (code && !looksLikeEmployeeCode(code)) return true;
    if (job && code && job === code) return true;
  }

  if (code && looksLikeEmployeeCode(code)) return false;
  if (name) return false;
  if (code) return false;
  return Boolean(seq) || Boolean(job);
}

/** Odoo biotime_integration.shift_grid_xlsx — action_export_xlsx */
export async function exportShiftGridXlsx(
  gridId: string,
  options?: {
    dateFrom?: string | Date | null;
    dateTo?: string | Date | null;
    /** Section rows by job title (default) or by department. */
    grouping?: GridGrouping;
    /** Write one sheet per section instead of sections inside one sheet. */
    sheetPerGroup?: boolean;
    /**
     * When set, only sections whose group key is in this list are exported
     * (keys match `groupKeyFor` for the chosen grouping — job title or department name).
     * Omitted / empty means export every section on the grid.
     */
    groupKeys?: string[];
    /**
     * Filter by department name as stored on the employee (Kitchen / Operation / …).
     * Independent of sheet grouping — layout still follows `grouping`.
     * Empty department matches `بدون قسم`.
     */
    departmentNames?: string[];
    /** When set, only these employee IDs are exported (takes precedence over other filters). */
    employeeIds?: string[];
  },
): Promise<string> {
  const grid = await prisma.shiftGrid.findUnique({
    where: { id: gridId },
    include: {
      location: true,
      lines: {
        include: {
          shift: true,
          employee: { include: { department: true, mapping: true } },
        },
        orderBy: [{ employee: { name: 'asc' } }, { date: 'asc' }],
      },
    },
  });
  if (!grid) throw new NotFoundError('Shift grid not found');

  const range = resolveGridExcelDateRange(
    grid.dateFrom,
    grid.dateTo,
    options?.dateFrom,
    options?.dateTo,
  );
  const dates = buildDates(range.from, range.to);
  const rangeFromKey = dateKey(range.from);
  const rangeToKey = dateKey(range.to);
  const dateMeta = dates.map((d) => ({
    date: d,
    weekday: pyWeekday(d),
    jsWeekday: d.getUTCDay(),
    label: `${DAY_NAMES_AR[pyWeekday(d)]}\n${d.getUTCDate()}-${MONTHS_EN[d.getUTCMonth()]}`,
  }));
  const config = await prisma.bioTimeConfig.findFirst({ select: { gridWeekStartDay: true } });
  const weeks = buildWeekGroups(
    dateMeta.map((d) => ({ jsWeekday: d.jsWeekday })),
    parseWeekStartDay(config?.gridWeekStartDay),
  );

  const byEmployee = new Map<string, GridLine[]>();
  const allEmployeeIds = new Set<string>();
  for (const line of grid.lines) {
    allEmployeeIds.add(line.employeeId);
    const k = dateKey(line.date);
    if (k < rangeFromKey || k > rangeToKey) continue;
    const arr = byEmployee.get(line.employeeId) ?? [];
    arr.push(line as GridLine);
    byEmployee.set(line.employeeId, arr);
  }

  // Prefer employees that have at least one line in-range; fall back to any grid employee
  // so partial exports still list the full roster with empty cells for the selected days.
  const employeeById = new Map<string, EmpWithRelations>();
  for (const line of grid.lines) {
    if (!employeeById.has(line.employeeId)) {
      employeeById.set(line.employeeId, (line as GridLine).employee);
    }
  }
  const grouping = options?.grouping ?? DEFAULT_GRID_GROUPING;
  const sheetPerGroup = options?.sheetPerGroup === true;
  const employeeIdFilter =
    options?.employeeIds?.map((id) => String(id).trim()).filter(Boolean) ?? [];
  const departmentNameFilter =
    options?.departmentNames?.map((k) => String(k).trim()).filter(Boolean) ?? [];
  const groupKeyFilter =
    options?.groupKeys?.map((k) => String(k).trim()).filter(Boolean) ?? [];
  const employeeIdSet = employeeIdFilter.length ? new Set(employeeIdFilter) : null;
  const departmentNameSet =
    !employeeIdSet && departmentNameFilter.length ? new Set(departmentNameFilter) : null;
  const groupKeySet =
    !employeeIdSet && !departmentNameSet && groupKeyFilter.length
      ? new Set(groupKeyFilter)
      : null;

  let employees = [...allEmployeeIds]
    .map((id) => employeeById.get(id)!)
    .filter(Boolean);
  if (employeeIdSet) {
    employees = employees.filter((emp) => employeeIdSet.has(emp.id));
  } else if (departmentNameSet) {
    employees = employees.filter((emp) => {
      const name = emp.department?.name?.trim() || UNGROUPED_DEPARTMENT_LABEL;
      return departmentNameSet.has(name);
    });
  } else if (groupKeySet) {
    employees = employees.filter((emp) => groupKeySet.has(groupKeyFor(emp, grouping)));
  }
  if ((employeeIdSet || departmentNameSet || groupKeySet) && employees.length === 0) {
    throw new Error('لا يوجد موظفون مطابقون للاختيار المحدد للتصدير');
  }
  employees = employees.sort((a, b) => compareForGrouping(a, b, grouping));

  const jobGroups = new Map<string, EmpWithRelations[]>();
  for (const emp of employees) {
    const key = groupKeyFor(emp, grouping);
    const list = jobGroups.get(key) ?? [];
    list.push(emp);
    jobGroups.set(key, list);
  }
  const ungroupedLabel = ungroupedLabelFor(grouping);

  const totalCols = FIXED_COLS + dates.length;
  const summary = await countGridSummary(gridId);
  const isPartial =
    rangeFromKey !== dateKey(grid.dateFrom) || rangeToKey !== dateKey(grid.dateTo);

  // Official labels only — from our Shift master data (exact code + name).
  // Always include every active shift so HR can assign any shift on import,
  // not only ones already present on this grid.
  // Users copy these exact strings inside the workbook (مرجع الشيفتات / cells) — not from outside.
  const shifts = await prisma.shift.findMany({
    where: { active: true },
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
  });
  const optionLabels = buildDropdownOptionLabels(shifts);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hudoori';
  workbook.created = new Date();

  // Hidden list source for data-validation formulae (must stay in workbook).
  const optionsSheet = workbook.addWorksheet('_grid_options');
  optionsSheet.state = 'veryHidden';
  optionLabels.forEach((label, i) => {
    optionsSheet.getCell(i + 1, 1).value = label;
  });
  const optionsEnd = Math.max(optionLabels.length, 1);
  const optionsRange = `'_grid_options'!$A$1:$A$${optionsEnd}`;
  const dateColStart = FIXED_COLS + 1;
  const dateColEnd = totalCols;

  /**
   * Writes one grid sheet for the given sections. Called once for the whole
   * roster, or once per department when HR wants a sheet each.
   */
  const writeGridSheet = async (
    sheetName: string,
    sections: Map<string, EmpWithRelations[]>,
    heading: string,
  ): Promise<void> => {
    const validationRows: {
      row: number;
      dateColStart: number;
      dateColEnd: number;
      skipValidation: boolean;
      unlockCode?: boolean;
    }[] = [];
    const sheetEmployeeCount = [...sections.values()].reduce((n, list) => n + list.length, 0);
  const sheet = workbook.addWorksheet(sheetName, {
    properties: { defaultRowHeight: 26 },
  });
  sheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: DATA_START_ROW - 1, xSplit: FIXED_COLS, activeCell: 'E5' }];

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 14;
  sheet.getColumn(3).width = 24;
  sheet.getColumn(4).width = 12;
  for (let c = FIXED_COLS + 1; c <= totalCols; c++) {
    sheet.getColumn(c).width = 16;
  }

  mergeRangeStyle(sheet, TITLE_ROW, 1, TITLE_ROW, totalCols, heading, titleFmt);
  sheet.getRow(TITLE_ROW).height = 28;

  const periodLabel = isPartial
    ? `تصدير جزئي من ${formatDateDisplay(range.from)} إلى ${formatDateDisplay(range.to)} (الجدول الكامل ${formatDateDisplay(grid.dateFrom)} → ${formatDateDisplay(grid.dateTo)})`
    : `من ${formatDateDisplay(grid.dateFrom)} إلى ${formatDateDisplay(grid.dateTo)}`;
  const infoText = `${periodLabel} — ${sheetEmployeeCount} موظف × ${dates.length} يوم | انسخ الشيفت من ورقة «مرجع الشيفتات» أو من خلية داخل الجدول — اللصق من خارج الملف مرفوض`;
  mergeRangeStyle(sheet, INFO_ROW, 1, INFO_ROW, totalCols, infoText, infoFmt);
  sheet.getRow(INFO_ROW).height = 28;

  mergeRangeStyle(sheet, WEEK_ROW, 1, WEEK_ROW, FIXED_COLS, '', emptyHeaderFmt);
  let col = FIXED_COLS + 1;
  for (const w of weeks) {
    if (w.colspan > 1) {
      mergeRangeStyle(sheet, WEEK_ROW, col, WEEK_ROW, col + w.colspan - 1, w.label, weekFmt);
    } else {
      mergeRangeStyle(sheet, WEEK_ROW, col, WEEK_ROW, col, w.label, weekFmt);
    }
    col += w.colspan;
  }

  const fixedHeaders = ['الرقم', 'الوظيفة', 'الاسم', 'كود الموظف'];
  for (let i = 0; i < fixedHeaders.length; i++) {
    const c = sheet.getCell(HEADER_ROW, i + 1);
    c.value = fixedHeaders[i];
    applyStyle(c, headerFmt);
  }
  for (let i = 0; i < dateMeta.length; i++) {
    const c = sheet.getCell(HEADER_ROW, FIXED_COLS + 1 + i);
    c.value = dateMeta[i].label;
    applyStyle(c, dateMeta[i].weekday === 4 ? fridayHeaderFmt : headerFmt);
  }
  sheet.getRow(HEADER_ROW).height = 35;

  let row = DATA_START_ROW;
  let globalSeq = 0;

  for (const [jobName, emps] of sections) {
    if (jobName !== ungroupedLabel) {
      mergeRangeStyle(sheet, row, 1, row, totalCols, jobName, jobFmt);
      sheet.getRow(row).height = 22;
      row++;
    }

    for (const emp of emps) {
      globalSeq++;
      const empLines = byEmployee.get(emp.id) ?? [];
      const cells = new Map(empLines.map((l) => [dateKey(l.date), l]));

      applyStyle(sheet.getCell(row, 1), cellFmt);
      sheet.getCell(row, 1).value = globalSeq;
      sheet.getCell(row, 1).protection = { locked: true };
      applyStyle(sheet.getCell(row, 2), cellFmt);
      sheet.getCell(row, 2).value = employeeDisplayJob(emp);
      sheet.getCell(row, 2).protection = { locked: true };
      applyStyle(sheet.getCell(row, 3), nameFmt);
      sheet.getCell(row, 3).value = emp.name;
      sheet.getCell(row, 3).protection = { locked: true };
      applyStyle(sheet.getCell(row, 4), cellFmt);
      sheet.getCell(row, 4).value = employeeDisplayCode(emp);
      sheet.getCell(row, 4).protection = { locked: true };

      let rowSkipValidation = false;
      for (let i = 0; i < dates.length; i++) {
        const day = dates[i];
        const line = cells.get(dateKey(day));
        const { text, style, locked } = exportCellLabel(line, emp, day, emp.departureDate);
        const c = sheet.getCell(row, FIXED_COLS + 1 + i);
        c.value = text;
        applyStyle(c, style);
        c.protection = { locked };
        if (locked) rowSkipValidation = true;
      }

      validationRows.push({
        row,
        dateColStart,
        dateColEnd,
        skipValidation: rowSkipValidation,
      });

      sheet.getRow(row).height = 26;
      row++;
    }
  }

  for (let t = 0; t < TEMPLATE_ROW_COUNT; t++) {
    for (let c = 1; c <= FIXED_COLS; c++) {
      const cell = sheet.getCell(row, c);
      applyStyle(cell, c === CODE_COL ? codeInputFmt : cellFmt);
      cell.value = '';
      cell.protection = { locked: c !== CODE_COL };
    }
    for (let i = 0; i < dates.length; i++) {
      const c = sheet.getCell(row, FIXED_COLS + 1 + i);
      c.value = '';
      applyStyle(c, cellFmt);
      c.protection = { locked: false };
    }
    validationRows.push({
      row,
      dateColStart,
      dateColEnd,
      skipValidation: false,
      unlockCode: true,
    });
    sheet.getRow(row).height = 26;
    row++;
  }

  for (const spec of validationRows) {
    if (spec.skipValidation) continue;
    const letterStart = columnLetter(spec.dateColStart);
    const letterEnd = columnLetter(spec.dateColEnd);
    addListValidation(sheet, `${letterStart}${spec.row}:${letterEnd}${spec.row}`, optionsRange);
  }

  // When HR picks «إجازة (off)» from the dropdown, paint the whole cell yellow.
  if (validationRows.length > 0) {
    const firstDataRow = Math.min(...validationRows.map((s) => s.row));
    const lastDataRow = Math.max(...validationRows.map((s) => s.row));
    const letterStart = columnLetter(dateColStart);
    const letterEnd = columnLetter(dateColEnd);
    const cfRef = `${letterStart}${firstDataRow}:${letterEnd}${lastDataRow}`;
    sheet.addConditionalFormatting({
      ref: cfRef,
      rules: [
        {
          type: 'cellIs',
          operator: 'equal',
          formulae: [`"${LABEL_OFF.replace(/"/g, '""')}"`],
          style: {
            fill: solidFill(COLORS.offBg),
            font: { bold: true, size: 13, color: { argb: COLORS.offFg } },
          },
          priority: 1,
        },
      ],
    });
  }

  await protectGridSheet(sheet, validationRows);
  };

  if (sheetPerGroup && jobGroups.size > 1) {
    // Excel forbids duplicate sheet names, and two departments could differ only
    // beyond the 31-character limit, so names are de-duplicated.
    const usedNames = new Set<string>();
    for (const [groupName, emps] of jobGroups) {
      let name = groupName.replace(/[*?:\\/[\]]/g, ' ').slice(0, 31) || 'قسم';
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${name.slice(0, 28)} ${suffix++}`;
      }
      usedNames.add(name);
      await writeGridSheet(name, new Map([[groupName, emps]]), `${grid.name} - ${groupName}`);
    }
  } else {
    await writeGridSheet('جدول الشيفتات', jobGroups, `جدول الشيفتات - ${grid.name}`);
  }

  // Visible copy source AFTER grid sheets so import picks the grid first.
  // Same official labels — HR copies from here (or another grid cell), not from outside.
  const refSheet = workbook.addWorksheet('مرجع الشيفتات', {
    properties: { defaultRowHeight: 26 },
  });
  refSheet.views = [{ rightToLeft: true }];
  refSheet.getColumn(1).width = 48;
  const refTitle = refSheet.getCell(1, 1);
  refTitle.value = 'انسخ من هنا → الصق في خلايا الجدول فقط (أسماء الشيفت / الحالات الرسمية)';
  refTitle.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 13 };
  refTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A237E' } };
  refSheet.getRow(1).height = 28;
  optionLabels.forEach((label, i) => {
    const cell = refSheet.getCell(i + 2, 1);
    cell.value = label;
    cell.font = { bold: true, size: 14 };
    cell.alignment = { vertical: 'middle', horizontal: 'right' };
    cell.protection = { locked: true };
    refSheet.getRow(i + 2).height = 26;
  });
  await refSheet.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: false,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    insertHyperlinks: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    autoFilter: false,
    pivotTables: false,
  });

  // Ties this workbook to one shift grid so import rejects accidental cross-grid uploads.
  const meta = workbook.addWorksheet('_meta');
  meta.getCell(1, 1).value = 'shift_grid_id';
  meta.getCell(1, 2).value = gridId;
  meta.getCell(2, 1).value = 'date_from';
  meta.getCell(2, 2).value = dateKey(grid.dateFrom);
  meta.getCell(3, 1).value = 'date_to';
  meta.getCell(3, 2).value = dateKey(grid.dateTo);
  meta.getCell(4, 1).value = 'grid_name';
  meta.getCell(4, 2).value = grid.name ?? '';
  meta.state = 'veryHidden';

  return workbookToBase64(workbook);
}

function flagsEqual(a: CellFlags, b: CellFlags): boolean {
  return (
    a.shiftId === b.shiftId &&
    a.isOff === b.isOff &&
    a.isSick === b.isSick &&
    a.isAnnualLeave === b.isAnnualLeave &&
    a.isExcluded === b.isExcluded &&
    a.isBusDelay === b.isBusDelay &&
    a.isPresent === b.isPresent &&
    a.isFinished === b.isFinished &&
    a.isResignation === b.isResignation &&
    a.isWorkAbsence === b.isWorkAbsence &&
    a.isWorkInjury === b.isWorkInjury &&
    a.isMarriageLeave === b.isMarriageLeave
  );
}

async function findEmployeeByCode(code: string) {
  return prisma.employeeProfile.findFirst({
    where: {
      OR: [
        { code },
        { identificationId: code },
        { barcode: code },
        { mapping: { biotimeEmpCode: code } },
      ],
    },
  });
}

async function ensureEmployeeOnGrid(
  gridId: string,
  grid: { dateFrom: Date; dateTo: Date; locationId: string | null },
  employeeId: string,
): Promise<{ added: boolean; relocated: boolean }> {
  const existing = await prisma.shiftGridLine.findFirst({
    where: { gridId, employeeId },
    select: { id: true },
  });
  if (existing) return { added: false, relocated: false };

  let d = new Date(grid.dateFrom);
  const end = new Date(grid.dateTo);
  while (dateKey(d) <= dateKey(end)) {
    await prisma.shiftGridLine.upsert({
      where: { gridId_employeeId_date: { gridId, employeeId, date: new Date(d) } },
      create: { gridId, employeeId, date: new Date(d) },
      update: {},
    });
    d = new Date(d.getTime() + 86400000);
  }
  return { added: true, relocated: false };
}

async function applyFlagsToGridCell(
  gridId: string,
  employeeId: string,
  day: Date,
  flags: CellFlags,
  existing: (ShiftGridLine & { shift?: Shift | null }) | null,
): Promise<'updated' | 'unchanged'> {
  const existingFlags: CellFlags = existing
    ? {
        shiftId: existing.shiftId,
        isOff: existing.isOff,
        isSick: existing.isSick,
        isAnnualLeave: existing.isAnnualLeave,
        isExcluded: existing.isExcluded,
        isBusDelay: existing.isBusDelay,
        isPresent: existing.isPresent,
        isFinished: existing.isFinished,
        isResignation: existing.isResignation,
        isWorkAbsence: existing.isWorkAbsence,
        isWorkInjury: existing.isWorkInjury,
        isMarriageLeave: existing.isMarriageLeave,
      }
    : {
        shiftId: null,
        isOff: false,
        isSick: false,
        isAnnualLeave: false,
        isExcluded: false,
        isBusDelay: false,
        isPresent: false,
        isFinished: false,
        isResignation: false,
        isWorkAbsence: false,
        isWorkInjury: false,
        isMarriageLeave: false,
      };
  if (flagsEqual(flags, existingFlags)) return 'unchanged';

  await prisma.shiftGridLine.upsert({
    where: { gridId_employeeId_date: { gridId, employeeId, date: day } },
    create: {
      gridId,
      employeeId,
      date: day,
      ...flagsToLineData(flags),
    },
    update: flagsToLineData(flags),
  });
  return 'updated';
}

async function clearGridCell(
  gridId: string,
  employeeId: string,
  day: Date,
  existing: ShiftGridLine | null,
): Promise<'cleared' | 'unchanged'> {
  if (!existing) return 'unchanged';
  const alreadyEmpty =
    !existing.shiftId &&
    !existing.isOff &&
    !existing.isSick &&
    !existing.isAnnualLeave &&
    !existing.isExcluded &&
    !existing.isBusDelay &&
    !existing.isPresent &&
    !existing.isFinished &&
    !existing.isResignation &&
    !existing.isWorkAbsence &&
    !existing.isWorkInjury &&
    !existing.isMarriageLeave;
  if (alreadyEmpty) return 'unchanged';
  await prisma.shiftGridLine.update({
    where: { id: existing.id },
    data: flagsToLineData({
      shiftId: null,
      isOff: false,
      isSick: false,
      isAnnualLeave: false,
      isExcluded: false,
      isBusDelay: false,
      isPresent: false,
      isFinished: false,
      isResignation: false,
      isWorkAbsence: false,
      isWorkInjury: false,
      isMarriageLeave: false,
    }),
  });
  return 'cleared';
}

export type UntrackedImportUser = {
  excelRow: number;
  code: string;
  excelName: string;
  excelJob: string;
  filledShiftCells: number;
  reason: string;
};

export type ShiftGridImportResult = {
  updated: number;
  cleared: number;
  added: number;
  relocated: number;
  createdEmployees: number;
  createdCodes: string[];
  archivedCodes: string[];
  skippedCodes: string[];
  untrackedUsers: UntrackedImportUser[];
  errors: string[];
};

async function createEmployeeFromShiftImport(opts: {
  code: string;
  name: string;
  jobTitle: string;
  locationId: string | null;
  locationName: string | null;
}): Promise<EmployeeProfile> {
  const code = opts.code.trim();
  const name = opts.name.trim() || code;
  const jobTitle = opts.jobTitle.trim() || null;
  return prisma.employeeProfile.create({
    data: {
      name,
      displayName: name,
      code,
      identificationId: code,
      barcode: code,
      jobTitle,
      locationId: opts.locationId,
      location: opts.locationName,
      active: true,
      biotimeSynced: false,
      mapping: {
        create: {
          biotimeEmpCode: code,
        },
      },
    },
  });
}

export async function importShiftGridXlsx(
  gridId: string,
  base64: string,
  options?: {
    dateFrom?: string | Date | null;
    dateTo?: string | Date | null;
    /** Unknown Excel codes listed here are created as employees then applied. */
    createEmployeeCodes?: string[] | null;
  },
): Promise<ShiftGridImportResult> {
  const grid = await prisma.shiftGrid.findUnique({
    where: { id: gridId },
    include: { location: { select: { id: true, name: true } } },
  });
  if (!grid) throw new NotFoundError('Shift grid not found');
  if (grid.state === ShiftGridState.confirmed) {
    throw new AppError('الجدول مؤكد — افتحه للتعديل قبل الاستيراد', 400, 'GRID_LOCKED');
  }

  const createCodeSet = new Set(
    (options?.createEmployeeCodes ?? [])
      .map((c) => normalizeEmployeeCode(c))
      .filter(Boolean),
  );

  const range = resolveGridExcelDateRange(
    grid.dateFrom,
    grid.dateTo,
    options?.dateFrom,
    options?.dateTo,
  );
  const rangeFromKey = dateKey(range.from);
  const rangeToKey = dateKey(range.to);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    Buffer.from(base64.replace(/^data:.*;base64,/, ''), 'base64') as unknown as ExcelJS.Buffer,
  );

  assertShiftGridExcelMeta(workbook, gridId, grid.name ?? '');

  const sheet =
    workbook.worksheets.find((w) => w.name === 'جدول الشيفتات') ??
    workbook.worksheets.find(
      (w) => !w.name.startsWith('_') && w.name !== 'مرجع الشيفتات',
    ) ??
    workbook.worksheets[0];
  if (!sheet || sheet.name === 'مرجع الشيفتات' || sheet.name.startsWith('_')) {
    return {
      updated: 0,
      cleared: 0,
      added: 0,
      relocated: 0,
      createdEmployees: 0,
      createdCodes: [],
      archivedCodes: [],
      skippedCodes: [],
      untrackedUsers: [],
      errors: [],
    };
  }

  const headerRowNum = findHeaderRow(sheet);
  const dataStartRow = headerRowNum + 1;
  const defaultYear = grid.dateFrom.getFullYear();

  const allDateCols: { col: number; date: string }[] = [];
  sheet.getRow(headerRowNum).eachCell((cell, col) => {
    if (col <= FIXED_COLS) return;
    const parsed = parseHeaderDate(cell.value, defaultYear);
    if (parsed) allDateCols.push({ col, date: parsed });
  });

  if (!allDateCols.length) {
    throw new AppError('لم يتم العثور على أعمدة التواريخ في الملف', 400, 'VALIDATION_ERROR');
  }

  const gridFrom = dateKey(grid.dateFrom);
  const gridTo = dateKey(grid.dateTo);
  for (const { date } of allDateCols) {
    if (date < gridFrom || date > gridTo) {
      throw new AppError(`تاريخ ${date} خارج فترة الجدول`, 400, 'VALIDATION_ERROR');
    }
  }

  // Only apply cells inside the requested import window (other columns are ignored).
  const dateCols = allDateCols.filter((c) => c.date >= rangeFromKey && c.date <= rangeToKey);
  if (!dateCols.length) {
    throw new AppError(
      `لا توجد تواريخ في الملف داخل النطاق المحدد (${rangeFromKey} → ${rangeToKey})`,
      400,
      'VALIDATION_ERROR',
    );
  }

  const shifts = await prisma.shift.findMany({ where: { active: true } });
  const errors: string[] = [];

  let syncUpdated = 0;
  let cleared = 0;
  let added = 0;
  let relocated = 0;
  let createdEmployees = 0;
  const createdCodes: string[] = [];
  const archivedCodes: string[] = [];
  const untrackedUsers: UntrackedImportUser[] = [];
  const skippedCodes = new Set<string>();
  const locationId = grid.locationId ?? grid.location?.id ?? null;
  const locationName = grid.location?.name ?? grid.gridLocation ?? null;

  for (let rowNum = dataStartRow; rowNum <= sheet.rowCount; rowNum++) {
    if (isJobGroupRow(sheet, rowNum)) continue;

    const row = sheet.getRow(rowNum);
    const code = normalizeEmployeeCode(row.getCell(CODE_COL).value);
    if (!code) continue;

    const excelName = cellText(row.getCell(3).value);
    const excelJob = cellText(row.getCell(2).value);

    let employee = await findEmployeeByCode(code);
    if (!employee) {
      let filledShiftCells = 0;
      for (const { col } of dateCols) {
        if (cellText(row.getCell(col).value)) filledShiftCells++;
      }

      if (createCodeSet.has(code)) {
        try {
          employee = await createEmployeeFromShiftImport({
            code,
            name: excelName,
            jobTitle: excelJob,
            locationId,
            locationName,
          });
          createdEmployees++;
          createdCodes.push(code);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          skippedCodes.add(code);
          untrackedUsers.push({
            excelRow: rowNum,
            code,
            excelName,
            excelJob,
            filledShiftCells,
            reason: `فشل إنشاء الموظف: ${msg}`,
          });
          errors.push(`صف ${rowNum} / كود ${code}: فشل إنشاء الموظف — ${msg}`);
          continue;
        }
      } else {
        skippedCodes.add(code);
        untrackedUsers.push({
          excelRow: rowNum,
          code,
          excelName,
          excelJob,
          filledShiftCells,
          reason: 'الكود غير مسجل في النظام — لم يتم إضافة هذا الموظف للجدول',
        });
        continue;
      }
    }

    const onboard = await ensureEmployeeOnGrid(gridId, grid, employee.id);
    if (onboard.added) added++;
    if (onboard.relocated) relocated++;

    // Pre-scan labels so restore happens before cells when row has active assignments.
    const preActions: LifecycleAction[] = [];
    for (const { col } of dateCols) {
      const raw = cellText(row.getCell(col).value);
      if (!raw || raw === LABEL_DEPARTED) continue;
      try {
        const flags = excelLabelToCellFlags(raw, shifts);
        preActions.push(lifecycleActionFromFlags(flags));
      } catch {
        // invalid cell — handled in the apply loop
      }
    }
    const preMerged = mergeLifecycleActions(preActions);
    if (preMerged === 'restore') {
      await applyMergedLifecycleAction(employee.id, 'restore');
      const refreshed = await prisma.employeeProfile.findUnique({ where: { id: employee.id } });
      if (refreshed) employee = refreshed;
    }

    const lifecycleActions: LifecycleAction[] = [];

    for (const { col, date } of dateCols) {
      const day = new Date(`${date}T00:00:00.000Z`);

      const existing = await prisma.shiftGridLine.findUnique({
        where: { gridId_employeeId_date: { gridId, employeeId: employee.id, date: day } },
        include: { shift: true },
      });

      const raw = cellText(row.getCell(col).value);
      if (!raw) {
        const result = await clearGridCell(gridId, employee.id, day, existing);
        if (result === 'cleared') cleared++;
        continue;
      }

      // Legacy export placeholder — ignore, don't block other days.
      if (raw === LABEL_DEPARTED) continue;

      try {
        const flags = excelLabelToCellFlags(raw, shifts);
        const result = await applyFlagsToGridCell(gridId, employee.id, day, flags, existing);
        if (result === 'updated') syncUpdated++;
        lifecycleActions.push(lifecycleActionFromFlags(flags));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`صف ${rowNum} / ${date}: ${msg}`);
      }
    }

    const merged = mergeLifecycleActions(lifecycleActions);
    if (merged === 'archive') {
      await applyMergedLifecycleAction(employee.id, 'archive');
      const codeLabel = employee.code ?? employee.identificationId ?? employee.id;
      if (codeLabel) archivedCodes.push(String(codeLabel));
    }
  }

  const skippedList = [...skippedCodes];
  const baseResult = {
    updated: syncUpdated,
    cleared,
    added,
    relocated,
    createdEmployees,
    createdCodes,
    archivedCodes,
    skippedCodes: skippedList,
    untrackedUsers,
  };

  if (errors.length > 20) {
    const extra = errors.length - 20;
    return {
      ...baseResult,
      errors: [...errors.slice(0, 20), `... و${extra} أخطاء إضافية`],
    };
  }

  return {
    ...baseResult,
    errors,
  };
}
