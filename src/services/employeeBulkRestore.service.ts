/**
 * Bulk unarchive: export archived employees (one row per code) and import a
 * list of codes to restore. Only column A (employee code) is read on import.
 */
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { exportFileResponse } from './payrollExport.service';
import { restoreEmployee } from './employeeArchive.service';
import { syncEmployeeLoginFromWorkEmail } from './employeeLogin.service';

const HEADERS = ['كود الموظف', 'الاسم', 'الفرع', 'تاريخ الأرشفة', 'سبب الأرشفة'] as const;

export type BulkRestoreRestoredRow = {
  employeeId: string;
  code: string;
  name: string;
};

export type BulkRestoreRejectedRow = {
  rowNumber: number;
  code: string;
  name: string;
  reason: string;
};

export type BulkRestoreResult = {
  restored: BulkRestoreRestoredRow[];
  rejected: BulkRestoreRejectedRow[];
  skippedEmpty: number;
  failuresFile?: ReturnType<typeof exportFileResponse>;
  message: string;
};

function cellText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'object') {
    if ('result' in (raw as object)) return cellText((raw as { result: unknown }).result);
    if ('text' in (raw as object)) return String((raw as { text: unknown }).text ?? '').trim();
    if ('richText' in (raw as object)) {
      const parts = (raw as { richText: Array<{ text?: string }> }).richText ?? [];
      return parts.map((p) => p.text ?? '').join('').trim();
    }
  }
  return String(raw).trim();
}

