import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';

const HEADERS = ['الكود', 'الاسم', 'بداية', 'نهاية', 'ليلي', 'سماح دخول', 'سماح خروج', 'نشط'] as const;
const COL_COUNT = HEADERS.length;

const COLORS = {
  primary: 'FF6366F1',
  headerBg: 'FFEEF2FF',
  headerFg: 'FF1E293B',
  titleFg: 'FFFFFFFF',
  border: 'FFE2E8F0',
  zebra: 'FFF8FAFC',
  hintBg: 'FFF1F5F9',
  hintFg: 'FF64748B',
} as const;

const TITLE_ROW = 1;
const HINT_ROW = 2;
const HEADER_ROW = 3;
const DATA_START_ROW = 4;

type ShiftCols = {
  code: number;
  name: number;
  start: number;
  end: number;
  overnight: number;
  graceIn: number;
  graceOut: number;
  active: number;
};

const HEADER_ALIASES: Record<keyof ShiftCols, string[]> = {
  code: ['الكود', 'code', 'كود'],
  name: ['الاسم', 'name', 'اسم'],
  start: ['بداية', 'start', 'بداية الشيفت', 'من'],
  end: ['نهاية', 'end', 'نهاية الشيفت', 'إلى'],
  overnight: ['ليلي', 'overnight', 'شيفت ليلي'],
  graceIn: ['سماح دخول', 'grace in', 'سماح الدخول'],
  graceOut: ['سماح خروج', 'grace out', 'سماح الخروج'],
  active: ['نشط', 'active', 'فعال'],
};

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: 'thin' as const, color: { argb: COLORS.border } };
  return { top: side, left: side, bottom: side, right: side };
}

/** ExcelJS row.values with a leading undefined shifts columns — write cells explicitly. */
function writeRowCells(row: ExcelJS.Row, values: readonly (string | number)[]) {
  for (let c = 0; c < values.length; c++) {
    row.getCell(c + 1).value = values[c];
  }
}

function shiftExportCode(s: { code: string | null; name: string; id: string }): string {
  const stored = s.code?.trim();
  if (stored) return stored;
  const slug = s.name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u0600-\u06FF-]/g, '')
    .toUpperCase()
    .slice(0, 24);
  return slug || `SHIFT_${s.id.slice(-6).toUpperCase()}`;
}

function styleTitleRow(sheet: ExcelJS.Worksheet) {
  sheet.mergeCells(TITLE_ROW, 1, TITLE_ROW, COL_COUNT);
  const cell = sheet.getCell(TITLE_ROW, 1);
  cell.value = 'Hudoori — قوالب الشيفتات';
  cell.font = { bold: true, size: 16, color: { argb: COLORS.titleFg } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.primary } };
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(TITLE_ROW).height = 36;
}

function styleHintRow(sheet: ExcelJS.Worksheet) {
  sheet.mergeCells(HINT_ROW, 1, HINT_ROW, COL_COUNT);
  const cell = sheet.getCell(HINT_ROW, 1);
  cell.value =
    'الأوقات: 08:00 أو 8.5  •  ليلي / نشط: نعم أو لا  •  الكود يُولَّد تلقائياً إن كان فارغاً  •  عدّل الصفوف ثم استورد';
  cell.font = { size: 10, color: { argb: COLORS.hintFg } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.hintBg } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.getRow(HINT_ROW).height = 32;
}

function styleHeaderRow(row: ExcelJS.Row) {
  row.height = 24;
  for (let c = 1; c <= COL_COUNT; c++) {
    const cell = row.getCell(c);
    cell.font = { bold: true, size: 11, color: { argb: COLORS.headerFg } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    cell.border = thinBorder();
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  }
}

function styleDataRow(row: ExcelJS.Row, zebra: boolean) {
  row.height = 20;
  for (let c = 1; c <= COL_COUNT; c++) {
    const cell = row.getCell(c);
    cell.border = thinBorder();
    cell.alignment = {
      vertical: 'middle',
      horizontal: c === 2 ? 'right' : 'center',
      readingOrder: 'rtl',
    };
    if (zebra) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.zebra } };
    }
    if (c === 6 || c === 7) cell.numFmt = '0';
  }
}

function applyColumnWidths(sheet: ExcelJS.Worksheet) {
  const widths = [14, 26, 11, 11, 10, 14, 14, 10];
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String((value as { text: string }).text ?? '').trim();
  }
  if (typeof value === 'number' && value >= 0 && value < 1) {
    const totalMins = Math.round(value * 24 * 60);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  return String(value).trim();
}

