import ExcelJS from 'exceljs';
import { AdvanceLoanImportState, AdvanceState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { computeAdvanceEligibility } from './advanceEligibility.service';
import { createShortAdvance } from './advances.service';
import { resolveEmployeeByCode } from './deductionExcel.service';
import { nextAdvanceLoanImportReference, nextTipImportReference } from './deductionReference.service';
import { formatLocationDisplay } from './serialize.service';
import { payrollMonthRange } from './shiftGridMerge.service';
import {
  calculateLoanPaymentAmounts,
  employeeIsFawry,
  accountsExportLocationToken,
} from './odoo/odooLoanAccounts.service';
import { tipsWorkingDaysByEmployeeIds, punchFollowUpPeriod } from './punchReportLine.service';

/**
 * Period the loan-import eligibility is measured over. When a source grid is
 * chosen we honour it; otherwise we count the running payroll cycle (from its
 * start day up to today), not a single week — so the working-days gate reflects
 * the days actually elapsed this month.
 */
async function eligibilityPeriodForBatch(batch: {
  sourceGridId: string | null;
  date: Date;
}): Promise<{ shiftGridId?: string | null; dateFrom?: Date; dateTo?: Date }> {
  if (batch.sourceGridId) return { shiftGridId: batch.sourceGridId };
  const config = await prisma.bioTimeConfig.findFirst({
    select: { payrollMonthStartDay: true },
  });
  const monthStartDay = config?.payrollMonthStartDay ?? 26;
  const { dateFrom, dateTo } = payrollMonthRange(batch.date, monthStartDay);
  const today = parseDay(new Date());
  const cappedTo = today.getTime() < dateTo.getTime() ? today : dateTo;
  return { dateFrom, dateTo: cappedTo };
}

function parseDay(raw?: string | Date): Date {
  if (raw instanceof Date)
    return new Date(`${raw.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (raw && String(raw).trim()) {
    const d = new Date(String(raw).slice(0, 10));
    if (!Number.isNaN(d.getTime()))
      return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
  }
  const now = new Date();
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function safeFilenameToken(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'unknown_location'
  );
}

function locationFilenameToken(names: Iterable<string>): string {
  return accountsExportLocationToken(names);
}

async function locationNamesForIds(
  ids: Iterable<string | null | undefined>,
): Promise<string[]> {
  const locationIds = [
    ...new Set([...ids].filter((id): id is string => Boolean(id))),
  ];
  if (!locationIds.length) return [];
  const locations = await prisma.location.findMany({
    where: { id: { in: locationIds } },
    select: { name: true },
  });
  return locations.map((location) => location.name);
}

function firstOfNextMonth(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
}

function normalizeHeader(v: unknown): string {
  return cellToText(v).toLowerCase().replace(/\s+/g, ' ');
}

function cellToText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && v !== null && 'text' in v) {
    return String((v as { text?: unknown }).text ?? '').trim();
  }
  if (typeof v === 'object' && v !== null && 'result' in v) {
    return cellToText((v as { result?: unknown }).result);
  }
  if (typeof v === 'object' && v !== null && 'richText' in v) {
    const parts = (v as { richText?: Array<{ text?: string }> }).richText ?? [];
    return parts
      .map((p) => p.text ?? '')
      .join('')
      .trim();
  }
  return String(v).trim();
}

export const LOAN_FILE_AMOUNT_ALIASES = [
  'amount',
  'requested_amount',
  'requested amount',
  'loan amount',
  'tips',
  'tip',
  'قيمة السلفة',
  'المبلغ',
  'مبلغ السلفة',
  'تيبس',
  'tips / تيبس',
  'commission',
  'Commission',
];

export const LOAN_FILE_DAYS_ALIASES = [
  'actual_working_days',
  'actual working days',
  'working days',
  'أيام العمل',
];

function headerIndex(
  header: string[],
  aliases: string[],
  required = false,
  label = '',
): number {
  for (const a of aliases) {
    const needle = a.toLowerCase();
    const exact = header.indexOf(needle);
    if (exact >= 0) return exact;
  }
  for (const a of aliases) {
    const needle = a.toLowerCase();
    const soft = header.findIndex(
      (h) => h === needle || h.includes(needle) || needle.includes(h),
    );
    if (soft >= 0) return soft;
  }
  if (required)
    throw new AppError(
      `العمود "${label || aliases[0]}" غير موجود`,
      400,
      'IMPORT_ERROR',
    );
  return -1;
}

export function findImportHeaderColumn(
  headers: string[],
  aliases: string[],
): number {
  return headerIndex(headers.map(normalizeHeader), aliases, false);
}

export function excelCellHasValue(cell: unknown): boolean {
  if (cell == null) return false;
  return String(cell).trim() !== '';
}

function parseFloatCell(v: unknown, fallback = 0): number {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeLoanEmployeeCode(value: unknown): string {
  const txt = cellToText(value);
  if (txt.endsWith('.0') && /^\d+$/.test(txt.slice(0, -2)))
    return txt.slice(0, -2);
  return txt;
}

function sheetRowsFromWorksheet(sheet: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = [];
  sheet.eachRow((row) => {
    const vals: unknown[] = [];
    const values = row.values as unknown[];
    const max = Math.max(values?.length ?? 0, row.cellCount + 1);
    for (let c = 1; c < max; c++) {
      vals.push(row.getCell(c).value);
    }
    rows.push(vals);
  });
  return rows;
}

function rowLooksLikeLoanHeader(row: unknown[]): boolean {
  const header = row.map(normalizeHeader);
  return header.some(
    (h) =>
      h === 'employee_code' ||
      h === 'كود الموظف' ||
      h === 'كود' ||
      h === 'code' ||
      h.includes('كود الموظف') ||
      h.includes('employee_code'),
  );
}

/** Prefer data sheet over «تعليمات» — Excel sometimes reorders tabs after save. */
async function loadLoanImportSheetRows(base64: string): Promise<unknown[][]> {
  const raw = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(raw as unknown as ExcelJS.Buffer);
  if (!workbook.worksheets.length)
    throw new AppError('الملف فارغ', 400, 'IMPORT_ERROR');

  const preferred =
    workbook.worksheets.find(
      (ws) =>
        /استيراد|سلف|loan|advance|تيبس|tips|commission/i.test(ws.name) &&
        !/تعليمات|instruction/i.test(ws.name),
    ) ??
    workbook.worksheets.find((ws) => {
      const rows = sheetRowsFromWorksheet(ws);
      return rows.slice(0, 8).some((r) => rowLooksLikeLoanHeader(r));
    }) ??
    workbook.worksheets.find((ws) => !/تعليمات|instruction/i.test(ws.name)) ??
    workbook.worksheets[0];

  if (!preferred) throw new AppError('الملف فارغ', 400, 'IMPORT_ERROR');
  return sheetRowsFromWorksheet(preferred);
}

type EligibilityMap = Map<
  string,
  {
    eligibleAmount: number;
    eligibleProvided: boolean;
    approvedAmount: number | null;
    actualWorkingDays: number;
    statusText: string;
  }
>;

async function loadEligibilitySheetRows(base64: string): Promise<unknown[][]> {
  const raw = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(raw as unknown as ExcelJS.Buffer);

  const preferred =
    workbook.worksheets.find((ws) => /استحقاق|eligibility/i.test(ws.name)) ??
    workbook.worksheets.find((ws) => {
      const row1 = ws.getRow(1);
      const headers: string[] = [];
      row1.eachCell({ includeEmpty: false }, (cell) => {
        headers.push(normalizeHeader(cell.value));
      });
      return headers.some(
        (h) => h === 'كود الموظف' || h === 'employee_code' || h === 'code',
      );
    }) ??
    workbook.worksheets[0];

  if (!preferred) throw new AppError('الملف فارغ', 400, 'IMPORT_ERROR');

  const rows: unknown[][] = [];
  preferred.eachRow((row) => {
    rows.push(row.values ? (row.values as unknown[]).slice(1) : []);
  });
  return rows;
}

async function buildEligibilityMapsFromFile(
  base64: string,
): Promise<EligibilityMap> {
  const rows = await loadEligibilitySheetRows(base64);
  const map: EligibilityMap = new Map();

  let headerIdx = -1;
  let header: string[] = [];
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const row = rows[i];
    if (!row) continue;
    const h = row.map(normalizeHeader);
    if (
      h.includes('employee_code') ||
      h.includes('code') ||
      h.includes('كود الموظف')
    ) {
      headerIdx = i;
      header = h;
      break;
    }
  }
  if (headerIdx < 0) return map;

  const codeCol = headerIndex(
    header,
    ['employee_code', 'code', 'كود الموظف'],
    true,
    'employee_code',
  );
  const eligibleCol = headerIndex(
    header,
    ['eligible_amount', 'eligible amount', 'استحقاقه', 'الاستحقاق', 'المستحق'],
    false,
  );
  const approvedCol = headerIndex(
    header,
    ['approved_amount', 'approved amount', 'المبلغ المعتمد', 'معتمد'],
    false,
  );
  const daysCol = headerIndex(
    header,
    ['actual_working_days', 'actual working days', 'أيام العمل'],
    false,
  );
  const statusCol = headerIndex(
    header,
    ['status', 'eligibility status', 'الحالة'],
    false,
  );
  const requestedCol = headerIndex(
    header,
    ['amount', 'requested_amount', 'مبلغ السلفة', 'المبلغ', 'مبلغ السلفة'],
    false,
  );

  for (const row of rows.slice(headerIdx + 1)) {
    if (!row) continue;
    const code = String(row[codeCol] ?? '')
      .trim()
      .replace(/\.0$/, '');
    if (!code) continue;

    let eligibleAmount =
      eligibleCol >= 0 ? parseFloatCell(row[eligibleCol], 0) : 0;
    const statusText =
      statusCol >= 0 ? String(row[statusCol] ?? '').trim() : '';
    const parsedStatus = parseEligibilityStatus(statusText);
    const requestedInSheet =
      requestedCol >= 0 ? parseFloatCell(row[requestedCol], 0) : 0;

    // مستحق + استحقاق فارغ/صفر → استخدم مبلغ السلفة من الشيت
    if (
      parsedStatus === 'ready' &&
      eligibleAmount <= 0 &&
      requestedInSheet > 0
    ) {
      eligibleAmount = requestedInSheet;
    }

    map.set(code, {
      eligibleAmount,
      eligibleProvided: eligibleCol >= 0,
      approvedAmount:
        approvedCol >= 0 ? parseFloatCell(row[approvedCol], 0) : null,
      actualWorkingDays: daysCol >= 0 ? parseFloatCell(row[daysCol], 0) : 0,
      statusText,
    });
  }
  return map;
}

function findHeaderRow(rows: unknown[][]): {
  headerIdx: number;
  header: string[];
} {
  for (let idx = 0; idx < Math.min(rows.length, 12); idx++) {
    const row = rows[idx];
    if (!row) continue;
    if (!rowLooksLikeLoanHeader(row)) continue;
    return { headerIdx: idx, header: row.map(normalizeHeader) };
  }
  throw new AppError(
    'لم يتم العثور على صف العناوين — يجب أن يوجد عمود «كود الموظف» أو employee_code (شيت استيراد سلف وليس التعليمات)',
    400,
    'IMPORT_ERROR',
  );
}

export function advanceLoanImportJson(batch: {
  id: string;
  reference: string;
  deviceId: string | null;
  sourceGridId: string | null;
  date: Date;
  state: AdvanceLoanImportState;
  defaultRepaymentMonths: number;
  defaultReason: string | null;
  createdAt: Date;
  kind?: string | null;
  cashAmount?: number | null;
  fawryAmount?: number | null;
  totalAmount?: number | null;
  odooAccountsSendId?: number | null;
  odooMoveId?: number | null;
  odooSendRef?: string | null;
  notificationEmailsSentAt?: Date | null;
  notificationEmailError?: string | null;
  notificationEmailRecipients?: string[];
  lines?: ReturnType<typeof advanceLoanImportLineJson>[];
}) {
  return {
    id: batch.id,
    reference: batch.reference,
    deviceId: batch.deviceId,
    sourceGridId: batch.sourceGridId,
    date: batch.date.toISOString().slice(0, 10),
    state: batch.state,
    defaultRepaymentMonths: batch.defaultRepaymentMonths,
    defaultReason: batch.defaultReason ?? '',
    kind: batch.kind ?? 'loan',
    cashAmount: batch.cashAmount ?? null,
    fawryAmount: batch.fawryAmount ?? null,
    totalAmount: batch.totalAmount ?? null,
    createdAt: batch.createdAt.toISOString(),
    odooAccountsSendId: batch.odooAccountsSendId ?? null,
    odooMoveId: batch.odooMoveId ?? null,
    odooSendRef: batch.odooSendRef ?? '',
    notificationEmailsSentAt:
      batch.notificationEmailsSentAt?.toISOString() ?? null,
    notificationEmailError: batch.notificationEmailError ?? '',
    notificationEmailRecipients: batch.notificationEmailRecipients ?? [],
    lines: batch.lines ?? [],
    lineCount: batch.lines?.length ?? 0,
  };
}

export function advanceLoanImportLineJson(line: {
  id: string;
  importId: string;
  employeeId: string | null;
  employeeCode: string | null;
  employeeName: string | null;
  requestedAmount: number;
  eligibleAmount: number;
  systemEligibleAmount: number | null;
  eligibilityOverridden: boolean;
  approvedAmount: number;
  actualWorkingDays: number | null;
  compareStatus: string;
  toApprove: boolean;
  rowReason: string | null;
  repaymentMonths: number | null;
  shortAdvanceId: string | null;
  note: string | null;
  isFawry?: boolean;
  ineligibilityReason?: string | null;
  employee?: {
    jobTitle: string | null;
    workLocation?: { name: string; actualName?: string | null } | null;
  } | null;
}) {
  return {
    id: line.id,
    importId: line.importId,
    employeeId: line.employeeId,
    employeeCode: line.employeeCode ?? '',
    employeeName: line.employeeName ?? '',
    jobTitle: line.employee?.jobTitle ?? '',
    locationName: formatLocationDisplay(
      line.employee?.workLocation?.name,
      line.employee?.workLocation?.actualName,
    ),
    requestedAmount: line.requestedAmount,
    eligibleAmount: line.eligibleAmount,
    systemEligibleAmount: line.systemEligibleAmount,
    eligibilityOverridden: line.eligibilityOverridden,
    approvedAmount: line.approvedAmount,
    actualWorkingDays: line.actualWorkingDays,
    compareStatus: line.compareStatus,
    toApprove: line.toApprove,
    rowReason: line.rowReason ?? '',
    repaymentMonths: line.repaymentMonths,
    shortAdvanceId: line.shortAdvanceId,
    note: line.note ?? '',
    isFawry: line.isFawry === true,
    ineligibilityReason: line.ineligibilityReason ?? '',
  };
}

export async function createAdvanceLoanImport(params: {
  deviceId?: string | null;
  sourceGridId?: string | null;
  date?: string;
  defaultRepaymentMonths?: number;
  defaultReason?: string;
  kind?: string;
}) {
  const date = parseDay(params.date);
  const kind = params.kind === 'tip' ? 'tip' : 'loan';
  const reference =
    kind === 'tip'
      ? await nextTipImportReference(date)
      : await nextAdvanceLoanImportReference(date);
  const batch = await prisma.advanceLoanImport.create({
    data: {
      reference,
      kind,
      deviceId: params.deviceId ?? null,
      sourceGridId: params.sourceGridId ?? null,
      date,
      defaultRepaymentMonths: params.defaultRepaymentMonths ?? 12,
      defaultReason:
        params.defaultReason ??
        (kind === 'tip' ? 'Commission' : 'سلفة بناء على الاستحقاق'),
      state: AdvanceLoanImportState.draft,
    },
  });
  return advanceLoanImportJson(batch);
}

export async function getAdvanceLoanImport(id: string) {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id },
    include: {
      lines: {
        orderBy: { id: 'asc' },
        include: {
          employee: {
            select: {
              code: true,
              name: true,
              jobTitle: true,
              hasFawryAccount: true,
              fawryAccount: true,
              workLocation: { select: { id: true, name: true, actualName: true } },
            },
          },
        },
      },
    },
  });
  if (!batch) throw new NotFoundError('Advance loan import not found');
  const enrichedLines = await enrichLoanImportLinesWithShortAdvanceState(batch.lines);
  const summary = summarizeLoanImportBatch(
    enrichedLines.map((line) => ({
      requestedAmount: line.requestedAmount,
      approvedAmount: line.approvedAmount,
      toApprove: line.toApprove,
      shortAdvanceId: line.shortAdvanceId,
      compareStatus: line.compareStatus,
      employeeCode: line.employeeCode,
      employeeName: line.employeeName,
      note: line.note,
      rowReason: line.rowReason,
      repaymentMonths: line.repaymentMonths,
      isFawry: line.isFawry,
      shortAdvance: line.shortAdvance,
      employee: line.employee,
    })),
  );
  return {
    ...advanceLoanImportJson({
      ...batch,
      lines: batch.lines.map(advanceLoanImportLineJson),
    }),
    ...summary,
  };
}

export function isLoanAccountsExportLine(line: {
  approvedAmount: number;
  toApprove: boolean;
  shortAdvanceId: string | null;
  compareStatus: string;
}): boolean {
  return (
    line.approvedAmount > 0 &&
    (line.toApprove ||
      Boolean(line.shortAdvanceId) ||
      line.compareStatus === 'approved')
  );
}

/** Lines that count toward Cash/Fawry totals — excludes cancelled short advances. */
export function isLoanImportTotalsLine(line: {
  approvedAmount: number;
  toApprove: boolean;
  shortAdvanceId: string | null;
  compareStatus: string;
  shortAdvance?: { state: AdvanceState | string } | null;
}): boolean {
  if (!isLoanAccountsExportLine(line)) return false;
  if (line.shortAdvance?.state === AdvanceState.cancelled) return false;
  return true;
}

async function enrichLoanImportLinesWithShortAdvanceState<
  T extends { shortAdvanceId: string | null },
>(lines: T[]): Promise<(T & { shortAdvance: { state: AdvanceState } | null })[]> {
  const ids = [
    ...new Set(
      lines
        .map((line) => line.shortAdvanceId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const advances = ids.length
    ? await prisma.advanceShort.findMany({
        where: { id: { in: ids } },
        select: { id: true, state: true },
      })
    : [];
  const byId = new Map(advances.map((advance) => [advance.id, advance]));
  return lines.map((line) => ({
    ...line,
    shortAdvance: line.shortAdvanceId
      ? (byId.get(line.shortAdvanceId) ?? null)
      : null,
  }));
}

export function summarizeLoanImportBatch<
  T extends {
    requestedAmount: number;
    approvedAmount: number;
    toApprove: boolean;
    shortAdvanceId: string | null;
    compareStatus: string;
    shortAdvance?: { state: AdvanceState | string } | null;
    employeeCode: string | null;
    employeeName: string | null;
    note: string | null;
    rowReason: string | null;
    repaymentMonths: number | null;
    isFawry?: boolean;
    employee?: {
      code: string | null;
      name: string | null;
      jobTitle: string | null;
      hasFawryAccount: boolean;
      fawryAccount: string | null;
      workLocation?: { id: string; name: string; actualName: string | null } | null;
    } | null;
  },
>(lines: T[]) {
  const locationCounts = new Map<string, { id: string; name: string; count: number }>();
  for (const line of lines) {
    const loc = line.employee?.workLocation;
    const name = loc?.actualName?.trim() || loc?.name?.trim() || '';
    const id = loc?.id ?? '';
    if (!name) continue;
    const key = id || name;
    const current = locationCounts.get(key);
    if (current) current.count += 1;
    else locationCounts.set(key, { id, name, count: 1 });
  }
  const ranked = [...locationCounts.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar'),
  );
  const primary = ranked[0] ?? null;
  const locationNames = ranked.map((row) => row.name);

  const outsiders = lines
    .map((line) => {
      const loc = line.employee?.workLocation;
      const locationName = loc?.actualName?.trim() || loc?.name?.trim() || 'فرع غير محدد';
      const locationId = loc?.id ?? '';
      const isOutsider =
        !primary ||
        (primary.id ? locationId !== primary.id : locationName !== primary.name);
      if (!isOutsider) return null;
      const isFawry = line.isFawry === true;
      const amounts = calculateLoanPaymentAmounts(line.approvedAmount, isFawry);
      return {
        employeeCode: line.employeeCode || line.employee?.code || '',
        employeeName: line.employeeName || line.employee?.name || '',
        jobTitle: line.employee?.jobTitle ?? '',
        locationName,
        requestedAmount: line.requestedAmount,
        approvedAmount: line.approvedAmount,
        totalAmount: amounts.totalAmount,
        isFawry,
        compareStatus: line.compareStatus,
        note: line.note ?? '',
        rowReason: line.rowReason ?? '',
        repaymentMonths: line.repaymentMonths,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);

  let cashAmount = 0;
  let fawryApprovedAmount = 0;
  let fawryCommissionAmount = 0;
  for (const line of lines) {
    if (!isLoanImportTotalsLine(line)) continue;
    const isFawry = line.isFawry === true;
    const amounts = calculateLoanPaymentAmounts(line.approvedAmount, isFawry);
    if (isFawry) {
      fawryApprovedAmount += amounts.approvedAmount;
      fawryCommissionAmount += amounts.fawryCommission;
    } else {
      cashAmount += amounts.totalAmount;
    }
  }
  cashAmount = Math.round(cashAmount * 100) / 100;
  fawryApprovedAmount = Math.round(fawryApprovedAmount * 100) / 100;
  fawryCommissionAmount = Math.round(fawryCommissionAmount * 100) / 100;
  const fawryAmount = Math.round((fawryApprovedAmount + fawryCommissionAmount) * 100) / 100;

  return {
    locationNames,
    locationName: primary?.name || locationNames.join('، ') || 'فرع غير محدد',
    primaryLocationName: primary?.name || 'فرع غير محدد',
    primaryLocationId: primary?.id || null,
    outsiderCount: outsiders.length,
    outsiderLines: outsiders,
    locationCount: locationNames.length,
    mixedLocations: locationNames.length > 1,
    cashAmount,
    fawryApprovedAmount,
    fawryCommissionAmount,
    fawryAmount,
    totalAmount: Math.round((cashAmount + fawryAmount) * 100) / 100,
  };
}

export async function freezeLoanImportPaymentSnapshot(importId: string) {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: importId },
    include: {
      lines: {
        include: {
          employee: {
            select: {
              hasFawryAccount: true,
              fawryAccount: true,
              code: true,
              name: true,
              jobTitle: true,
              workLocation: { select: { id: true, name: true, actualName: true } },
            },
          },
        },
      },
    },
  });
  if (!batch) return;
  const lines = await enrichLoanImportLinesWithShortAdvanceState(batch.lines);
  const summary = summarizeLoanImportBatch(lines);
  await prisma.advanceLoanImport.update({
    where: { id: importId },
    data: {
      cashAmount: summary.cashAmount,
      fawryAmount: summary.fawryAmount,
      totalAmount: summary.totalAmount,
    },
  });
}

export async function listAdvanceLoanImports(
  state: AdvanceLoanImportState = AdvanceLoanImportState.draft,
  kind = 'loan',
) {
  const config = await prisma.bioTimeConfig.findFirst({
    select: { payrollMonthStartDay: true },
  });
  const payrollMonthStartDay = config?.payrollMonthStartDay ?? 26;
  const rows = await prisma.advanceLoanImport.findMany({
    where: {
      state,
      kind,
      lines: { some: {} },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { lines: true } },
      lines: {
        select: {
          requestedAmount: true,
          approvedAmount: true,
          toApprove: true,
          shortAdvanceId: true,
          compareStatus: true,
          employeeCode: true,
          employeeName: true,
          note: true,
          rowReason: true,
          repaymentMonths: true,
          isFawry: true,
          employee: {
            select: {
              code: true,
              name: true,
              jobTitle: true,
              hasFawryAccount: true,
              fawryAccount: true,
              workLocation: { select: { id: true, name: true, actualName: true } },
            },
          },
        },
      },
    },
  });
  const items = await Promise.all(
    rows.map(async (r) => {
      const lines = await enrichLoanImportLinesWithShortAdvanceState(r.lines);
      const summary = summarizeLoanImportBatch(lines);
      return {
        id: r.id,
        reference: r.reference,
        kind: r.kind,
        date: r.date.toISOString().slice(0, 10),
        state: r.state,
        lineCount: r._count.lines,
        odooAccountsSendId: r.odooAccountsSendId,
        odooMoveId: r.odooMoveId,
        odooSendRef: r.odooSendRef ?? '',
        notificationEmailsSentAt:
          r.notificationEmailsSentAt?.toISOString() ?? null,
        notificationEmailError: r.notificationEmailError ?? '',
        createdAt: r.createdAt.toISOString(),
        ...summary,
      };
    }),
  );
  return {
    payrollMonthStartDay,
    items,
  };
}

export async function deleteAdvanceLoanImportDraft(id: string) {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id },
    select: { id: true, state: true },
  });
  if (!batch) throw new NotFoundError('Advance loan import not found');
  if (batch.state !== AdvanceLoanImportState.draft) {
    throw new AppError('لا يمكن حذف استيراد تم اعتماده', 400, 'ACTION_ERROR');
  }
  await prisma.advanceLoanImport.delete({ where: { id } });
  return { deleted: true, id };
}

type LoanLinePayload = Parameters<
  typeof prisma.advanceLoanImportLine.create
>[0]['data'];

async function evaluateLoanFileRows(params: {
  batch: {
    id: string;
    sourceGridId: string | null;
    date: Date;
    defaultReason: string | null;
    defaultRepaymentMonths: number;
    kind?: string | null;
  };
  loanFileBase64: string;
  eligibilityFileBase64?: string;
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<LoanLinePayload[]> {
  const rows = await loadLoanImportSheetRows(params.loanFileBase64);
  const { headerIdx, header } = findHeaderRow(rows);

  const codeCol = headerIndex(
    header,
    ['employee_code', 'code', 'كود الموظف'],
    true,
    'employee_code',
  );
  const nameCol = headerIndex(
    header,
    ['employee_name', 'name', 'اسم الموظف'],
    false,
  );
  const requestedCol = headerIndex(
    header,
    LOAN_FILE_AMOUNT_ALIASES,
    true,
    'amount',
  );
  const daysCol = headerIndex(header, LOAN_FILE_DAYS_ALIASES, false);
  const eligibleCol = headerIndex(
    header,
    [
      'eligible_amount',
      'eligible amount',
      'eligibility amount',
      'استحقاقه',
      'الاستحقاق',
    ],
    false,
  );
  const statusCol = headerIndex(
    header,
    ['status', 'eligibility status', 'الحالة'],
    false,
  );
  const reasonCol = headerIndex(
    header,
    ['reason', 'loan reason', 'السبب', 'ملاحظات', 'note'],
    false,
  );
  const repaymentCol = headerIndex(
    header,
    [
      'repayment months',
      'months',
      'installments',
      'عدد الأشهر',
      'عدد شهور السداد',
    ],
    false,
  );

  const eligibilityMaps = params.eligibilityFileBase64
    ? await buildEligibilityMapsFromFile(params.eligibilityFileBase64)
    : new Map();
  const hasEligibilityFile = eligibilityMaps.size > 0;

  const eligPeriod = await eligibilityPeriodForBatch(params.batch);
  const lineCreates: LoanLinePayload[] = [];
  const seenCodes = new Set<string>();

  for (const row of rows.slice(headerIdx + 1)) {
    if (!row) continue;
    const empCode = normalizeLoanEmployeeCode(row[codeCol]);
    const empName = nameCol >= 0 ? String(row[nameCol] ?? '').trim() : '';
    if (!empCode && !empName) continue;

    const requestedAmount = parseFloatCell(row[requestedCol], 0);
    if (requestedAmount <= 0) continue;

    const codeKey = empCode || `name:${empName}`;
    if (seenCodes.has(codeKey)) continue;
    seenCodes.add(codeKey);

    const isTip = params.batch.kind === 'tip';
    let eligibleAmount = requestedAmount;
    let systemEligibleAmount: number | null = null;
    let eligibilityOverridden = false;
    let approvedFromEligibility: number | null = null;
    let actualWorkingDays: number | null = null;
    let compareStatus = 'ready';
    let note = '';
    let ineligibilityReason: string | null = null;

    const employee = empCode ? await resolveEmployeeByCode(empCode) : null;

    if (isTip) {
      eligibleAmount = requestedAmount;
      compareStatus = employee || !empCode ? 'ready' : 'no_mapping';
      if (compareStatus === 'no_mapping') {
        ineligibilityReason = 'الكود غير مربوط بموظف في النظام';
      }
      const daysCell = daysCol >= 0 ? row[daysCol] : null;
      if (excelCellHasValue(daysCell)) {
        actualWorkingDays = parseFloatCell(daysCell, 0);
      }
    } else if (employee) {
      try {
        const systemEligibility = await computeAdvanceEligibility({
          employeeId: employee.id,
          ...eligPeriod,
        });
        systemEligibleAmount = systemEligibility.availableAmount;
        if (!hasEligibilityFile) {
          eligibleAmount = systemEligibility.availableAmount;
          actualWorkingDays = systemEligibility.actualWorkingDays;
          if (!systemEligibility.isEligible || eligibleAmount <= 0)
            compareStatus = 'not_eligible';
          if (!systemEligibility.isEligible) {
            ineligibilityReason =
              `أيام العمل الفعلية (${systemEligibility.actualWorkingDays}) أقل من الحد الأدنى (${systemEligibility.minimumWorkingDays})`;
          } else if (systemEligibility.availableAmount <= 0) {
            ineligibilityReason =
              `لا يوجد مبلغ متاح — الحد ${systemEligibility.maxEligibleAmount} بعد خصم سلف قائمة ${systemEligibility.committedAdvanceTotal}`;
          }
        }
      } catch {
        systemEligibleAmount = 0;
        if (!hasEligibilityFile) {
          compareStatus = 'not_eligible';
          eligibleAmount = 0;
          ineligibilityReason = 'تعذر حساب الاستحقاق';
        }
      }
    }

    if (!isTip && hasEligibilityFile) {
      const info =
        eligibilityMaps.get(empCode) ??
        eligibilityMaps.get(empCode.replace(/\.0$/, ''));
      if (info) {
        eligibleAmount = info.eligibleAmount;
        eligibilityOverridden =
          info.eligibleProvided &&
          systemEligibleAmount != null &&
          Math.abs(eligibleAmount - systemEligibleAmount) > 0.009;
        approvedFromEligibility = info.approvedAmount;
        actualWorkingDays = info.actualWorkingDays;
        if (info.statusText) note = info.statusText;
        const parsedStatus = parseEligibilityStatus(info.statusText);
        if (parsedStatus === 'not_eligible') {
          compareStatus = 'not_eligible';
        } else if (parsedStatus === 'ready') {
          if (eligibleAmount <= 0) eligibleAmount = requestedAmount;
          compareStatus = eligibleAmount > 0 ? 'ready' : 'not_eligible';
        } else if (eligibleAmount <= 0) {
          compareStatus = 'not_eligible';
        } else {
          compareStatus = 'ready';
        }
      } else {
        eligibleAmount = 0;
        compareStatus = 'missing_in_eligibility';
        ineligibilityReason = 'الموظف غير موجود في شيت الاستحقاق';
      }
    } else if (!employee) {
      if (eligibleCol >= 0) {
        eligibleAmount = parseFloatCell(row[eligibleCol], requestedAmount);
      }
      if (statusCol >= 0) {
        const st = String(row[statusCol] ?? '')
          .trim()
          .toLowerCase();
        const parsed = parseEligibilityStatus(st);
        if (parsed === 'not_eligible') compareStatus = 'not_eligible';
        else if (parsed === 'ready' && eligibleAmount > 0)
          compareStatus = 'ready';
      }
    }

    if (!isTip && !employee && empCode) {
      compareStatus = 'no_mapping';
      ineligibilityReason = 'الكود غير مربوط بموظف في النظام';
    }

    const approvedAmount =
      approvedFromEligibility == null
        ? Math.min(Math.max(requestedAmount, 0), Math.max(eligibleAmount, 0))
        : Math.min(
            Math.max(approvedFromEligibility, 0),
            Math.max(requestedAmount, 0),
          );
    const toApprove = compareStatus === 'ready' && approvedAmount > 0;

    let rowReason = params.batch.defaultReason ?? '';
    if (reasonCol >= 0 && row[reasonCol])
      rowReason = String(row[reasonCol]).trim();

    let repaymentMonths = params.batch.defaultRepaymentMonths;
    if (repaymentCol >= 0) {
      const m = Math.floor(parseFloatCell(row[repaymentCol], repaymentMonths));
      if (m > 0) repaymentMonths = m;
    }

    lineCreates.push({
      importId: params.batch.id,
      employeeId: employee?.id ?? null,
      employeeCode: empCode || null,
      employeeName: empName || employee?.name || null,
      requestedAmount,
      eligibleAmount,
      systemEligibleAmount,
      eligibilityOverridden,
      approvedAmount: toApprove ? approvedAmount : 0,
      actualWorkingDays,
      compareStatus,
      toApprove,
      rowReason,
      repaymentMonths,
      note: note || null,
      isFawry: employeeIsFawry(employee),
      ineligibilityReason,
    });
  }

  if (params.batch.kind === 'tip') {
    const missing = [
      ...new Set(
        lineCreates
          .filter((line) => line.employeeId && line.actualWorkingDays == null)
          .map((line) => line.employeeId as string),
      ),
    ];
    if (missing.length) {
      let tipFrom = params.dateFrom ? parseDay(params.dateFrom) : undefined;
      let tipTo = params.dateTo ? parseDay(params.dateTo) : undefined;
      if (!tipFrom || !tipTo) {
        const period = await punchFollowUpPeriod();
        tipFrom = tipFrom ?? period.dateFrom;
        tipTo = tipTo ?? period.dateTo;
      }
      const daysById = await tipsWorkingDaysByEmployeeIds(missing, {
        dateFrom: tipFrom,
        dateTo: tipTo,
        includeInactive: true,
      });
      for (const line of lineCreates) {
        if (line.actualWorkingDays == null && line.employeeId) {
          line.actualWorkingDays = daysById.get(line.employeeId) ?? 0;
        }
      }
    }
  }

  return lineCreates;
}

export async function previewAdvanceLoanImport(params: {
  importId: string;
  loanFileBase64: string;
  eligibilityFileBase64?: string;
  dateFrom?: string | Date;
  dateTo?: string | Date;
}) {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: params.importId },
  });
  if (!batch) throw new NotFoundError('Advance loan import not found');
  if (batch.state === AdvanceLoanImportState.locked) {
    throw new AppError('هذا الاستيراد مقفول بعد الاعتماد', 400, 'ACTION_ERROR');
  }

  const lineCreates = await evaluateLoanFileRows({
    batch,
    loanFileBase64: params.loanFileBase64,
    eligibilityFileBase64: params.eligibilityFileBase64,
    dateFrom: params.dateFrom ? parseDay(params.dateFrom) : undefined,
    dateTo: params.dateTo ? parseDay(params.dateTo) : undefined,
  });

  await prisma.advanceLoanImportLine.deleteMany({
    where: { importId: batch.id },
  });
  for (const data of lineCreates) {
    await prisma.advanceLoanImportLine.create({ data });
  }

  await freezeLoanImportPaymentSnapshot(batch.id);
  return getAdvanceLoanImport(batch.id);
}

/**
 * Re-import the original loan workbook into a draft: update matching codes,
 * add new codes, and leave rows absent from the file untouched. Review edits
 * (toApprove + approvedAmount) are preserved and only capped by the new requested amount.
 */
export async function mergeAdvanceLoanImportFromLoanFile(params: {
  importId: string;
  loanFileBase64: string;
  dateFrom?: string | Date;
  dateTo?: string | Date;
}) {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: params.importId },
    include: { lines: true },
  });
  if (!batch) throw new NotFoundError('Advance loan import not found');
  if (batch.state === AdvanceLoanImportState.locked) {
    throw new AppError('هذا الاستيراد مقفول بعد الاعتماد', 400, 'ACTION_ERROR');
  }
  if (batch.lines.some((line) => line.shortAdvanceId)) {
    throw new AppError(
      'لا يمكن إعادة رفع شيت السلف بعد إنشاء سلف من هذا الاستيراد',
      400,
      'ACTION_ERROR',
    );
  }

  const incoming = await evaluateLoanFileRows({
    batch,
    loanFileBase64: params.loanFileBase64,
    dateFrom: params.dateFrom ? parseDay(params.dateFrom) : undefined,
    dateTo: params.dateTo ? parseDay(params.dateTo) : undefined,
  });

  const existingByCode = new Map<string, (typeof batch.lines)[number]>();
  for (const line of batch.lines) {
    const code = normalizeLoanEmployeeCode(line.employeeCode);
    if (code && !existingByCode.has(code)) existingByCode.set(code, line);
  }

  let updated = 0;
  let added = 0;
  const seen = new Set<string>();

  for (const data of incoming) {
    const code = normalizeLoanEmployeeCode(data.employeeCode);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const existing = existingByCode.get(code);
    if (existing) {
      const requested = Number(data.requestedAmount ?? 0);
      const preservedApproved = Math.min(
        Math.max(existing.approvedAmount, 0),
        requested,
      );
      await prisma.advanceLoanImportLine.update({
        where: { id: existing.id },
        data: {
          employeeId: data.employeeId ?? existing.employeeId,
          employeeCode: data.employeeCode ?? existing.employeeCode,
          employeeName: data.employeeName || existing.employeeName,
          requestedAmount: requested,
          eligibleAmount: data.eligibleAmount,
          systemEligibleAmount: data.systemEligibleAmount,
          eligibilityOverridden: data.eligibilityOverridden,
          actualWorkingDays: data.actualWorkingDays,
          compareStatus: data.compareStatus,
          rowReason: data.rowReason || existing.rowReason,
          repaymentMonths: data.repaymentMonths ?? existing.repaymentMonths,
          note: data.note ?? existing.note,
          toApprove: existing.toApprove,
          approvedAmount: existing.toApprove
            ? preservedApproved
            : Math.min(existing.approvedAmount, requested),
        },
      });
      updated++;
    } else {
      await prisma.advanceLoanImportLine.create({ data });
      added++;
    }
  }

  await freezeLoanImportPaymentSnapshot(batch.id);
  const batchJson = await getAdvanceLoanImport(batch.id);
  return {
    ...batchJson,
    merge: {
      updated,
      added,
      unchanged: batch.lines.length - updated,
    },
  };
}

/** Apply an edited eligibility workbook to persisted draft lines. */
export async function applyEligibilitySheetToImport(
  importId: string,
  eligibilityFileBase64: string,
) {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: importId },
    include: { lines: true },
  });
  if (!batch) throw new NotFoundError('Advance loan import not found');
  if (batch.state !== AdvanceLoanImportState.draft) {
    throw new AppError('هذا الاستيراد مقفول بعد الاعتماد', 400, 'ACTION_ERROR');
  }
  if (!batch.lines.length) {
    throw new AppError('لا توجد سطور في المسودة', 400, 'ACTION_ERROR');
  }

  const eligibilityMaps = await buildEligibilityMapsFromFile(
    eligibilityFileBase64,
  );
  if (!eligibilityMaps.size) {
    throw new AppError('شيت الاستحقاق فارغ أو غير صحيح', 400, 'IMPORT_ERROR');
  }
  const eligPeriod = await eligibilityPeriodForBatch(batch);

  for (const line of batch.lines) {
    const code = (line.employeeCode ?? '').replace(/\.0$/, '');
    const info = eligibilityMaps.get(code);
    if (!info) {
      await prisma.advanceLoanImportLine.update({
        where: { id: line.id },
        data: { compareStatus: 'missing_in_eligibility', toApprove: false },
      });
      continue;
    }

    let systemEligibleAmount = line.systemEligibleAmount;
    if (systemEligibleAmount == null && line.employeeId) {
      try {
        const systemEligibility = await computeAdvanceEligibility({
          employeeId: line.employeeId,
          ...eligPeriod,
        });
        systemEligibleAmount = systemEligibility.availableAmount;
      } catch {
        systemEligibleAmount = 0;
      }
    }

    let eligibleAmount = info.eligibleAmount;
    const parsedStatus = parseEligibilityStatus(info.statusText);
    if (parsedStatus === 'ready' && eligibleAmount <= 0) {
      eligibleAmount = line.requestedAmount;
    }
    const compareStatus = !line.employeeId
      ? 'no_mapping'
      : parsedStatus === 'not_eligible' || eligibleAmount <= 0
        ? 'not_eligible'
        : 'ready';
    const approvedAmount =
      info.approvedAmount == null
        ? Math.min(
            Math.max(line.approvedAmount, 0),
            Math.max(line.requestedAmount, 0),
          )
        : Math.min(
            Math.max(info.approvedAmount, 0),
            Math.max(line.requestedAmount, 0),
          );

    await prisma.advanceLoanImportLine.update({
      where: { id: line.id },
      data: {
        eligibleAmount,
        systemEligibleAmount,
        eligibilityOverridden:
          info.eligibleProvided &&
          systemEligibleAmount != null &&
          Math.abs(eligibleAmount - systemEligibleAmount) > 0.009,
        approvedAmount: compareStatus === 'ready' ? approvedAmount : 0,
        actualWorkingDays: info.actualWorkingDays,
        compareStatus,
        toApprove: compareStatus === 'ready' && approvedAmount > 0,
        note: info.statusText || null,
      },
    });
  }

  return getAdvanceLoanImport(importId);
}

export async function addManualLoanImportLine(params: {
  importId: string;
  employeeId: string;
  requestedAmount: number;
  approvedAmount?: number;
  rowReason?: string;
  dateFrom?: string | Date;
  dateTo?: string | Date;
}) {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: params.importId },
  });
  if (!batch) throw new NotFoundError('Advance loan import not found');
  if (batch.state === AdvanceLoanImportState.locked) {
    throw new AppError('هذا الاستيراد مقفول', 400, 'ACTION_ERROR');
  }
  if (!Number.isFinite(params.requestedAmount) || params.requestedAmount <= 0) {
    throw new AppError(
      'المبلغ المطلوب لازم يكون أكبر من صفر',
      400,
      'VALIDATION_ERROR',
    );
  }

  const employee = await prisma.employeeProfile.findUnique({
    where: { id: params.employeeId },
  });
  if (!employee) throw new NotFoundError('Employee not found');
  const existing = await prisma.advanceLoanImportLine.findFirst({
    where: {
      importId: batch.id,
      OR: [
        { employeeId: employee.id },
        ...(employee.code ? [{ employeeCode: employee.code }] : []),
      ],
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(
      'الموظف موجود بالفعل في شيت السلف',
      400,
      'VALIDATION_ERROR',
    );
  }

  let eligibleAmount = params.requestedAmount;
  let actualWorkingDays: number | null = null;
  let compareStatus = 'ready';
  const isTip = batch.kind === 'tip';
  if (isTip) {
    let tipFrom = params.dateFrom ? parseDay(params.dateFrom) : undefined;
    let tipTo = params.dateTo ? parseDay(params.dateTo) : undefined;
    if (!tipFrom || !tipTo) {
      const period = await punchFollowUpPeriod();
      tipFrom = tipFrom ?? period.dateFrom;
      tipTo = tipTo ?? period.dateTo;
    }
    const daysById = await tipsWorkingDaysByEmployeeIds([employee.id], {
      dateFrom: tipFrom,
      dateTo: tipTo,
      includeInactive: true,
    });
    actualWorkingDays = daysById.get(employee.id) ?? 0;
    compareStatus = 'ready';
  } else {
    try {
      const eligPeriod = await eligibilityPeriodForBatch(batch);
      const elig = await computeAdvanceEligibility({
        employeeId: employee.id,
        ...eligPeriod,
      });
      eligibleAmount = elig.availableAmount;
      actualWorkingDays = elig.actualWorkingDays;
      if (!elig.isEligible) compareStatus = 'not_eligible';
    } catch {
      compareStatus = 'not_eligible';
    }
  }

  const approved = isTip
    ? params.approvedAmount ?? params.requestedAmount
    : params.approvedAmount ?? Math.min(params.requestedAmount, eligibleAmount);

  const line = await prisma.advanceLoanImportLine.create({
    data: {
      importId: batch.id,
      employeeId: employee.id,
      employeeCode: employee.code,
      employeeName: employee.name,
      requestedAmount: params.requestedAmount,
      eligibleAmount,
      systemEligibleAmount: eligibleAmount,
      eligibilityOverridden: false,
      approvedAmount: approved,
      actualWorkingDays,
      compareStatus,
      toApprove: approved > 0,
      rowReason: params.rowReason ?? batch.defaultReason,
      repaymentMonths: batch.defaultRepaymentMonths,
      note: isTip ? 'سطر يدوي — Commission' : 'سطر يدوي',
      isFawry: employeeIsFawry(employee),
    },
  });

  await freezeLoanImportPaymentSnapshot(batch.id);
  return advanceLoanImportLineJson(line);
}

export async function updateAdvanceLoanImportLine(
  lineId: string,
  fields: {
    approvedAmount?: number;
    toApprove?: boolean;
    rowReason?: string;
    employeeId?: string;
  },
) {
  const line = await prisma.advanceLoanImportLine.findUnique({
    where: { id: lineId },
    include: { import: true },
  });
  if (!line) throw new NotFoundError('Line not found');
  if (line.import.state === AdvanceLoanImportState.locked) {
    throw new AppError('الاستيراد مقفول', 400, 'ACTION_ERROR');
  }
  if (line.shortAdvanceId) {
    throw new AppError('السطر معتمد بالفعل', 400, 'ACTION_ERROR');
  }

  const data: Record<string, unknown> = {};
  if (fields.approvedAmount !== undefined) {
    const approved = Number(fields.approvedAmount);
    if (!Number.isFinite(approved) || approved < 0) {
      throw new AppError('المبلغ المعتمد غير صحيح', 400, 'VALIDATION_ERROR');
    }
    if (approved > line.requestedAmount + 0.009) {
      throw new AppError(
        `المبلغ المعتمد (${approved}) أكبر من المبلغ المطلوب (${line.requestedAmount})`,
        400,
        'VALIDATION_ERROR',
      );
    }
    data.approvedAmount = approved;
  }
  if (fields.toApprove !== undefined)
    data.toApprove = Boolean(fields.toApprove);
  if (fields.rowReason !== undefined) data.rowReason = String(fields.rowReason);
  if (fields.employeeId) {
    const emp = await prisma.employeeProfile.findUnique({
      where: { id: fields.employeeId },
    });
    if (emp) {
      data.employeeId = emp.id;
      data.employeeCode = emp.code;
      data.employeeName = emp.name;
    }
  }

  const updated = await prisma.advanceLoanImportLine.update({
    where: { id: lineId },
    data,
  });
  return advanceLoanImportLineJson(updated);
}

export async function approveAdvanceLoanImport(importId: string) {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: importId },
    include: { lines: true },
  });
  if (!batch) throw new NotFoundError('Advance loan import not found');
  if (batch.state === AdvanceLoanImportState.locked) {
    throw new AppError('تم اعتماد هذا الاستيراد مسبقاً', 400, 'ACTION_ERROR');
  }

  const lines = batch.lines.filter(
    (l) => l.toApprove && l.approvedAmount > 0 && !l.shortAdvanceId,
  );
  if (!lines.length) {
    throw new AppError(
      'لا توجد سطور للاعتماد — أدخل مبلغاً معتمداً أكبر من صفر',
      400,
      'ACTION_ERROR',
    );
  }

  const deductionStart = firstOfNextMonth(batch.date);
  const eligPeriod = await eligibilityPeriodForBatch(batch);
  let created = 0;

  for (const line of lines) {
    let employeeId = line.employeeId;
    if (!employeeId && line.employeeCode) {
      const emp = await resolveEmployeeByCode(line.employeeCode);
      employeeId = emp?.id ?? null;
    }
    if (!employeeId) {
      throw new AppError(
        `السطر «${line.employeeName || line.employeeCode}» غير مرتبط بموظف`,
        400,
        'VALIDATION_ERROR',
      );
    }

    if (batch.kind === 'tip') {
      await prisma.advanceLoanImportLine.update({
        where: { id: line.id },
        data: {
          employeeId,
          compareStatus: 'approved',
          toApprove: false,
          note: 'تم اعتماد التيبس',
        },
      });
      created++;
      continue;
    }

    const reason =
      line.rowReason || batch.defaultReason || 'سلفة بناء على الاستحقاق';
    const auditEligible = line.systemEligibleAmount ?? line.eligibleAmount;
    const requiresLimitOverride =
      line.compareStatus === 'not_eligible' ||
      line.approvedAmount > auditEligible + 0.009;
    const overrideReason = requiresLimitOverride
      ? `اعتماد يدوي من استيراد السلف — استحقاق النظام ${auditEligible}، المعتمد ${line.approvedAmount}`
      : null;
    const short = await createShortAdvance({
      employeeId,
      amount: line.approvedAmount,
      date: batch.date,
      deductionStartDate: deductionStart,
      notes: reason,
      sourceGridId: batch.sourceGridId,
      shiftGridId: eligPeriod.shiftGridId ?? batch.sourceGridId,
      eligibilityDateFrom: eligPeriod.dateFrom,
      eligibilityDateTo: eligPeriod.dateTo,
      limitOverride: requiresLimitOverride,
      overrideReason,
    });

    await prisma.advanceLoanImportLine.update({
      where: { id: line.id },
      data: {
        employeeId,
        compareStatus: 'approved',
        shortAdvanceId: short.id,
        toApprove: false,
        note: `تم اعتماد السلفة ${short.id.slice(0, 8)}`,
      },
    });
    created++;
  }

  await prisma.advanceLoanImport.update({
    where: { id: importId },
    data: { state: AdvanceLoanImportState.locked },
  });
  await freezeLoanImportPaymentSnapshot(importId);

  return { created, import: await getAdvanceLoanImport(importId) };
}

export async function exportAdvanceLoanImportReview(
  importId: string,
): Promise<string> {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: importId },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
  if (!batch) throw new NotFoundError('Advance loan import not found');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Review');
  sheet.views = [{ rightToLeft: true }];

  const headers = [
    'كود الموظف',
    'اسم الموظف',
    'المطلوب',
    'المستحق',
    'المعتمد',
    'أيام العمل',
    'الحالة',
    'اعتماد',
    'السبب',
  ];
  headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h;
  });

  batch.lines.forEach((line, idx) => {
    const r = idx + 2;
    sheet.getCell(r, 1).value = line.employeeCode ?? '';
    sheet.getCell(r, 2).value = line.employeeName ?? '';
    sheet.getCell(r, 3).value = line.requestedAmount;
    sheet.getCell(r, 4).value = line.eligibleAmount;
    sheet.getCell(r, 5).value = line.approvedAmount;
    sheet.getCell(r, 6).value = line.actualWorkingDays ?? '';
    sheet.getCell(r, 7).value = line.compareStatus;
    sheet.getCell(r, 8).value = line.toApprove ? 'نعم' : 'لا';
    sheet.getCell(r, 9).value = line.rowReason ?? '';
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

/**
 * Build eligibility sheet from loan Excel — employees prefilled with
 * system-computed eligibility (amount / days / status).
 */
export async function exportEligibilitySheetFromLoanFile(
  loanFileBase64: string,
  options?: { sourceGridId?: string | null },
): Promise<{
  base64: string;
  filename: string;
  count: number;
}> {
  const rows = await loadLoanImportSheetRows(loanFileBase64);
  const { headerIdx, header } = findHeaderRow(rows);

  const codeCol = headerIndex(
    header,
    ['employee_code', 'code', 'كود الموظف'],
    true,
    'employee_code',
  );
  const nameCol = headerIndex(
    header,
    ['employee_name', 'name', 'اسم الموظف'],
    false,
  );
  const requestedCol = headerIndex(
    header,
    [
      'amount',
      'requested_amount',
      'requested amount',
      'loan amount',
      'قيمة السلفة',
      'المبلغ',
      'مبلغ السلفة',
    ],
    true,
    'amount',
  );

  type EmpRow = {
    code: string;
    name: string;
    jobTitle: string;
    hiringDate: string;
    requested: number;
    eligible: number;
    approved: number;
    days: number | '';
    status: string;
  };
  const seen = new Set<string>();
  const employees: EmpRow[] = [];
  const locationIds = new Set<string>();

  const eligPeriod = await eligibilityPeriodForBatch({
    sourceGridId: options?.sourceGridId ?? null,
    date: parseDay(new Date()),
  });

  for (const row of rows.slice(headerIdx + 1)) {
    if (!row) continue;
    const code = String(row[codeCol] ?? '').trim();
    if (!code) continue;
    const requested = parseFloatCell(row[requestedCol], 0);
    if (requested <= 0) continue;
    const key = code.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let name = nameCol >= 0 ? String(row[nameCol] ?? '').trim() : '';
    const emp = await resolveEmployeeByCode(code);
    if (!name) name = emp?.name ?? '';
    if (emp?.locationId) locationIds.add(emp.locationId);

    let eligible = 0;
    let approved = 0;
    let days: number | '' = '';
    let status = 'بدون ربط';

    if (emp) {
      try {
        const elig = await computeAdvanceEligibility({
          employeeId: emp.id,
          ...eligPeriod,
        });
        eligible = elig.availableAmount;
        approved = Math.min(requested, eligible);
        days = elig.actualWorkingDays;
        if (!elig.isEligible || eligible <= 0) status = 'غير مستحق';
        else if (requested > eligible + 0.009) status = 'مستحق';
        else status = 'مستحق';
      } catch {
        status = 'غير مستحق';
        eligible = 0;
      }
    }

    employees.push({
      code,
      name,
      jobTitle: emp?.jobTitle ?? '',
      hiringDate: emp?.hiringDate?.toISOString().slice(0, 10) ?? '',
      requested,
      eligible,
      approved,
      days,
      status,
    });
  }

  if (employees.length === 0) {
    throw new AppError(
      'ملف السلف فارغ أو بدون موظفين صالحين',
      400,
      'IMPORT_ERROR',
    );
  }

  const locationNames = await locationNamesForIds(locationIds);
  return buildEligibilityWorkbook(employees, {
    locationToken: locationFilenameToken(locationNames),
  });
}

/** Export eligibility sheet from an existing import batch review lines. */
export async function exportEligibilitySheetFromImport(
  importId: string,
): Promise<{
  base64: string;
  filename: string;
  count: number;
}> {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: importId },
    include: {
      lines: {
        orderBy: { id: 'asc' },
        include: {
          employee: {
            select: {
              jobTitle: true,
              hiringDate: true,
              workLocation: { select: { name: true, actualName: true } },
            },
          },
        },
      },
    },
  });
  if (!batch) throw new NotFoundError('Advance loan import not found');
  if (!batch.lines.length) {
    throw new AppError(
      'لا توجد سطور للتصدير — ارفع شيت السلف أولاً',
      400,
      'ACTION_ERROR',
    );
  }

  const employees = batch.lines.map((line) => ({
    code: line.employeeCode ?? '',
    name: line.employeeName ?? '',
    jobTitle: line.employee?.jobTitle ?? '',
    hiringDate: line.employee?.hiringDate?.toISOString().slice(0, 10) ?? '',
    requested: line.requestedAmount,
    eligible: line.eligibleAmount,
    approved: line.approvedAmount,
    days: line.actualWorkingDays ?? ('' as number | ''),
    status: eligibilityStatusAr(line.compareStatus),
  }));

  return buildEligibilityWorkbook(employees, {
    locationToken: locationFilenameToken(
      batch.lines.map(
        (line) =>
          line.employee?.workLocation?.actualName?.trim() ||
          line.employee?.workLocation?.name ||
          '',
      ),
    ),
  });
}

function eligibilityStatusAr(status: string): string {
  switch (status) {
    case 'ready':
    case 'approved':
      return 'مستحق';
    case 'not_eligible':
    case 'missing_in_eligibility':
    case 'no_mapping':
      return 'غير مستحق';
    default:
      if (String(status).includes('مستحق') && !String(status).includes('غير'))
        return 'مستحق';
      if (String(status).includes('غير')) return 'غير مستحق';
      // e.g. يتجاوز المتاح — still editable as مستحق with capped amount
      if (String(status).includes('يتجاوز')) return 'مستحق';
      return status === 'مستحق' ? 'مستحق' : 'غير مستحق';
  }
}

function parseEligibilityStatus(raw: string): 'ready' | 'not_eligible' | null {
  const st = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!st) return null;
  if (st.includes('غير') || st.includes('not') || st === 'no')
    return 'not_eligible';
  if (
    st.includes('مستحق') ||
    st.includes('ready') ||
    st.includes('yes') ||
    st === 'eligible'
  )
    return 'ready';
  return null;
}

async function buildEligibilityWorkbook(
  employees: Array<{
    code: string;
    name: string;
    jobTitle: string;
    hiringDate: string;
    requested: number;
    eligible: number;
    approved: number;
    days: number | '';
    status: string;
  }>,
  options?: { locationToken?: string },
): Promise<{ base64: string; filename: string; count: number }> {
  const workbook = new ExcelJS.Workbook();

  // Data sheet FIRST so importers that default to worksheets[0] still work.
  const sheet = workbook.addWorksheet('الاستحقاق');
  sheet.views = [{ rightToLeft: true }];

  const headers = [
    'كود الموظف',
    'اسم الموظف',
    'الوظيفة',
    'تاريخ التعيين',
    'مبلغ السلفة',
    'الاستحقاق',
    'المبلغ المعتمد',
    'أيام العمل',
    'الحالة',
  ];
  headers.forEach((h, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8EEF7' },
    };
    cell.protection = { locked: true };
  });

  const lastDataRow = Math.max(employees.length + 1, 2);
  employees.forEach((e, idx) => {
    const r = idx + 2;
    const status = eligibilityStatusAr(e.status);
    sheet.getCell(r, 1).value = e.code;
    sheet.getCell(r, 2).value = e.name;
    sheet.getCell(r, 3).value = e.jobTitle;
    sheet.getCell(r, 4).value = e.hiringDate;
    sheet.getCell(r, 5).value = e.requested;
    sheet.getCell(r, 6).value = e.eligible;
    sheet.getCell(r, 7).value = e.approved;
    sheet.getCell(r, 8).value = e.days;
    sheet.getCell(r, 9).value = status;

    sheet.getCell(r, 1).protection = { locked: true };
    sheet.getCell(r, 2).protection = { locked: true };
    sheet.getCell(r, 3).protection = { locked: true };
    sheet.getCell(r, 4).protection = { locked: true };
    sheet.getCell(r, 5).protection = { locked: true };
    sheet.getCell(r, 6).protection = { locked: false };
    sheet.getCell(r, 7).protection = { locked: false };
    sheet.getCell(r, 8).protection = { locked: false };
    sheet.getCell(r, 9).protection = { locked: false };
  });

  [16, 28, 22, 16, 14, 14, 16, 12, 16].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  if (employees.length > 0) {
    const validations = (
      sheet as ExcelJS.Worksheet & {
        dataValidations: {
          add: (address: string, validation: Record<string, unknown>) => void;
        };
      }
    ).dataValidations;
    validations.add(`I2:I${lastDataRow}`, {
      type: 'list',
      allowBlank: false,
      formulae: ['"مستحق,غير مستحق"'],
      showErrorMessage: true,
      errorTitle: 'الحالة',
      error: 'اختر مستحق أو غير مستحق فقط',
      showInputMessage: true,
      promptTitle: 'الحالة',
      prompt: 'مستحق أو غير مستحق',
    });
  }

  await sheet.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    insertRows: false,
    deleteRows: false,
    insertColumns: false,
    deleteColumns: false,
  });

  const help = workbook.addWorksheet('تعليمات');
  help.views = [{ rightToLeft: true }];
  help.getColumn(1).width = 80;
  const tips = [
    'كيفية تعديل شيت الاستحقاق',
    '',
    '1) لا تضيف صفوف/موظفين جدد — الصفوف دي هي نفس موظفين شيت السلف فقط.',
    '2) الأعمدة المقفولة (لا تعدّلها): كود الموظف، اسم الموظف، الوظيفة، تاريخ التعيين، مبلغ السلفة.',
    '3) الأعمدة المسموح تعديلها: الاستحقاق، المبلغ المعتمد، أيام العمل، الحالة.',
    '4) عمود «الحالة» اختَر من القائمة: مستحق أو غير مستحق فقط.',
    '5) المبلغ المعتمد هو المبلغ الذي ستُنشأ به السلفة. يمكن أن يتجاوز الاستحقاق كتجاوز يدوي مسجل، لكنه لا يمكن أن يتجاوز مبلغ السلفة.',
    '6) بعد التعديل: ارفع الملف من صفحة مراجعة حالات الاستحقاق (استيراد شيت الاستحقاق).',
  ];
  tips.forEach((t, i) => {
    help.getCell(i + 1, 1).value = t;
    if (i === 0) help.getCell(i + 1, 1).font = { bold: true, size: 14 };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const day = new Date().toISOString().slice(0, 10);
  return {
    base64: Buffer.from(buffer).toString('base64'),
    filename: `advances_eligibility_${options?.locationToken || 'unknown_location'}_${day}.xlsx`,
    count: employees.length,
  };
}
