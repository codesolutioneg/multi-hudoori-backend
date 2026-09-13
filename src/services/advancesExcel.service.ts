import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { AdvanceState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { NotFoundError, AppError } from '../utils/errors';
import { computeLongAdvanceAmounts } from './advances.service';
import { tipsWorkingDaysByEmployeeIds } from './punchReportLine.service';
import { calendarPeriodDays } from './payablePeriod.service';

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

function safeLocationToken(value: string): string {
  return value
    .replace(/[^\w\u0600-\u06FF-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

function shortStateAr(state: AdvanceState | string): string {
  switch (state) {
    case 'pending':
    case 'confirmed':
      return 'معلّقة';
    case 'applied':
    case 'paid':
      return 'مطبّق';
    case 'cancelled':
      return 'ملغاة';
    default:
      return String(state);
  }
}

function longStateAr(state: AdvanceState | string): string {
  switch (state) {
    case 'draft':
      return 'مسودة';
    case 'running':
      return 'نشطة';
    case 'done':
      return 'مسددة';
    case 'cancelled':
      return 'ملغاة';
    default:
      return String(state);
  }
}

function styleHeaderRow(sheet: ExcelJS.Worksheet, colCount: number) {
  const row = sheet.getRow(1);
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.font = { bold: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8EEF7' },
    };
  }
  row.commit();
}

const LOAN_IMPORT_HEADERS_AR = [
  'كود الموظف',
  'اسم الموظف',
  'القسم',
  'الوظيفة',
  'تاريخ التعيين',
  'مبلغ السلفة',
] as const;
const LOAN_IMPORT_HEADERS_EN = [
  'employee_code',
  'employee_name',
  'department',
  'job_title',
  'hiring_date',
  'amount',
] as const;

const TIP_IMPORT_HEADERS_AR = [
  'كود الموظف',
  'اسم الموظف',
  'القسم',
  'الوظيفة',
  'تاريخ التعيين',
  'أيام العمل',
  'Commission',
] as const;
const TIP_IMPORT_HEADERS_EN = [
  'employee_code',
  'employee_name',
  'department',
  'job_title',
  'hiring_date',
  'actual_working_days',
  'Commission',
] as const;

export type ImportTemplateKind = 'loan' | 'tip';

export function importTemplateSpec(kind: ImportTemplateKind) {
  if (kind === 'tip') {
    return {
      kind,
      sheetName: 'استيراد Commission',
      headersAr: TIP_IMPORT_HEADERS_AR,
      headersEn: TIP_IMPORT_HEADERS_EN,
      colCount: TIP_IMPORT_HEADERS_AR.length,
      amountCol: 7,
      daysCol: 6,
      colWidths: [16, 28, 18, 18, 14, 14, 14],
    };
  }
  return {
    kind,
    sheetName: 'استيراد سلف',
    headersAr: LOAN_IMPORT_HEADERS_AR,
    headersEn: LOAN_IMPORT_HEADERS_EN,
    colCount: LOAN_IMPORT_HEADERS_AR.length,
    amountCol: 6,
    daysCol: null as number | null,
    colWidths: [16, 28, 18, 18, 14, 14],
  };
}

type ImportTemplateEmployee = {
  id?: string;
  code: string;
  name: string;
  department: string;
  jobTitle: string;
  hiringDate: string;
  workingDays?: number;
};

const BLANK_IMPORT_ROWS = 50;
export const TIP_EXTRA_UNLOCKED_ROWS = 25;

/** Import template for a branch (location) — employees prefilled; fill amount to import. */
export async function exportAdvancesImportTemplateXlsx(options?: {
  locationId?: string | null;
  /** When true, empty branch returns null instead of throwing (used by bulk ZIP). */
  allowEmpty?: boolean;
  /** Empty workbook to fill by hand; filename is always multiple.xlsx */
  blank?: boolean;
  jobTitleNames?: string[];
  filenamePrefix?: string;
  kind?: ImportTemplateKind;
  dateFrom?: Date | string | null;
  dateTo?: Date | string | null;
}): Promise<{
  base64: string;
  filename: string;
  count: number;
  locationName: string;
} | null> {
  const blank = options?.blank === true;
  const kind: ImportTemplateKind =
    options?.kind === 'tip' || options?.filenamePrefix === 'tips_import'
      ? 'tip'
      : 'loan';
  const spec = importTemplateSpec(kind);
  const locationId = blank ? null : options?.locationId?.trim() || null;
  const allowEmpty = options?.allowEmpty === true;
  let locationName = 'all';
  let locationLabel = 'all';

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(spec.sheetName);
  sheet.views = [{ rightToLeft: true }];

  spec.headersAr.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = `${spec.headersEn[i]} / ${h}`;
  });
  styleHeaderRow(sheet, spec.colCount);
  spec.colWidths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  let employees: ImportTemplateEmployee[] = [];

  if (locationId) {
    const loc = await prisma.location.findUnique({ where: { id: locationId } });
    if (!loc) {
      throw new NotFoundError('Location not found');
    }
    locationLabel = loc.name || loc.id;
    locationName = safeLocationToken(locationLabel) || 'branch';
    const rows = await prisma.employeeProfile.findMany({
      where: {
        ...(kind === 'tip' ? {} : { active: true }),
        locationId,
        OR: [
          { code: { not: null } },
          { identificationId: { not: null } },
        ],
      },
      select: {
        id: true,
        code: true,
        identificationId: true,
        name: true,
        hiringDate: true,
        jobTitle: true,
        department: { select: { name: true } },
      },
      orderBy: [{ code: 'asc' }, { name: 'asc' }],
    });
    employees = rows
      .map((e) => ({
        id: e.id,
        code: (e.code || e.identificationId || '').trim(),
        name: (e.name || '').trim(),
        department: (e.department?.name || '').trim(),
        jobTitle: (e.jobTitle || '').trim(),
        hiringDate: e.hiringDate ? e.hiringDate.toISOString().slice(0, 10) : '',
      }))
      .filter((e) => e.code);

    const jobTitles = (options?.jobTitleNames ?? [])
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    if (jobTitles.length) {
      employees = employees.filter((e) =>
        jobTitles.includes(e.jobTitle.trim().toLowerCase()),
      );
    }

    if (employees.length === 0) {
      if (!(kind === 'tip' && allowEmpty)) {
        if (allowEmpty) return null;
        const tipHint =
          kind === 'tip' && jobTitles.length
            ? ' — تأكد من وظائف Commission في الإعدادات'
            : '';
        throw new AppError(
          `لا يوجد موظفين مرتبطين بالفرع «${loc.name}»${tipHint}`,
          400,
          'VALIDATION_ERROR',
        );
      }
    }

    if (kind === 'tip' && employees.length > 0) {
      const rawFrom = options?.dateFrom;
      const rawTo = options?.dateTo;
      if (!rawFrom || !rawTo) {
        throw new AppError(
          'حدد فترة أيام العمل من وإلى قبل تنزيل القالب',
          400,
          'VALIDATION_ERROR',
        );
      }
      const dateFrom = new Date(`${String(rawFrom).slice(0, 10)}T00:00:00.000Z`);
      const dateTo = new Date(`${String(rawTo).slice(0, 10)}T00:00:00.000Z`);
      if (Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime())) {
        throw new AppError('فترة أيام العمل غير صالحة', 400, 'VALIDATION_ERROR');
      }
      const span = calendarPeriodDays(dateFrom, dateTo);
      const daysById = await tipsWorkingDaysByEmployeeIds(
        employees.map((e) => e.id!).filter(Boolean),
        {
          dateFrom,
          dateTo,
          includeInactive: true,
        },
      );
      employees = employees
        .map((e) => ({
          ...e,
          workingDays: Math.min(e.id ? daysById.get(e.id) ?? 0 : 0, span),
        }))
        .filter((e) => (e.workingDays ?? 0) > 0);
      // Empty branch still gets a file (headers + extra rows) when exporting many locations.
    }
  }

  employees.forEach((e, idx) => {
    const r = idx + 2;
    sheet.getCell(r, 1).value = e.code;
    sheet.getCell(r, 2).value = e.name;
    sheet.getCell(r, 3).value = e.department;
    sheet.getCell(r, 4).value = e.jobTitle;
    sheet.getCell(r, 5).value = e.hiringDate;
    if (spec.daysCol) {
      sheet.getCell(r, spec.daysCol).value = e.workingDays ?? 0;
    }
    sheet.getCell(r, spec.amountCol).value = '';
    for (let c = 1; c <= spec.colCount; c++) {
      sheet.getCell(r, c).protection = { locked: c !== spec.amountCol };
    }
  });

  if (kind === 'tip') {
    const extraStart = employees.length + 2;
    const extraEnd = extraStart + TIP_EXTRA_UNLOCKED_ROWS - 1;
    for (let r = extraStart; r <= extraEnd; r++) {
      for (let c = 1; c <= spec.colCount; c++) {
        sheet.getCell(r, c).value = '';
        sheet.getCell(r, c).protection = {
          locked: c !== 1 && c !== spec.amountCol,
        };
      }
    }
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: extraEnd, column: spec.colCount },
    };
  }

  // Blank / mixed-branch template: unlocked rows so HR can type codes and amounts.
  if (blank || !locationId) {
    const lastBlank = BLANK_IMPORT_ROWS + 1;
    for (let r = 2; r <= lastBlank; r++) {
      for (let c = 1; c <= spec.colCount; c++) {
        sheet.getCell(r, c).value = '';
        sheet.getCell(r, c).protection = { locked: false };
      }
    }
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: lastBlank, column: spec.colCount },
    };
    sheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
  }

  if (employees.length > 0 || kind === 'tip') {
    const lastRow =
      kind === 'tip'
        ? Math.max(employees.length, 0) + 1 + TIP_EXTRA_UNLOCKED_ROWS
        : employees.length + 1;
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: lastRow, column: spec.colCount },
    };
    sheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
    await sheet.protect('', {
      selectLockedCells: true,
      selectUnlockedCells: true,
      insertRows: false,
      deleteRows: false,
      autoFilter: true,
      sort: true,
    });
  }

  const help = workbook.addWorksheet('تعليمات');
  help.views = [{ rightToLeft: true }];
  help.getColumn(1).width = 78;
  const helpLines = blank
    ? kind === 'tip'
      ? [
          'تعليمات القالب الفارغ (multiple) — Commission',
          '',
          '1) اكتب كود الموظف ومبلغ Commission (عمود Commission) في الصفوف الفارغة.',
          '2) يجب أن يكون الموظف موجودًا في النظام بالكود نفسه — القالب لا يُنشئ موظفين جددًا.',
          '3) الصفوف ذات المبلغ الفارغ أو الصفر لن تُنشأ عند الاستيراد.',
          '4) بعد التعبئة: استيراد Commission ← رفع الملف multiple.xlsx ← معاينة/اعتماد.',
        ]
      : [
          'تعليمات القالب الفارغ (multiple)',
          '',
          '1) اكتب كود الموظف ومبلغ السلفة في الصفوف الفاضية. الاسم والقسم والوظيفة اختياري.',
          '2) يجب أن يكون الموظف موجودًا في النظام بالكود نفسه — القالب لا يُنشئ موظفين جددًا.',
          '3) الصفوف ذات المبلغ الفارغ أو الصفر لن تُنشأ عند الاستيراد.',
          '4) بعد التعبئة: استيراد من شيت → رفع الملف multiple.xlsx → معاينة/اعتماد.',
        ]
    : kind === 'tip'
      ? [
          'تعليمات قالب استيراد Commission',
          '',
          ...(options?.dateFrom && options?.dateTo
            ? [
                `فترة أيام العمل في هذا القالب: ${String(options.dateFrom).slice(0, 10)} → ${String(options.dateTo).slice(0, 10)}`,
                'عمود «أيام العمل» = أيام بصم/شيفت فعلية ضمن هذه الفترة فقط (حاضر، بصمة، إلخ).',
                '',
              ]
            : []),
          '1) املأ عمود «Commission» فقط للموظفين الذين سيحصلون على Commission.',
          '2) عمود «أيام العمل» = أيام البصم أو «حاضر» ضمن الفترة المحددة فقط (بدون تثبيت 30 يومًا لشهر الرواتب). لا تعدّله. والموظفون بأيام عمل صفر لا يُكتبون في الشيت.',
          '3) يمكنك إضافة صف جديد أسفل القائمة: اكتب كود الموظف (حتى لو مؤرشف) ومبلغ Commission.',
          '4) الصفوف ذات المبلغ الفارغ أو الصفر لن تُنشأ عند الاستيراد.',
          '5) بعد الرفع النظام بيحسب كاش/فوري من حساب فوري المسجّل وقت الاستيراد.',
        ]
      : [
          'تعليمات قالب استيراد السلف',
          '',
          '1) املأ عمود «مبلغ السلفة» فقط للموظفين الذين سيحصلون على سلفة.',
          '2) الصفوف ذات المبلغ الفارغ أو الصفر لن تُنشأ عند الاستيراد.',
          '3) متضيفش موظفين جدد برة الفرع المحدد — الكود والاسم والقسم والوظيفة وتاريخ التعيين مقفولين.',
          '4) بعد التعبئة: استيراد من شيت → رفع الملف → معاينة/اعتماد.',
        ];
  helpLines.forEach((t, i) => {
    help.getCell(i + 1, 1).value = t;
    if (i === 0) help.getCell(i + 1, 1).font = { bold: true, size: 13 };
  });

  const base64 = await workbookToBase64(workbook);
  const day = new Date().toISOString().slice(0, 10);
  const prefix =
    options?.filenamePrefix || (kind === 'tip' ? 'tips_import' : 'advances_import');
  const filename = blank
    ? 'multiple.xlsx'
    : locationId
      ? `${prefix}_${locationName}_${day}.xlsx`
      : `${prefix}_template_${day}.xlsx`;
  return {
    base64,
    filename,
    count: employees.length,
    locationName: blank ? 'multiple' : locationLabel,
  };
}

