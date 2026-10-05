/**
 * Monthly reports Excel: empty template + import that updates shifts and
 * manual-OT eligibility on merged shift grids only (including confirmed).
 */
import ExcelJS from 'exceljs';
import type { Shift } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { exportFileResponse } from './payrollExport.service';
import { utcDateOnly } from '../utils/payrollPeriod';
import {
  buildDropdownOptionLabels,
  excelLabelToCellFlags,
  lineToExcelDropdownLabel,
} from './shiftGridExcelLabels';

const HEADERS = ['كود', 'اسم', 'تاريخ', 'تغير شفتات', 'إضافي'] as const;
const TEMPLATE_DATA_ROWS = 500;
const YES = 'نعم';
const NO = 'لا';

export type MonthlyReportPeriod = {
  dateFrom: string;
  dateTo: string;
  label: string;
  mergedGridCount: number;
};

export type MonthlyReportRejectedRow = {
  code: string;
  name: string;
  date: string;
  shiftName: string;
  overtime: string;
  reason: string;
};

/** One applied/rejected change for audit UI + Excel export. */
export type MonthlyReportChangeRow = {
  entityId: string;
  entityLabel: string;
  field: 'shiftId' | 'manualOt' | 'reject';
  before: string | null;
  after: string | null;
  note: string;
};

export type MonthlyReportImportResult = {
  applied: number;
  rejected: MonthlyReportRejectedRow[];
  changes: MonthlyReportChangeRow[];
  shiftUpdates: number;
  overtimeAdded: number;
  overtimeRemoved: number;
  skippedEmpty: number;
  failuresFile?: ReturnType<typeof exportFileResponse>;
  message: string;
};

function dayKey(d: Date): string {
  return utcDateOnly(d).toISOString().slice(0, 10);
}