/** Accept 8, 8.5, "08:00", "8:30" → stored as HH:MM */
export function normalizeShiftTime(value: unknown): string {
  if (value == null || value === '') return '08:00';
  if (typeof value === 'number' && !Number.isNaN(value)) {
    if (value >= 0 && value < 1) return normalizeShiftTime(cellText(value));
    const h = Math.floor(value);
    const m = Math.round((value - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const raw = cellText(value).replace('.', ':');
  if (/^\d{1,2}$/.test(raw)) return `${raw.padStart(2, '0')}:00`;
  if (/^\d{1,2}:\d{1,2}$/.test(raw)) {
    const [h, m] = raw.split(':');
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  }
  return raw;
}

function parseBool(value: unknown, defaultValue = true): boolean {
  if (value == null || value === '') return defaultValue;
  const v = cellText(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'نعم', '✓'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'لا'].includes(v)) return false;
  return defaultValue;
}

function parseIntSafe(value: unknown, fallback = 0): number {
  const n = parseInt(cellText(value), 10);
  return Number.isNaN(n) ? fallback : n;
}

function isHeaderRow(sheet: ExcelJS.Worksheet, rowNum: number): boolean {
  const row = sheet.getRow(rowNum);
  for (let c = 1; c <= sheet.columnCount; c++) {
    const v = cellText(row.getCell(c).value);
    if (v === 'الكود' || v.toLowerCase() === 'code' || v === 'الاسم' || v.toLowerCase() === 'name') {
      return true;
    }
  }
  return false;
}

function resolveColumns(sheet: ExcelJS.Worksheet, headerRowNum: number): ShiftCols {
  const found: Partial<Record<keyof ShiftCols, number>> = {};
  sheet.getRow(headerRowNum).eachCell((cell, col) => {
    const v = cellText(cell.value).toLowerCase();
    for (const [key, aliases] of Object.entries(HEADER_ALIASES) as [keyof ShiftCols, string[]][]) {
      if (aliases.some((a) => v === a.toLowerCase())) found[key] = col;
    }
  });
  if (!found.name) throw new Error('لم يُعثر على عمود «الاسم» في الملف');

  const nameCol = found.name;
  return {
    code: found.code ?? Math.max(1, nameCol - 1),
    name: nameCol,
    start: found.start ?? nameCol + 1,
    end: found.end ?? nameCol + 2,
    overnight: found.overnight ?? nameCol + 3,
    graceIn: found.graceIn ?? nameCol + 4,
    graceOut: found.graceOut ?? nameCol + 5,
    active: found.active ?? nameCol + 6,
  };
}

export async function exportShiftsXlsx(): Promise<string> {
  const shifts = await prisma.shift.findMany({ orderBy: [{ code: 'asc' }, { name: 'asc' }] });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hudoori';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('الشيفتات', {
    properties: { defaultRowHeight: 20 },
  });
  sheet.views = [{ rightToLeft: false, state: 'frozen', ySplit: HEADER_ROW, activeCell: 'A4' }];

  styleTitleRow(sheet);
  styleHintRow(sheet);

  const headerRow = sheet.getRow(HEADER_ROW);
  writeRowCells(headerRow, HEADERS);
  styleHeaderRow(headerRow);

  const rows =
    shifts.length > 0
      ? shifts.map((s) => [
          s.code?.trim() || shiftExportCode(s),
          s.name,
          s.startTime,
          s.endTime,
          s.isOvernight ? 'نعم' : 'لا',
          s.gracePeriodIn,
          s.gracePeriodOut,
          s.active ? 'نعم' : 'لا',
        ])
      : [['MORNING', 'صباحي (مثال)', '08:00', '17:00', 'لا', 10, 5, 'نعم']];

  rows.forEach((values, i) => {
    const row = sheet.getRow(DATA_START_ROW + i);
    writeRowCells(row, values);
    styleDataRow(row, i % 2 === 1);
  });

  applyColumnWidths(sheet);

  return workbookToBase64(workbook);
}

export async function importShiftsXlsx(base64: string): Promise<{
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    Buffer.from(base64.replace(/^data:.*;base64,/, ''), 'base64') as unknown as ExcelJS.Buffer,
  );

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('ملف Excel فارغ');

  let headerRowNum = 1;
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    if (isHeaderRow(sheet, r)) {
      headerRowNum = r;
      break;
    }
  }

  const cols = resolveColumns(sheet, headerRowNum);
  const result = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };

  for (let r = headerRowNum + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const code = cellText(row.getCell(cols.code).value);
    const name = cellText(row.getCell(cols.name).value);
    if (!code && !name) {
      result.skipped++;
      continue;
    }
    if (name.includes('(مثال)') || name.toLowerCase().includes('(example)')) {
      result.skipped++;
      continue;
    }
    if (!name) {
      result.errors.push(`صف ${r}: الاسم مطلوب`);
      continue;
    }

    const data = {
      name,
      code: code || null,
      startTime: normalizeShiftTime(row.getCell(cols.start).value),
      endTime: normalizeShiftTime(row.getCell(cols.end).value ?? '17:00'),
      isOvernight: parseBool(row.getCell(cols.overnight).value, false),
      gracePeriodIn: parseIntSafe(row.getCell(cols.graceIn).value, 0),
      gracePeriodOut: parseIntSafe(row.getCell(cols.graceOut).value, 0),
      active: parseBool(row.getCell(cols.active).value, true),
    };

    try {
      const existing = code
        ? await prisma.shift.findFirst({ where: { code } })
        : await prisma.shift.findFirst({ where: { name } });

      if (existing) {
        await prisma.shift.update({ where: { id: existing.id }, data });
        result.updated++;
      } else {
        await prisma.shift.create({ data: { ...data, code: code || undefined } });
        result.created++;
      }
    } catch (err) {
      result.errors.push(`صف ${r}: ${err instanceof Error ? err.message : 'خطأ'}`);
    }
  }

  return result;
}