export type AdvancesImportTemplatesExport = {
  base64: string;
  filename: string;
  mimeType: string;
  count: number;
  fileCount: number;
  skipped: Array<{ locationId: string; name: string; reason: string }>;
};

/**
 * One Excel per selected branch. Single branch → .xlsx; multiple → ZIP of .xlsx files.
 */
export async function exportAdvancesImportTemplatesForLocations(
  locationIds: string[],
  options?: {
    jobTitleNames?: string[];
    filenamePrefix?: string;
    kind?: ImportTemplateKind;
    dateFrom?: Date | string | null;
    dateTo?: Date | string | null;
  },
): Promise<AdvancesImportTemplatesExport> {
  const ids = [...new Set(locationIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) {
    throw new AppError('اختر فرع واحد على الأقل', 400, 'VALIDATION_ERROR');
  }

  const day = new Date().toISOString().slice(0, 10);
  const skipped: AdvancesImportTemplatesExport['skipped'] = [];
  const files: Array<{ filename: string; base64: string; count: number }> = [];

  for (const locationId of ids) {
    const loc = await prisma.location.findUnique({ where: { id: locationId } });
    if (!loc) {
      skipped.push({ locationId, name: locationId, reason: 'الفرع غير موجود' });
      continue;
    }
    const allowEmpty = ids.length > 1 || options?.kind === 'tip';
    try {
      const result = await exportAdvancesImportTemplateXlsx({
        locationId,
        allowEmpty,
        jobTitleNames: options?.jobTitleNames,
        filenamePrefix: options?.filenamePrefix,
        kind: options?.kind,
        dateFrom: options?.dateFrom,
        dateTo: options?.dateTo,
      });
      if (!result) {
        skipped.push({
          locationId,
          name: loc.name || locationId,
          reason:
            options?.kind === 'tip'
              ? 'لا يوجد موظفين بأيام عمل أكبر من صفر'
              : 'لا يوجد موظفين نشطين',
        });
        continue;
      }
      files.push({
        filename: result.filename,
        base64: result.base64,
        count: result.count,
      });
    } catch (e) {
      if (e instanceof AppError && e.errorCode === 'VALIDATION_ERROR' && ids.length === 1) {
        throw e;
      }
      skipped.push({
        locationId,
        name: loc.name || locationId,
        reason: e instanceof Error ? e.message : 'فشل التصدير',
      });
    }
  }

  if (!files.length) {
    throw new AppError(
      'لا يوجد موظفين نشطين في الفروع المختارة',
      400,
      'VALIDATION_ERROR',
    );
  }

  const totalCount = files.reduce((sum, f) => sum + f.count, 0);

  if (files.length === 1) {
    return {
      base64: files[0].base64,
      filename: files[0].filename,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      count: totalCount,
      fileCount: 1,
      skipped,
    };
  }

  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.filename, Buffer.from(f.base64, 'base64'));
  }
  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return {
    base64: zipBuffer.toString('base64'),
    filename: `advances_import_templates_${day}.zip`,
    mimeType: 'application/zip',
    count: totalCount,
    fileCount: files.length,
    skipped,
  };
}