function fmtDate(d: Date | null): string {
  if (!d) return '';
  return d.toISOString().slice(0, 10);
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

function writeHeader(sheet: ExcelJS.Worksheet, headers: readonly string[]) {
  headers.forEach((h, i) => {
    const c = sheet.getCell(1, i + 1);
    c.value = h;
    c.font = { bold: true };
  });
  sheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
}

export async function exportArchivedEmployeesXlsx(
  hrScopeLocationId: string | null,
): Promise<ReturnType<typeof exportFileResponse>> {
  const rows = await prisma.employeeProfile.findMany({
    where: {
      active: false,
      ...(hrScopeLocationId ? { locationId: hrScopeLocationId } : {}),
    },
    select: {
      code: true,
      identificationId: true,
      name: true,
      archivedAt: true,
      archiveReason: true,
      workLocation: { select: { name: true } },
      location: true,
    },
    orderBy: [{ archivedAt: 'desc' }, { name: 'asc' }],
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('إلغاء الأرشفة');
  writeHeader(sheet, HEADERS);
  rows.forEach((row, idx) => {
    const r = idx + 2;
    sheet.getCell(r, 1).value = row.code || row.identificationId || '';
    sheet.getCell(r, 2).value = row.name || '';
    sheet.getCell(r, 3).value = row.workLocation?.name || row.location || '';
    sheet.getCell(r, 4).value = fmtDate(row.archivedAt);
    sheet.getCell(r, 5).value = row.archiveReason || '';
  });
  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 32;
  sheet.getColumn(3).width = 20;
  sheet.getColumn(4).width = 14;
  sheet.getColumn(5).width = 28;

  const base64 = await workbookToBase64(workbook);
  return exportFileResponse(base64, `archived_employees_${Date.now()}.xlsx`);
}

async function buildFailuresXlsx(
  rejected: BulkRestoreRejectedRow[],
): Promise<ReturnType<typeof exportFileResponse>> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('لم يتم');
  writeHeader(sheet, ['صف', 'كود الموظف', 'الاسم', 'السبب']);
  rejected.forEach((row, idx) => {
    const r = idx + 2;
    sheet.getCell(r, 1).value = row.rowNumber;
    sheet.getCell(r, 2).value = row.code;
    sheet.getCell(r, 3).value = row.name;
    sheet.getCell(r, 4).value = row.reason;
  });
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 32;
  sheet.getColumn(4).width = 48;
  const base64 = await workbookToBase64(workbook);
  return exportFileResponse(base64, `unarchive_rejected_${Date.now()}.xlsx`);
}

function parseCodes(workbook: ExcelJS.Workbook): {
  items: Array<{ rowNumber: number; code: string }>;
  skippedEmpty: number;
} {
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new AppError('ملف Excel فارغ', 400, 'VALIDATION');
  const items: Array<{ rowNumber: number; code: string }> = [];
  let skippedEmpty = 0;
  const last = sheet.actualRowCount > 0 ? sheet.rowCount : 0;
  for (let r = 2; r <= last; r++) {
    const code = cellText(sheet.getCell(r, 1).value);
    if (!code) {
      skippedEmpty++;
      continue;
    }
    items.push({ rowNumber: r, code });
  }
  return { items, skippedEmpty };
}

function codeWhere(code: string) {
  return {
    OR: [
      { code: { equals: code, mode: 'insensitive' as const } },
      { identificationId: { equals: code, mode: 'insensitive' as const } },
      { barcode: { equals: code, mode: 'insensitive' as const } },
    ],
  };
}

export async function importBulkRestoreXlsx(
  base64: string,
  hrScopeLocationId: string | null,
): Promise<BulkRestoreResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(base64, 'base64') as unknown as ExcelJS.Buffer);
  const { items, skippedEmpty } = parseCodes(workbook);
  if (!items.length) {
    throw new AppError('لا توجد أكواد في العمود الأول من الملف', 400, 'VALIDATION');
  }

  const restored: BulkRestoreRestoredRow[] = [];
  const rejected: BulkRestoreRejectedRow[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const key = item.code.toLowerCase();
    if (seen.has(key)) {
      rejected.push({ ...item, name: '', reason: 'الكود مكرر في الملف' });
      continue;
    }
    seen.add(key);

    const matches = await prisma.employeeProfile.findMany({
      where: codeWhere(item.code),
      select: { id: true, name: true, code: true, active: true, locationId: true },
    });

    if (!matches.length) {
      rejected.push({ ...item, name: '', reason: 'الكود غير موجود' });
      continue;
    }

    const active = matches.filter((m) => m.active);
    const archived = matches.filter((m) => !m.active);

    if (!archived.length) {
      rejected.push({
        ...item,
        name: active[0]?.name || '',
        reason: 'الموظف نشط بالفعل (غير مؤرشف)',
      });
      continue;
    }

    if (active.length) {
      rejected.push({
        ...item,
        name: archived[0].name || '',
        reason: `الكود مستخدم لموظف نشط آخر: ${active[0].name || active[0].id}`,
      });
      continue;
    }

    if (archived.length > 1) {
      rejected.push({
        ...item,
        name: archived.map((a) => a.name || a.id).join('، '),
        reason: 'أكثر من موظف مؤرشف بنفس الكود — استعده من صفحة الموظف',
      });
      continue;
    }

    const target = archived[0];
    if (hrScopeLocationId && target.locationId !== hrScopeLocationId) {
      rejected.push({ ...item, name: target.name || '', reason: 'الموظف خارج نطاق فرعك' });
      continue;
    }

    try {
      await restoreEmployee(target.id);
      await syncEmployeeLoginFromWorkEmail(target.id);
      restored.push({
        employeeId: target.id,
        code: target.code || item.code,
        name: target.name || '',
      });
    } catch (e) {
      rejected.push({
        ...item,
        name: target.name || '',
        reason: e instanceof Error ? e.message : 'تعذّرت الاستعادة',
      });
    }
  }

  const failuresFile = rejected.length ? await buildFailuresXlsx(rejected) : undefined;
  return {
    restored,
    rejected,
    skippedEmpty,
    failuresFile,
    message: `تم إلغاء أرشفة ${restored.length} موظف — لم يتم ${rejected.length}`,
  };
}