function parseDayInput(raw: unknown): Date | null {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return utcDateOnly(raw);
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Excel serial date
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + Math.round(raw) * 86400000);
    return utcDateOnly(d);
  }
  if (typeof raw === 'object' && raw !== null && 'result' in (raw as object)) {
    return parseDayInput((raw as { result: unknown }).result);
  }
  if (typeof raw === 'object' && raw !== null && 'text' in (raw as object)) {
    return parseDayInput((raw as { text: unknown }).text);
  }
  const s = String(raw).trim();
  if (!s) return null;
  // DD/MM/YYYY or YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return utcDateOnly(new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`));
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) {
    const dd = dmy[1]!.padStart(2, '0');
    const mm = dmy[2]!.padStart(2, '0');
    const yyyy = dmy[3]!;
    return utcDateOnly(new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`));
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return utcDateOnly(d);
}

function cellText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'object' && raw !== null) {
    if ('result' in (raw as object)) return cellText((raw as { result: unknown }).result);
    if ('text' in (raw as object)) return String((raw as { text: unknown }).text ?? '').trim();
    if ('richText' in (raw as object)) {
      const parts = (raw as { richText: Array<{ text?: string }> }).richText ?? [];
      return parts.map((p) => p.text ?? '').join('').trim();
    }
  }
  if (raw instanceof Date) return dayKey(raw);
  return String(raw).trim();
}

function eachPeriodDay(dateFrom: Date, dateTo: Date): string[] {
  const out: string[] = [];
  let cur = utcDateOnly(dateFrom).getTime();
  const end = utcDateOnly(dateTo).getTime();
  while (cur <= end) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86400000;
  }
  return out;
}

function addListValidation(
  sheet: ExcelJS.Worksheet,
  colLetter: string,
  lastRow: number,
  formulae: string[],
) {
  const validations = (
    sheet as ExcelJS.Worksheet & {
      dataValidations: { add: (address: string, validation: Record<string, unknown>) => void };
    }
  ).dataValidations;
  // Dropdown only — no error/input popups (Excel yellow "قيمة غير مسموحة" banner).
  validations.add(`${colLetter}2:${colLetter}${lastRow}`, {
    type: 'list',
    allowBlank: true,
    formulae,
    showErrorMessage: false,
    showInputMessage: false,
  });
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

export async function listMonthlyReportPeriods(): Promise<MonthlyReportPeriod[]> {
  const grids = await prisma.shiftGrid.findMany({
    where: { mergedFromGridIds: { isEmpty: false } },
    select: { dateFrom: true, dateTo: true },
    orderBy: [{ dateFrom: 'desc' }, { dateTo: 'desc' }],
  });
  const map = new Map<string, MonthlyReportPeriod>();
  for (const g of grids) {
    const dateFrom = dayKey(g.dateFrom);
    const dateTo = dayKey(g.dateTo);
    const key = `${dateFrom}|${dateTo}`;
    const existing = map.get(key);
    if (existing) {
      existing.mergedGridCount += 1;
    } else {
      map.set(key, {
        dateFrom,
        dateTo,
        label: `${dateFrom} → ${dateTo}`,
        mergedGridCount: 1,
      });
    }
  }
  return [...map.values()];
}

export async function exportMonthlyReportsTemplate(params: {
  dateFrom: string;
  dateTo: string;
}): Promise<ReturnType<typeof exportFileResponse>> {
  const from = parseDayInput(params.dateFrom);
  const to = parseDayInput(params.dateTo);
  if (!from || !to || from.getTime() > to.getTime()) {
    throw new AppError('حدد فترة صحيحة من / إلى', 400, 'VALIDATION');
  }

  const days = eachPeriodDay(from, to);
  // Same dropdown as shift-grid Excel / UI: statuses + all active shifts (+ bus variants).
  const shifts = await prisma.shift.findMany({
    where: { active: true },
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
  });
  const optionLabels = buildDropdownOptionLabels(shifts);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hudoori';
  const sheet = workbook.addWorksheet('التقارير الشهرية', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }],
  });
  const lists = workbook.addWorksheet('قوائم');
  lists.state = 'hidden';

  lists.getCell(1, 1).value = 'التواريخ';
  days.forEach((d, i) => {
    lists.getCell(i + 2, 1).value = d;
  });
  lists.getCell(1, 2).value = 'الشفتات والحالات';
  optionLabels.forEach((label, i) => {
    lists.getCell(i + 2, 2).value = label;
  });

  HEADERS.forEach((h, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    cell.alignment = { horizontal: 'center' };
  });

  sheet.getColumn(1).width = 12;
  sheet.getColumn(2).width = 28;
  sheet.getColumn(3).width = 14;
  sheet.getColumn(4).width = 22;
  sheet.getColumn(5).width = 10;

  const lastRow = TEMPLATE_DATA_ROWS + 1;
  const dateEnd = Math.max(days.length, 1) + 1;
  const shiftEnd = Math.max(optionLabels.length, 1) + 1;
  addListValidation(sheet, 'C', lastRow, [`قوائم!$A$2:$A$${dateEnd}`]);
  addListValidation(sheet, 'D', lastRow, [`قوائم!$B$2:$B$${shiftEnd}`]);
  addListValidation(sheet, 'E', lastRow, [`"${YES},${NO}"`]);

  const meta = workbook.addWorksheet('_meta');
  meta.state = 'hidden';
  meta.getCell(1, 1).value = 'kind';
  meta.getCell(1, 2).value = 'monthly_reports';
  meta.getCell(2, 1).value = 'date_from';
  meta.getCell(2, 2).value = dayKey(from);
  meta.getCell(3, 1).value = 'date_to';
  meta.getCell(3, 2).value = dayKey(to);

  const base64 = await workbookToBase64(workbook);
  return exportFileResponse(
    base64,
    `تقارير_شهرية_${dayKey(from)}_${dayKey(to)}.xlsx`,
  );
}

async function buildFailuresXlsx(
  rejected: MonthlyReportRejectedRow[],
): Promise<ReturnType<typeof exportFileResponse>> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('مرفوض', { views: [{ rightToLeft: true }] });
  const headers = [...HEADERS, 'سبب الرفض'];
  headers.forEach((h, i) => {
    const c = sheet.getCell(1, i + 1);
    c.value = h;
    c.font = { bold: true };
  });
  rejected.forEach((row, idx) => {
    const r = idx + 2;
    sheet.getCell(r, 1).value = row.code;
    sheet.getCell(r, 2).value = row.name;
    sheet.getCell(r, 3).value = row.date;
    sheet.getCell(r, 4).value = row.shiftName;
    sheet.getCell(r, 5).value = row.overtime;
    sheet.getCell(r, 6).value = row.reason;
  });
  const base64 = await workbookToBase64(workbook);
  return exportFileResponse(base64, `تقارير_شهرية_مرفوض_${Date.now()}.xlsx`);
}

type ParsedRow = {
  rowNumber: number;
  code: string;
  name: string;
  date: Date | null;
  dateRaw: string;
  shiftName: string;
  overtimeRaw: string;
};

function parseImportRows(workbook: ExcelJS.Workbook): ParsedRow[] {
  const sheet =
    workbook.getWorksheet('التقارير الشهرية') ??
    workbook.worksheets.find((w) => w.name !== 'قوائم' && w.name !== '_meta') ??
    workbook.worksheets[0];
  if (!sheet) throw new AppError('ملف Excel فارغ', 400, 'VALIDATION');

  const headerRow = sheet.getRow(1);
  const headerMap = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    headerMap.set(cellText(cell.value), col);
  });
  for (const h of HEADERS) {
    if (!headerMap.has(h)) {
      throw new AppError(`عمود مطلوب مفقود: ${h}`, 400, 'VALIDATION');
    }
  }

  const rows: ParsedRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const code = cellText(row.getCell(headerMap.get('كود')!).value);
    const name = cellText(row.getCell(headerMap.get('اسم')!).value);
    const dateCell = row.getCell(headerMap.get('تاريخ')!).value;
    const shiftName = cellText(row.getCell(headerMap.get('تغير شفتات')!).value);
    const overtimeRaw = cellText(row.getCell(headerMap.get('إضافي')!).value);
    if (!code && !name && !dateCell && !shiftName && !overtimeRaw) return;
    rows.push({
      rowNumber,
      code,
      name,
      date: parseDayInput(dateCell),
      dateRaw: cellText(dateCell),
      shiftName,
      overtimeRaw,
    });
  });
  return rows;
}

function normalizeOvertime(raw: string): 'yes' | 'no' | 'empty' {
  const v = raw.trim();
  if (!v) return 'empty';
  const lower = v.toLowerCase();
  if (v === YES || lower === 'yes' || lower === 'y' || lower === '1' || lower === 'true') {
    return 'yes';
  }
  if (v === NO || lower === 'no' || lower === 'n' || lower === '0' || lower === 'false') {
    return 'no';
  }
  return 'empty';
}

export async function importMonthlyReports(params: {
  base64: string;
  dateFrom: string;
  dateTo: string;
}): Promise<MonthlyReportImportResult> {
  const periodFrom = parseDayInput(params.dateFrom);
  const periodTo = parseDayInput(params.dateTo);
  if (!periodFrom || !periodTo || periodFrom.getTime() > periodTo.getTime()) {
    throw new AppError('حدد فترة صحيحة من / إلى', 400, 'VALIDATION');
  }
  const file = String(params.base64 ?? '').replace(/^data:.*;base64,/, '');
  if (!file) throw new AppError('ملف Excel مطلوب', 400, 'VALIDATION');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(file, 'base64') as unknown as ExcelJS.Buffer);
  const parsed = parseImportRows(workbook);

  const shifts = (await prisma.shift.findMany({
    where: { active: true },
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
  })) as Shift[];

  const codes = [...new Set(parsed.map((r) => r.code).filter(Boolean))];
  const employees = codes.length
    ? await prisma.employeeProfile.findMany({
        where: { OR: [{ code: { in: codes } }, { identificationId: { in: codes } }] },
        select: { id: true, code: true, name: true, identificationId: true },
      })
    : [];
  const empByCode = new Map<string, (typeof employees)[number]>();
  for (const e of employees) {
    if (e.code) empByCode.set(e.code.trim(), e);
    if (e.identificationId) empByCode.set(e.identificationId.trim(), e);
  }

  const mergedGrids = (await prisma.shiftGrid.findMany({
    where: {
      mergedFromGridIds: { isEmpty: false },
      dateFrom: { lte: periodTo },
      dateTo: { gte: periodFrom },
    },
    select: { id: true, name: true, dateFrom: true, dateTo: true },
  })) as Array<{ id: string; name: string; dateFrom: Date; dateTo: Date }>;
  const gridNameById = new Map(mergedGrids.map((g) => [g.id, g.name]));

  const rejected: MonthlyReportRejectedRow[] = [];
  const changes: MonthlyReportChangeRow[] = [];
  let applied = 0;
  let shiftUpdates = 0;
  let overtimeAdded = 0;
  let overtimeRemoved = 0;
  let skippedEmpty = 0;

  for (const row of parsed) {
    const reject = (reason: string) => {
      const dateStr = row.date ? dayKey(row.date) : row.dateRaw;
      rejected.push({
        code: row.code,
        name: row.name,
        date: dateStr,
        shiftName: row.shiftName,
        overtime: row.overtimeRaw,
        reason,
      });
      changes.push({
        entityId: row.code || '—',
        entityLabel: row.name || row.code || '—',
        field: 'reject',
        before: dateStr || null,
        after: null,
        note: reason,
      });
    };

    if (!row.code && !row.date && !row.shiftName && !row.overtimeRaw) {
      skippedEmpty += 1;
      continue;
    }
    if (!row.code) {
      reject('كود الموظف مطلوب');
      continue;
    }
    if (!row.date) {
      reject('تاريخ غير صالح');
      continue;
    }
    const dk = dayKey(row.date);
    if (row.date.getTime() < periodFrom.getTime() || row.date.getTime() > periodTo.getTime()) {
      reject(`التاريخ خارج الفترة المختارة (${dayKey(periodFrom)} → ${dayKey(periodTo)})`);
      continue;
    }

    const emp = empByCode.get(row.code);
    if (!emp) {
      reject('كود الموظف غير موجود في النظام');
      continue;
    }

    let cellFlags: ReturnType<typeof excelLabelToCellFlags> | null = null;
    if (row.shiftName) {
      try {
        cellFlags = excelLabelToCellFlags(row.shiftName, shifts);
      } catch (e: unknown) {
        reject(e instanceof Error ? e.message : `قيمة غير مسموحة: ${row.shiftName}`);
        continue;
      }
    }

    const otMode = normalizeOvertime(row.overtimeRaw);
    if (row.overtimeRaw && otMode === 'empty') {
      reject('قيمة إضافي غير مسموحة (نعم أو لا)');
      continue;
    }

    if (!row.shiftName && otMode === 'empty') {
      reject('لا يوجد شيفت ولا إضافي للتطبيق');
      continue;
    }

    const covering = mergedGrids.filter(
      (g) => dayKey(g.dateFrom) <= dk && dayKey(g.dateTo) >= dk,
    );
    if (!covering.length) {
      reject('لا يوجد جدول مدموج يغطي هذا التاريخ');
      continue;
    }

    const lines = (await prisma.shiftGridLine.findMany({
      where: {
        employeeId: emp.id,
        date: row.date,
        gridId: { in: covering.map((g) => g.id) },
      },
      include: { shift: true },
    })) as any[];
    if (!lines.length) {
      reject('التاريخ غير موجود على جدول مدموج لهذا الموظف');
      continue;
    }

    const targetGridIds = [...new Set(lines.map((l) => l.gridId))];
    const gridLabel = targetGridIds
      .map((id) => gridNameById.get(id) ?? id)
      .join('، ');
    const dateNote = `تاريخ ${dk} | جداول: ${gridLabel}`;
    const empLabel = emp.name || row.name || emp.code || row.code;

    if (cellFlags) {
      const beforeLabels = [
        ...new Set(lines.map((l) => lineToExcelDropdownLabel(l)).filter(Boolean)),
      ];
      const afterLabel = row.shiftName.trim();
      const sameAlready = lines.every(
        (l) => lineToExcelDropdownLabel(l) === afterLabel
          || (
            l.shiftId === cellFlags!.shiftId
            && l.isOff === cellFlags!.isOff
            && l.isSick === cellFlags!.isSick
            && l.isAnnualLeave === cellFlags!.isAnnualLeave
            && l.isExcluded === cellFlags!.isExcluded
            && l.isBusDelay === cellFlags!.isBusDelay
            && l.isPresent === cellFlags!.isPresent
            && l.isFinished === cellFlags!.isFinished
            && l.isResignation === cellFlags!.isResignation
            && l.isWorkAbsence === cellFlags!.isWorkAbsence
            && l.isWorkInjury === cellFlags!.isWorkInjury
            && l.isMarriageLeave === cellFlags!.isMarriageLeave
          ),
      );
      if (!sameAlready) {
        await prisma.shiftGridLine.updateMany({
          where: { id: { in: lines.map((l) => l.id) } },
          data: {
            shiftId: cellFlags.shiftId,
            isOff: cellFlags.isOff,
            isSick: cellFlags.isSick,
            isAnnualLeave: cellFlags.isAnnualLeave,
            isExcluded: cellFlags.isExcluded,
            isBusDelay: cellFlags.isBusDelay,
            isPresent: cellFlags.isPresent,
            isFinished: cellFlags.isFinished,
            isResignation: cellFlags.isResignation,
            isWorkAbsence: cellFlags.isWorkAbsence,
            isWorkInjury: cellFlags.isWorkInjury,
            isMarriageLeave: cellFlags.isMarriageLeave,
          },
        });
        shiftUpdates += lines.length;
        changes.push({
          entityId: emp.code || row.code,
          entityLabel: empLabel,
          field: 'shiftId',
          before: beforeLabels.join(' / ') || null,
          after: afterLabel,
          note: dateNote,
        });
      }
    }

    if (otMode === 'yes') {
      let addedHere = 0;
      for (const gridId of targetGridIds) {
        const existing = await prisma.shiftGridManualOtLine.findFirst({
          where: { gridId, employeeId: emp.id, date: row.date },
          select: { id: true },
        });
        if (!existing) {
          await prisma.shiftGridManualOtLine.create({
            data: {
              gridId,
              employeeId: emp.id,
              date: row.date,
              note: 'تقارير شهرية',
            },
          });
          overtimeAdded += 1;
          addedHere += 1;
        }
      }
      if (addedHere > 0) {
        changes.push({
          entityId: emp.code || row.code,
          entityLabel: empLabel,
          field: 'manualOt',
          before: 'لا',
          after: 'نعم',
          note: dateNote,
        });
      }
    } else {
      // «لا» أو فاضي → احذف إن وُجد
      const existingOt = (await prisma.shiftGridManualOtLine.findMany({
        where: {
          employeeId: emp.id,
          date: row.date,
          gridId: { in: targetGridIds },
        },
        select: { id: true },
      })) as Array<{ id: string }>;
      if (existingOt.length) {
        await prisma.shiftGridManualOtLine.deleteMany({
          where: { id: { in: existingOt.map((o) => o.id) } },
        });
        overtimeRemoved += existingOt.length;
        changes.push({
          entityId: emp.code || row.code,
          entityLabel: empLabel,
          field: 'manualOt',
          before: 'نعم',
          after: 'لا',
          note: dateNote,
        });
      }
    }

    applied += 1;
  }

  const failuresFile =
    rejected.length > 0 ? await buildFailuresXlsx(rejected) : undefined;

  return {
    applied,
    rejected,
    changes,
    shiftUpdates,
    overtimeAdded,
    overtimeRemoved,
    skippedEmpty,
    failuresFile,
    message: `تم تطبيق ${applied} صف — مرفوض ${rejected.length}`,
  };
}