/**
 * Empty eligibility sheet for loan-import compare
 * (columns match buildEligibilityMapsFromFile aliases).
 */
export async function exportAdvancesEligibilityTemplateXlsx(): Promise<{
  base64: string;
  filename: string;
}> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('الاستحقاق');
  sheet.views = [{ rightToLeft: true }];

  const headers = ['كود الموظف', 'اسم الموظف', 'الاستحقاق', 'أيام العمل', 'الحالة'];
  headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h;
  });
  styleHeaderRow(sheet, headers.length);
  [16, 28, 14, 12, 16].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });
  for (let r = 2; r <= 6; r++) {
    for (let c = 1; c <= headers.length; c++) {
      sheet.getCell(r, c).value = '';
    }
  }

  const base64 = await workbookToBase64(workbook);
  return { base64, filename: 'advances_eligibility_template.xlsx' };
}

export async function exportShortAdvancesXlsx(): Promise<{
  base64: string;
  filename: string;
}> {
  const items = await prisma.advanceShort.findMany({
    include: { employee: { include: { department: true } } },
    orderBy: { date: 'desc' },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('السلف القصيرة');
  sheet.views = [{ rightToLeft: true }];

  const headers = [
    'كود الموظف',
    'اسم الموظف',
    'القسم',
    'الوظيفة',
    'المبلغ',
    'الحالة',
    'تاريخ السلفة',
    'بداية الخصم',
    'مخصومة',
    'ملاحظات',
  ];
  headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h;
  });
  styleHeaderRow(sheet, headers.length);

  items.forEach((a, idx) => {
    const r = idx + 2;
    sheet.getCell(r, 1).value = a.employee?.code ?? '';
    sheet.getCell(r, 2).value = a.employee?.name ?? '';
    sheet.getCell(r, 3).value = a.employee?.department?.name ?? '';
    sheet.getCell(r, 4).value = a.employee?.jobTitle ?? '';
    sheet.getCell(r, 5).value = a.amount;
    sheet.getCell(r, 6).value = shortStateAr(a.state);
    sheet.getCell(r, 7).value = a.date.toISOString().slice(0, 10);
    sheet.getCell(r, 8).value = (a.deductionStartDate ?? a.date).toISOString().slice(0, 10);
    sheet.getCell(r, 9).value = a.isDeducted ? 'نعم' : 'لا';
    sheet.getCell(r, 10).value = a.notes ?? '';
  });

  [16, 28, 18, 18, 12, 12, 14, 14, 10, 30].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  const base64 = await workbookToBase64(workbook);
  const day = new Date().toISOString().slice(0, 10);
  return { base64, filename: `advances_short_${day}.xlsx` };
}

