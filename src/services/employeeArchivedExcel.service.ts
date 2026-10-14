/**
 * Archived employees: full data export, archive-status template, and import.
 * Template columns: empcode | التاريخ | السبب (archive reasons + «يعمل»).
 */
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { exportFileResponse } from './payrollExport.service';
import { exportEmployeesXlsx } from './employeesExcel.service';
import { archiveEmployee, restoreEmployee } from './employeeArchive.service';
import { syncEmployeeLoginFromWorkEmail } from './employeeLogin.service';

export const WORKING_REASON = 'يعمل';

const TEMPLATE_HEADERS = ['empcode', 'التاريخ', 'السبب'] as const;
const TEMPLATE_EMPTY_ROWS = 200;

export type ArchivedImportAction =
  | 'archived'
  | 'archive_updated'
  | 'restored'
  | 'skipped';

export type ArchivedImportDetail = {
  rowNumber: number;
  code: string;
  name: string;
  action: ArchivedImportAction;
  detail: string;
  reason?: string;
  date?: string;
};

export type ArchivedImportResult = {
  details: ArchivedImportDetail[];
  archived: number;
  archiveUpdated: number;
  restored: number;
  skipped: number;
  message: string;
};

function cellText(raw: unknown): string {
  if (raw == null) return '';
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
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

function parseDateCell(raw: unknown): { iso: string; date: Date } | null {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const iso = raw.toISOString().slice(0, 10);
    return { iso, date: raw };
  }
  const text = cellText(raw);
  if (!text) return null;
  // Excel serial number
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 100000) {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const date = new Date(epoch.getTime() + serial * 86400000);
      if (!Number.isNaN(date.getTime())) {
        return { iso: date.toISOString().slice(0, 10), date };
      }
    }
  }
  const normalized = text.replace(/\//g, '-');
  const m = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (!Number.isNaN(date.getTime())) {
      return { iso: date.toISOString().slice(0, 10), date };
    }
  }
  const dmy = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    const date = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
    if (!Number.isNaN(date.getTime())) {
      return { iso: date.toISOString().slice(0, 10), date };
    }
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return { iso: parsed.toISOString().slice(0, 10), date: parsed };
  }
  return null;
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
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

/** Full employee Excel schema for archived employees only. */
export async function exportArchivedEmployeesFullXlsx(
  hrScopeLocationId: string | null,
): Promise<ReturnType<typeof exportFileResponse>> {
  const base64 = await exportEmployeesXlsx({
    active: false,
    locationId: hrScopeLocationId ?? undefined,
  });
  return exportFileResponse(base64, `archived_employees_full_${Date.now()}.xlsx`);
}

/** Empty template: empcode / التاريخ / السبب (dropdown). */
export async function exportArchiveStatusTemplateXlsx(): Promise<
  ReturnType<typeof exportFileResponse>
> {
  const reasons = await prisma.archiveReason.findMany({
    where: { active: true },
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
    select: { name: true },
  });

  const reasonNames = reasons.map((r) => r.name.trim()).filter(Boolean);
  if (!reasonNames.some((n) => n === WORKING_REASON)) {
    reasonNames.push(WORKING_REASON);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hudoori';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('أرشفة', {
    properties: { defaultRowHeight: 20 },
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }],
  });

  TEMPLATE_HEADERS.forEach((h, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF343A40' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  sheet.getRow(1).height = 24;
  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 14;
  sheet.getColumn(3).width = 28;
  sheet.getColumn(1).numFmt = '@';
  sheet.getColumn(2).numFmt = 'yyyy-mm-dd';

  sheet.getCell(1, 1).note = 'كود الموظف (مطلوب)';
  sheet.getCell(1, 2).note =
    'تاريخ الأرشفة/الإنهاء (مطلوب إلا إذا كان السبب «يعمل») — يُتجاهل عند إلغاء الأرشفة';
  sheet.getCell(1, 3).note =
    'سبب من القائمة، أو «يعمل» لإلغاء الأرشفة إذا كان الموظف مؤرشفًا';

  const lookups = workbook.addWorksheet('Lookups');
  lookups.state = 'hidden';
  lookups.getCell(1, 1).value = 'السبب';
  reasonNames.forEach((name, i) => {
    lookups.getCell(i + 2, 1).value = name;
  });
  const reasonRange =
    reasonNames.length > 0
      ? `Lookups!$A$2:$A$${reasonNames.length + 1}`
      : `"${WORKING_REASON}"`;

  const validations = (
    sheet as ExcelJS.Worksheet & {
      dataValidations: { add: (address: string, validation: Record<string, unknown>) => void };
    }
  ).dataValidations;
  validations.add(`C2:C${TEMPLATE_EMPTY_ROWS + 1}`, {
    type: 'list',
    allowBlank: true,
    formulae: [reasonRange],
    showErrorMessage: true,
    errorTitle: 'قيمة غير مسموحة',
    error: 'اختر سببًا من القائمة أو «يعمل»',
  });

  for (let r = 2; r <= TEMPLATE_EMPTY_ROWS + 1; r++) {
    sheet.getRow(r).height = 20;
  }

  const base64 = await workbookToBase64(workbook);
  return exportFileResponse(base64, `archive_status_template_${Date.now()}.xlsx`);
}

function mapHeaderCols(sheet: ExcelJS.Worksheet): {
  codeCol: number;
  dateCol: number;
  reasonCol: number;
} {
  const aliases: Record<string, 'code' | 'date' | 'reason'> = {
    empcode: 'code',
    code: 'code',
    'كود الموظف': 'code',
    'كود': 'code',
    التاريخ: 'date',
    date: 'date',
    'تاريخ الأرشفة': 'date',
    'تاريخ الانهاء': 'date',
    'تاريخ الإنهاء': 'date',
    السبب: 'reason',
    reason: 'reason',
    'سبب الأرشفة': 'reason',
  };

  let codeCol = 0;
  let dateCol = 0;
  let reasonCol = 0;
  const headerRow = sheet.getRow(1);
  const lastCol = Math.max(sheet.columnCount, 3);
  for (let c = 1; c <= lastCol; c++) {
    const key = cellText(headerRow.getCell(c).value).toLowerCase();
    const mapped = aliases[key] ?? aliases[cellText(headerRow.getCell(c).value)];
    if (mapped === 'code') codeCol = c;
    if (mapped === 'date') dateCol = c;
    if (mapped === 'reason') reasonCol = c;
  }

  // Fallback to fixed A/B/C if headers missing
  if (!codeCol) codeCol = 1;
  if (!dateCol) dateCol = 2;
  if (!reasonCol) reasonCol = 3;
  return { codeCol, dateCol, reasonCol };
}

export async function importArchiveStatusXlsx(
  base64: string,
  hrScopeLocationId: string | null,
  actor?: string | null,
): Promise<ArchivedImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(base64, 'base64') as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new AppError('ملف Excel فارغ', 400, 'VALIDATION');

  const reasons = await prisma.archiveReason.findMany({
    where: { active: true },
    select: { name: true },
  });
  const reasonByLower = new Map(
    reasons.map((r) => [r.name.trim().toLowerCase(), r.name.trim()] as const),
  );

  const { codeCol, dateCol, reasonCol } = mapHeaderCols(sheet);
  const details: ArchivedImportDetail[] = [];
  const seen = new Set<string>();
  const last = sheet.actualRowCount > 0 ? sheet.rowCount : 0;

  let archived = 0;
  let archiveUpdated = 0;
  let restored = 0;
  let skipped = 0;

  const pushSkip = (
    rowNumber: number,
    code: string,
    name: string,
    detail: string,
    extra?: { reason?: string; date?: string },
  ) => {
    skipped++;
    details.push({
      rowNumber,
      code,
      name,
      action: 'skipped',
      detail,
      reason: extra?.reason,
      date: extra?.date,
    });
  };

  for (let r = 2; r <= last; r++) {
    const code = cellText(sheet.getCell(r, codeCol).value);
    const reasonRaw = cellText(sheet.getCell(r, reasonCol).value);
    const dateRaw = sheet.getCell(r, dateCol).value;

    if (!code && !reasonRaw && cellText(dateRaw) === '') continue;

    if (!code) {
      pushSkip(r, '', '', 'الكود فارغ');
      continue;
    }

    const key = code.toLowerCase();
    if (seen.has(key)) {
      pushSkip(r, code, '', 'الكود مكرر في الملف');
      continue;
    }
    seen.add(key);

    if (!reasonRaw) {
      pushSkip(r, code, '', 'السبب مطلوب');
      continue;
    }

    const isWorking = reasonRaw.trim() === WORKING_REASON;
    const matchedReason = isWorking
      ? WORKING_REASON
      : reasonByLower.get(reasonRaw.trim().toLowerCase());

    if (!matchedReason) {
      pushSkip(r, code, '', `سبب غير معروف: ${reasonRaw}`, { reason: reasonRaw });
      continue;
    }

    let parsedDate: { iso: string; date: Date } | null = null;
    if (!isWorking) {
      parsedDate = parseDateCell(dateRaw);
      if (!parsedDate) {
        pushSkip(r, code, '', 'التاريخ مطلوب وصحيح عند الأرشفة', {
          reason: matchedReason,
        });
        continue;
      }
    }

    const matches = await prisma.employeeProfile.findMany({
      where: codeWhere(code),
      select: {
        id: true,
        name: true,
        code: true,
        active: true,
        locationId: true,
        archivedAt: true,
        archiveReason: true,
      },
    });

    if (!matches.length) {
      pushSkip(r, code, '', 'الكود غير موجود', {
        reason: matchedReason,
        date: parsedDate?.iso,
      });
      continue;
    }

    if (matches.length > 1) {
      const active = matches.filter((m) => m.active);
      const archivedMatches = matches.filter((m) => !m.active);
      if (isWorking) {
        if (archivedMatches.length === 1 && active.length === 0) {
          // ok — single archived
        } else if (archivedMatches.length === 0) {
          pushSkip(r, code, active[0]?.name || '', 'الموظف مش مؤرشف', {
            reason: matchedReason,
          });
          continue;
        } else {
          pushSkip(
            r,
            code,
            archivedMatches.map((a) => a.name || a.id).join('، '),
            'أكثر من موظف بنفس الكود — عالجه من صفحة الموظف',
            { reason: matchedReason },
          );
          continue;
        }
      } else if (active.length === 1 && archivedMatches.length === 0) {
        // archive the single active
      } else if (archivedMatches.length === 1 && active.length === 0) {
        // update the single archived
      } else if (active.length === 1) {
        // Prefer active when archiving; ignore archived duplicates holding same code
      } else {
        pushSkip(
          r,
          code,
          matches.map((m) => m.name || m.id).join('، '),
          'أكثر من موظف بنفس الكود — عالجه من صفحة الموظف',
          { reason: matchedReason, date: parsedDate?.iso },
        );
        continue;
      }
    }

    const target = isWorking
      ? matches.find((m) => !m.active) ?? matches[0]
      : matches.find((m) => m.active) ?? matches.find((m) => !m.active) ?? matches[0];

    if (hrScopeLocationId && target.locationId !== hrScopeLocationId) {
      pushSkip(r, code, target.name || '', 'الموظف خارج نطاق فرعك', {
        reason: matchedReason,
        date: parsedDate?.iso,
      });
      continue;
    }

    try {
      if (isWorking) {
        if (target.active) {
          pushSkip(r, code, target.name || '', 'الموظف مش مؤرشف', {
            reason: matchedReason,
          });
          continue;
        }
        await restoreEmployee(target.id);
        await syncEmployeeLoginFromWorkEmail(target.id);
        restored++;
        details.push({
          rowNumber: r,
          code: target.code || code,
          name: target.name || '',
          action: 'restored',
          detail: 'تم إلغاء الأرشفة (يعمل)',
          reason: WORKING_REASON,
        });
        continue;
      }

      const wasArchived = !target.active;
      await archiveEmployee(
        target.id,
        matchedReason,
        actor ?? undefined,
        parsedDate!.date,
      );
      if (wasArchived) {
        archiveUpdated++;
        details.push({
          rowNumber: r,
          code: target.code || code,
          name: target.name || '',
          action: 'archive_updated',
          detail: `تم تحديث الأرشفة → ${matchedReason} بتاريخ ${parsedDate!.iso}`,
          reason: matchedReason,
          date: parsedDate!.iso,
        });
      } else {
        archived++;
        details.push({
          rowNumber: r,
          code: target.code || code,
          name: target.name || '',
          action: 'archived',
          detail: `تم الأرشفة → ${matchedReason} بتاريخ ${parsedDate!.iso}`,
          reason: matchedReason,
          date: parsedDate!.iso,
        });
      }
    } catch (e) {
      pushSkip(r, code, target.name || '', e instanceof Error ? e.message : 'فشلت العملية', {
        reason: matchedReason,
        date: parsedDate?.iso,
      });
    }
  }

  if (!details.length) {
    throw new AppError('لا توجد صفوف للمعالجة في الملف', 400, 'VALIDATION');
  }

  return {
    details,
    archived,
    archiveUpdated,
    restored,
    skipped,
    message: `أرشفة ${archived} — تحديث ${archiveUpdated} — إلغاء أرشفة ${restored} — تخطي ${skipped}`,
  };
}