export async function exportLongAdvancesXlsx(): Promise<{
  base64: string;
  filename: string;
}> {
  const items = await prisma.advanceLong.findMany({
    include: { employee: { include: { department: true } }, payments: true },
    orderBy: { date: 'desc' },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('السلف الطويلة');
  sheet.views = [{ rightToLeft: true }];

  const headers = [
    'كود الموظف',
    'اسم الموظف',
    'القسم',
    'الوظيفة',
    'المبلغ الإجمالي',
    'القسط',
    'عدد الأقساط',
    'المدفوع',
    'المتبقي',
    'أقساط مسددة',
    'أقساط متبقية',
    'الحالة',
    'تاريخ السلفة',
    'بداية الخصم',
    'الخصم التالي',
    'ملاحظات',
  ];
  headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h;
  });
  styleHeaderRow(sheet, headers.length);

  items.forEach((a, idx) => {
    const amounts = computeLongAdvanceAmounts({
      ...a,
      payments: a.payments ?? [],
    });
    const r = idx + 2;
    sheet.getCell(r, 1).value = a.employee?.code ?? '';
    sheet.getCell(r, 2).value = a.employee?.name ?? '';
    sheet.getCell(r, 3).value = a.employee?.department?.name ?? '';
    sheet.getCell(r, 4).value = a.employee?.jobTitle ?? '';
    sheet.getCell(r, 5).value = a.totalAmount;
    sheet.getCell(r, 6).value = amounts.installmentAmount;
    sheet.getCell(r, 7).value = a.installments;
    sheet.getCell(r, 8).value = amounts.paidAmount;
    sheet.getCell(r, 9).value = amounts.remainingAmount;
    sheet.getCell(r, 10).value = amounts.paidInstallments;
    sheet.getCell(r, 11).value = amounts.remainingInstallments;
    sheet.getCell(r, 12).value = longStateAr(a.state);
    sheet.getCell(r, 13).value = a.date.toISOString().slice(0, 10);
    sheet.getCell(r, 14).value = (a.startDate ?? a.date).toISOString().slice(0, 10);
    sheet.getCell(r, 15).value = a.nextDeductionDate
      ? a.nextDeductionDate.toISOString().slice(0, 10)
      : '';
    sheet.getCell(r, 16).value = a.notes ?? '';
  });

  [16, 28, 18, 18, 14, 12, 12, 12, 12, 12, 12, 12, 14, 14, 14, 30].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  const base64 = await workbookToBase64(workbook);
  const day = new Date().toISOString().slice(0, 10);
  return { base64, filename: `advances_long_${day}.xlsx` };
}
