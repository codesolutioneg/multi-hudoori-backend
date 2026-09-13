/**
 * Odoo Integration — journals/accounts mapping + send loan import to
 * biotime.deduction.loan.accounts.send (then create the journal entry).
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { prisma } from '../../prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { formatOdooReviewReference } from '../serialize.service';
import { getOdooConfig } from './odooClient.service';
import { authenticateOdooOrm, executeKw, searchRead } from './odooOrm.service';

export type OdooNamedRecord = { id: number; name: string; code?: string };

export type OdooLoanReviewExcelSummary = {
  cashAmount: number;
  fawryAmount: number;
  cashApprovedAmount: number;
  fawryApprovedAmount: number;
  fawryCommissionAmount: number;
  totalAmount: number;
  cashRows: number;
  fawryRows: number;
};

function excelText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object' && 'result' in value) {
    return excelText((value as { result?: unknown }).result);
  }
  if (typeof value === 'object' && 'text' in value) {
    return String((value as { text?: unknown }).text ?? '').trim();
  }
  return String(value).trim();
}

function normalizedExcelText(value: unknown): string {
  return excelText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function excelAmount(value: unknown): number {
  const raw = excelText(value)
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '');
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

const FAWRY_COMMISSION_RATE = 0.0015;

export function calculateLoanPaymentAmounts(
  approvedAmount: number,
  isFawry: boolean,
): { approvedAmount: number; fawryCommission: number; totalAmount: number } {
  const approved = roundMoney(approvedAmount);
  const commission = isFawry ? roundMoney(approved * FAWRY_COMMISSION_RATE) : 0;
  return {
    approvedAmount: approved,
    fawryCommission: commission,
    totalAmount: roundMoney(approved + commission),
  };
}

/**
 * Parse Odoo's DLW accounts-export workbook. It has Cash/Fawry sheets and the
 * approved amount column; totals are recalculated from employee rows rather
 * than trusting the final total row.
 */
export async function parseOdooLoanReviewExcel(
  fileBase64: string,
): Promise<OdooLoanReviewExcelSummary> {
  if (!fileBase64.trim()) {
    throw new AppError('اختر ملف Excel أولاً', 400, 'VALIDATION');
  }

  const workbook = new ExcelJS.Workbook();
  try {
    const raw = Buffer.from(
      fileBase64.replace(/^data:[^;]+;base64,/, ''),
      'base64',
    );
    await workbook.xlsx.load(raw as unknown as ExcelJS.Buffer);
  } catch {
    throw new AppError('ملف Excel غير صالح أو تالف', 400, 'IMPORT_ERROR');
  }

  const parseSheet = (
    kind: 'cash' | 'fawry',
  ): { amount: number; approvedAmount: number; rows: number } => {
    const names = kind === 'cash' ? ['كاش', 'cash'] : ['فوري', 'fawry'];
    const sheet = workbook.worksheets.find((ws) => {
      const name = normalizedExcelText(ws.name);
      return names.some(
        (candidate) => name === candidate || name.includes(candidate),
      );
    });
    if (!sheet) {
      throw new AppError(
        `الملف لازم يحتوي على شيت «${kind === 'cash' ? 'كاش' : 'فوري'}»`,
        400,
        'IMPORT_ERROR',
      );
    }

    let headerRow = 0;
    let approvedColumn = 0;
    let totalColumn = 0;
    for (
      let rowNumber = 1;
      rowNumber <= Math.min(sheet.rowCount, 8);
      rowNumber += 1
    ) {
      const row = sheet.getRow(rowNumber);
      for (let column = 1; column <= Math.max(row.cellCount, 7); column += 1) {
        const header = normalizedExcelText(row.getCell(column).value);
        if (
          [
            'المبلغ المعتمد',
            'approved amount',
            'approved_amount',
            'المعتمد',
          ].includes(header)
        ) {
          headerRow = rowNumber;
          approvedColumn = column;
        }
        if (
          [
            'الإجمالي',
            'total',
            'amount after commission',
            'المبلغ بعد العمولة',
          ].includes(header)
        ) {
          totalColumn = column;
        }
      }
      if (approvedColumn) break;
    }
    if (!headerRow || !approvedColumn) {
      throw new AppError(
        `شيت «${kind === 'cash' ? 'كاش' : 'فوري'}» لا يحتوي على عمود «المبلغ المعتمد»`,
        400,
        'IMPORT_ERROR',
      );
    }

    let amount = 0;
    let approvedAmount = 0;
    let rows = 0;
    for (
      let rowNumber = headerRow + 1;
      rowNumber <= sheet.rowCount;
      rowNumber += 1
    ) {
      const row = sheet.getRow(rowNumber);
      const firstCell = normalizedExcelText(row.getCell(1).value);
      if (!firstCell || firstCell === 'الإجمالي' || firstCell === 'total')
        continue;
      const approved = excelAmount(row.getCell(approvedColumn).value);
      if (approved <= 0) continue;
      const total = totalColumn
        ? excelAmount(row.getCell(totalColumn).value)
        : 0;
      approvedAmount += approved;
      amount += total > 0 ? total : approved;
      rows += 1;
    }
    return {
      amount: roundMoney(amount),
      approvedAmount: roundMoney(approvedAmount),
      rows,
    };
  };

  const cash = parseSheet('cash');
  const fawry = parseSheet('fawry');
  if (cash.amount <= 0 && fawry.amount <= 0) {
    throw new AppError(
      'لا توجد مبالغ معتمدة أكبر من صفر في الملف',
      400,
      'IMPORT_ERROR',
    );
  }
  return {
    cashAmount: cash.amount,
    fawryAmount: fawry.amount,
    cashApprovedAmount: cash.approvedAmount,
    fawryApprovedAmount: fawry.approvedAmount,
    fawryCommissionAmount: roundMoney(fawry.amount - fawry.approvedAmount),
    totalAmount: roundMoney(cash.amount + fawry.amount),
    cashRows: cash.rows,
    fawryRows: fawry.rows,
  };
}

export async function listOdooJournals(): Promise<OdooNamedRecord[]> {
  const rows = await searchRead<{ id: number; name: string; code: string }>(
    'account.journal',
    [],
    ['id', 'name', 'code'],
    { limit: 300, order: 'name asc' },
  );
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.code }));
}

export async function listOdooAccounts(
  search?: string,
): Promise<OdooNamedRecord[]> {
  const domain: unknown[] = [['deprecated', '=', false]];
  const q = search?.trim();
  if (q) {
    domain.push('|', ['code', 'ilike', q], ['name', 'ilike', q]);
  }
  const rows = await searchRead<{ id: number; name: string; code: string }>(
    'account.account',
    domain,
    ['id', 'name', 'code'],
    { limit: 5000, order: 'code asc' },
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.code ? `${r.code} — ${r.name}` : r.name,
    code: r.code,
  }));
}

export function accountingMappingJson(
  config: Awaited<ReturnType<typeof getOdooConfig>>,
) {
  return {
    integrationEnabled: config.integrationEnabled === true,
    journalOdooId: config.journalOdooId ?? null,
    cashDebitAccountOdooId: config.cashDebitAccountOdooId ?? null,
    cashCreditAccountOdooId: config.cashCreditAccountOdooId ?? null,
    fawryDebitAccountOdooId: config.fawryDebitAccountOdooId ?? null,
    fawryCreditAccountOdooId: config.fawryCreditAccountOdooId ?? null,
  };
}

export async function updateAccountingMapping(fields: {
  integrationEnabled?: boolean;
  journalOdooId?: number | null;
  cashDebitAccountOdooId?: number | null;
  cashCreditAccountOdooId?: number | null;
  fawryDebitAccountOdooId?: number | null;
  fawryCreditAccountOdooId?: number | null;
}) {
  const config = await getOdooConfig();
  const data: Record<string, unknown> = {};
  if (fields.integrationEnabled != null)
    data.integrationEnabled = fields.integrationEnabled;
  if ('journalOdooId' in fields) data.journalOdooId = fields.journalOdooId;
  if ('cashDebitAccountOdooId' in fields)
    data.cashDebitAccountOdooId = fields.cashDebitAccountOdooId;
  if ('cashCreditAccountOdooId' in fields) {
    data.cashCreditAccountOdooId = fields.cashCreditAccountOdooId;
  }
  if ('fawryDebitAccountOdooId' in fields)
    data.fawryDebitAccountOdooId = fields.fawryDebitAccountOdooId;
  if ('fawryCreditAccountOdooId' in fields) {
    data.fawryCreditAccountOdooId = fields.fawryCreditAccountOdooId;
  }
  return prisma.odooConfig.update({ where: { id: config.id }, data });
}

export type LoanAccountsExportLine = {
  deviceName: string;
  employeeCode: string;
  employeeName: string;
  jobTitle: string;
  phone: string;
  isFawry: boolean;
  approvedAmount: number;
};

export function employeeIsFawry(
  employee:
    | {
        hasFawryAccount: boolean;
        fawryAccount: string | null;
      }
    | null
    | undefined,
): boolean {
  return (
    employee?.hasFawryAccount === true ||
    Boolean(employee?.fawryAccount?.trim())
  );
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

/** Most common branch name — never "multiple_locations". */
export function primaryLocationFilenameToken(names: Iterable<string>): string {
  const counts = new Map<string, number>();
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && name.localeCompare(best, 'ar') < 0)
    ) {
      best = name;
      bestCount = count;
    }
  }
  return safeFilenameToken(best || 'unknown_location');
}

/** Mixed-branch batches keep the filename token `multiple`. */
export function accountsExportLocationToken(names: Iterable<string>): string {
  const unique = new Set<string>();
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (name) unique.add(name);
  }
  if (unique.size > 1) return 'multiple';
  return primaryLocationFilenameToken(names);
}

/** Approved lines ready for Odoo accounts send (works after loan lock too). */
const loanAccountsExportLineWhere = (importId: string) => ({
  importId,
  approvedAmount: { gt: 0 },
  OR: [
    { toApprove: true },
    { shortAdvanceId: { not: null } },
    { compareStatus: 'approved' },
  ],
});

async function loadLoanAccountsExportLines(importId: string): Promise<{
  lines: LoanAccountsExportLine[];
  filenameStem: string;
  firstActualName: string;
}> {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: importId },
    include: {
      device: true,
      sourceGrid: true,
      lines: {
        where: loanAccountsExportLineWhere(importId),
        include: {
          employee: {
            select: {
              code: true,
              name: true,
              jobTitle: true,
              mobilePhone: true,
              workPhone: true,
              hasFawryAccount: true,
              fawryAccount: true,
              workLocation: { select: { name: true, actualName: true } },
            },
          },
        },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!batch) throw new NotFoundError('سجل استيراد السلف غير موجود');

  const deviceName = batch.device?.name ?? '';
  const lines = batch.lines.map((line) => ({
    deviceName,
    employeeCode: line.employeeCode ?? line.employee?.code ?? '',
    employeeName: line.employeeName ?? line.employee?.name ?? '',
    jobTitle: line.employee?.jobTitle ?? '',
    phone: line.employee?.mobilePhone || line.employee?.workPhone || '',
    isFawry: line.isFawry === true,
    approvedAmount: line.approvedAmount,
  }));

  const locationLabels = batch.lines.map((line) => {
    const location = line.employee?.workLocation;
    return location?.actualName?.trim() || location?.name?.trim() || '';
  });
  const locationToken = accountsExportLocationToken(locationLabels);
  const firstActualName = locationLabels.find(Boolean) ?? '';
  const sourceToken = safeFilenameToken(
    batch.sourceGrid?.name || batch.reference || 'review',
  );
  const stem = `${locationToken}_${sourceToken}`;
  return { lines, filenameStem: stem, firstActualName };
}

/** Odoo DLW `_build_accounts_export_workbook` parity (فوري + كاش sheets). */
export async function buildOdooLoanAccountsExportWorkbook(
  lines: LoanAccountsExportLine[],
  options?: { filenameStem?: string },
): Promise<
  {
    base64: string;
    filename: string;
  } & OdooLoanReviewExcelSummary
> {
  const workbook = new ExcelJS.Workbook();
  const headerFill = {
    type: 'pattern' as const,
    pattern: 'solid' as const,
    fgColor: { argb: 'FFD9E1F2' },
  };
  const headers = [
    'جهاز البصمة',
    'كود الموظف',
    'اسم الموظف',
    'وظيفة الموظف',
    'رقم التليفون',
    'فوري',
    'المبلغ المعتمد',
    'عمولة فوري',
    'الإجمالي',
  ];

  const writeSheet = (
    sheetName: string,
    sheetLines: LoanAccountsExportLine[],
    isFawrySheet: boolean,
  ) => {
    const sheet = workbook.addWorksheet(sheetName);
    sheet.views = [{ rightToLeft: true }];
    headers.forEach((header, index) => {
      const cell = sheet.getCell(1, index + 1);
      cell.value = header;
      cell.font = { bold: true };
      cell.fill = headerFill;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    [24, 16, 30, 28, 18, 10, 18, 16, 18].forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });

    let approvedTotal = 0;
    let commissionTotal = 0;
    let finalTotal = 0;
    let rowIndex = 2;
    for (const line of sheetLines) {
      if (line.approvedAmount <= 0) continue;
      const amounts = calculateLoanPaymentAmounts(
        line.approvedAmount,
        isFawrySheet,
      );
      const approvedAmount = amounts.approvedAmount;
      const commissionAmount = amounts.fawryCommission;
      const totalAmount = amounts.totalAmount;
      approvedTotal += approvedAmount;
      commissionTotal += commissionAmount;
      finalTotal += totalAmount;
      sheet.getCell(rowIndex, 1).value = line.deviceName;
      sheet.getCell(rowIndex, 2).value = line.employeeCode;
      sheet.getCell(rowIndex, 3).value = line.employeeName;
      sheet.getCell(rowIndex, 4).value = line.jobTitle;
      sheet.getCell(rowIndex, 5).value = line.phone;
      sheet.getCell(rowIndex, 6).value = isFawrySheet ? 'نعم' : 'لا';
      sheet.getCell(rowIndex, 7).value = approvedAmount;
      sheet.getCell(rowIndex, 8).value = commissionAmount;
      sheet.getCell(rowIndex, 9).value = totalAmount;
      rowIndex += 1;
    }

    sheet.getCell(rowIndex, 1).value = 'الإجمالي';
    sheet.getCell(rowIndex, 1).font = { bold: true };
    sheet.getCell(rowIndex, 1).fill = headerFill;
    for (let column = 2; column <= 6; column += 1) {
      sheet.getCell(rowIndex, column).value = '';
      sheet.getCell(rowIndex, column).fill = headerFill;
    }
    [approvedTotal, commissionTotal, finalTotal].forEach((value, index) => {
      const cell = sheet.getCell(rowIndex, index + 7);
      cell.value = roundMoney(value);
      cell.font = { bold: true };
      cell.fill = headerFill;
    });
    return {
      amount: roundMoney(finalTotal),
      approvedAmount: roundMoney(approvedTotal),
      commissionAmount: roundMoney(commissionTotal),
      rows: rowIndex - 2,
    };
  };

  const fawryLines = lines.filter((line) => line.isFawry);
  const cashLines = lines.filter((line) => !line.isFawry);
  const fawry = writeSheet('فوري', fawryLines, true);
  const cash = writeSheet('كاش', cashLines, false);
  if (cash.amount <= 0 && fawry.amount <= 0) {
    throw new AppError('لا توجد مبالغ معتمدة للتصدير', 400, 'VALIDATION');
  }

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `loan_review_${options?.filenameStem || 'review'}_${day}.xlsx`;
  const buffer = await workbook.xlsx.writeBuffer();
  return {
    base64: Buffer.from(buffer).toString('base64'),
    filename,
    cashAmount: cash.amount,
    fawryAmount: fawry.amount,
    cashApprovedAmount: cash.approvedAmount,
    fawryApprovedAmount: fawry.approvedAmount,
    fawryCommissionAmount: fawry.commissionAmount,
    totalAmount: roundMoney(cash.amount + fawry.amount),
    cashRows: cash.rows,
    fawryRows: fawry.rows,
  };
}

/** Download the كاش/فوري accounts sheet for a batch without touching Odoo. */
export async function exportLoanAccountsSheet(importId: string): Promise<
  {
    base64: string;
    filename: string;
  } & OdooLoanReviewExcelSummary
> {
  const { lines, filenameStem } = await loadLoanAccountsExportLines(importId);
  return buildOdooLoanAccountsExportWorkbook(lines, { filenameStem });
}

/** One ZIP with Cash/Fawry workbooks for every locked import in a payroll cycle. */
export async function exportLoanAccountsSheetsForPeriod(
  dateFrom: Date,
  dateTo: Date,
): Promise<{
  base64: string;
  filename: string;
  mimeType: string;
  fileCount: number;
}> {
  const batches = await prisma.advanceLoanImport.findMany({
    where: {
      state: 'locked',
      date: { gte: dateFrom, lte: dateTo },
      lines: { some: {} },
    },
    select: { id: true, reference: true },
    orderBy: { date: 'asc' },
  });
  if (!batches.length) {
    throw new AppError(
      'لا توجد كشوف سلف معتمدة في هذه الفترة',
      400,
      'NOT_FOUND',
    );
  }
  const zip = new JSZip();
  const usedNames = new Set<string>();
  for (const batch of batches) {
    const sheet = await exportLoanAccountsSheet(batch.id);
    let name = sheet.filename || `${batch.reference || batch.id}.xlsx`;
    if (usedNames.has(name)) name = `${batch.id}_${name}`;
    usedNames.add(name);
    zip.file(name, Buffer.from(sheet.base64, 'base64'));
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const from = dateFrom.toISOString().slice(0, 10);
  const to = dateTo.toISOString().slice(0, 10);
  return {
    base64: buf.toString('base64'),
    filename: `loan_accounts_${from}_${to}.zip`,
    mimeType: 'application/zip',
    fileCount: batches.length,
  };
}

function requireMappingIds(config: Awaited<ReturnType<typeof getOdooConfig>>) {
  const journalId = config.journalOdooId;
  const cashDebit = config.cashDebitAccountOdooId;
  const cashCredit = config.cashCreditAccountOdooId;
  const fawryDebit = config.fawryDebitAccountOdooId ?? cashDebit;
  const fawryCredit = config.fawryCreditAccountOdooId ?? cashCredit;
  if (!journalId || !cashDebit || !cashCredit) {
    throw new AppError(
      'اختر دفتر اليومية وحسابات Cash (مدين/دائن) من إعدادات Odoo Integration أولاً',
      400,
      'VALIDATION',
    );
  }
  return {
    journalId,
    cashDebit,
    cashCredit,
    fawryDebit: fawryDebit!,
    fawryCredit: fawryCredit!,
  };
}

/** Split approved amounts into Cash vs Fawry the same way Odoo does (employee fawry flag). */
async function computeCashFawryTotals(
  importId: string,
): Promise<{ cash: number; fawry: number }> {
  const { lines } = await loadLoanAccountsExportLines(importId);
  let cash = 0;
  let fawry = 0;
  for (const line of lines) {
    if (line.isFawry) fawry += line.approvedAmount;
    else cash += line.approvedAmount;
  }
  return { cash: roundMoney(cash), fawry: roundMoney(fawry) };
}

export async function sendLoanImportToOdooAccounts(importId: string): Promise<{
  accountsSendId: number;
  moveId: number | null;
  name: string;
  cashAmount: number;
  fawryAmount: number;
}> {
  const config = await getOdooConfig();
  if (!config.integrationEnabled) {
    throw new AppError(
      'Odoo Integration غير مفعّل في الإعدادات',
      400,
      'VALIDATION',
    );
  }
  const mapping = requireMappingIds(config);

  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: importId },
    include: { device: true, sourceGrid: true },
  });
  if (!batch) throw new NotFoundError('سجل استيراد السلف غير موجود');
  if (batch.kind === 'tip') {
    throw new AppError('شيت التيبس لا يُرسل إلى Odoo', 400, 'ACTION_ERROR');
  }
  if (batch.state !== 'locked') {
    throw new AppError(
      'اعتمد شيت السلف أولاً قبل إرساله إلى Odoo',
      400,
      'ACTION_ERROR',
    );
  }
  if (batch.odooAccountsSendId) {
    throw new AppError(
      `تم الإرسال مسبقًا إلى Odoo (${batch.odooSendRef || batch.odooAccountsSendId})`,
      400,
      'ALREADY_SENT',
    );
  }

  const { lines, filenameStem, firstActualName } =
    await loadLoanAccountsExportLines(importId);
  const exportWorkbook = await buildOdooLoanAccountsExportWorkbook(lines, {
    filenameStem,
  });
  const { cashAmount: cash, fawryAmount: fawry } = exportWorkbook;
  if (cash <= 0 && fawry <= 0) {
    throw new AppError(
      'لا توجد مبالغ معتمدة للإرسال إلى الحسابات',
      400,
      'VALIDATION',
    );
  }

  const session = await authenticateOdooOrm();
  const vals: Record<string, unknown> = {
    cash_amount: cash,
    fawry_amount: fawry,
    wizard_snapshot: formatOdooReviewReference(
      batch.reference,
      firstActualName,
    ),
    accounts_export_file: exportWorkbook.base64,
    accounts_export_filename: exportWorkbook.filename,
    journal_id: mapping.journalId,
    cash_debit_account_id: mapping.cashDebit,
    cash_credit_account_id: mapping.cashCredit,
    fawry_debit_account_id: mapping.fawryDebit,
    fawry_credit_account_id: mapping.fawryCredit,
  };

  const accountsSendId = await executeKw<number>(
    'biotime.deduction.loan.accounts.send',
    'create',
    [vals],
    {},
    session,
  );

  let moveId: number | null = null;
  try {
    await executeKw(
      'biotime.deduction.loan.accounts.send',
      'action_create_journal_entry',
      [[accountsSendId]],
      {},
      session,
    );
    const rows = await searchRead<{
      id: number;
      entry_move_id: false | [number, string];
      name: string;
    }>(
      'biotime.deduction.loan.accounts.send',
      [['id', '=', accountsSendId]],
      ['id', 'name', 'entry_move_id'],
      { limit: 1 },
      session,
    );
    const row = rows[0];
    if (row?.entry_move_id && Array.isArray(row.entry_move_id)) {
      moveId = row.entry_move_id[0];
    }
    const name = row?.name ?? String(accountsSendId);

    await prisma.advanceLoanImport.update({
      where: { id: importId },
      data: {
        odooAccountsSendId: accountsSendId,
        odooMoveId: moveId,
        odooSendRef: name,
      },
    });
    await prisma.odooConfig.update({
      where: { id: config.id },
      data: { lastPushAt: new Date() },
    });

    return {
      accountsSendId,
      moveId,
      name,
      cashAmount: cash,
      fawryAmount: fawry,
    };
  } catch (err) {
    // Record was created; still persist the send id so we don't duplicate.
    const rows = await searchRead<{ id: number; name: string }>(
      'biotime.deduction.loan.accounts.send',
      [['id', '=', accountsSendId]],
      ['id', 'name'],
      { limit: 1 },
      session,
    ).catch(() => []);
    await prisma.advanceLoanImport.update({
      where: { id: importId },
      data: {
        odooAccountsSendId: accountsSendId,
        odooSendRef: rows[0]?.name ?? String(accountsSendId),
      },
    });
    throw err;
  }
}

/** Upload an Odoo DLW accounts-export workbook and immediately create its journal entry. */
export async function uploadLoanReviewExcelToOdoo(params: {
  fileBase64: string;
  filename?: string;
}): Promise<
  {
    accountsSendId: number;
    moveId: number;
    name: string;
    filename: string;
  } & OdooLoanReviewExcelSummary
> {
  const config = await getOdooConfig();
  if (!config.integrationEnabled) {
    throw new AppError(
      'Odoo Integration غير مفعّل في الإعدادات',
      400,
      'VALIDATION',
    );
  }
  const mapping = requireMappingIds(config);
  const summary = await parseOdooLoanReviewExcel(params.fileBase64);
  const filename = (params.filename?.trim() || 'loan_review.xlsx').slice(
    0,
    255,
  );
  const session = await authenticateOdooOrm();

  const accountsSendId = await executeKw<number>(
    'biotime.deduction.loan.accounts.send',
    'create',
    [
      {
        cash_amount: summary.cashAmount,
        fawry_amount: summary.fawryAmount,
        wizard_snapshot: `Hudoori Excel upload — ${filename}`,
        accounts_export_file: params.fileBase64.replace(
          /^data:[^;]+;base64,/,
          '',
        ),
        accounts_export_filename: filename,
        journal_id: mapping.journalId,
        cash_debit_account_id: mapping.cashDebit,
        cash_credit_account_id: mapping.cashCredit,
        fawry_debit_account_id: mapping.fawryDebit,
        fawry_credit_account_id: mapping.fawryCredit,
      },
    ],
    {},
    session,
  );

  try {
    await executeKw(
      'biotime.deduction.loan.accounts.send',
      'action_create_journal_entry',
      [[accountsSendId]],
      {},
      session,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AppError(
      `تم إنشاء سجل السلف في Odoo برقم ${accountsSendId} لكن فشل إنشاء القيد: ${reason}`,
      502,
      'ODOO_JOURNAL_FAILED',
    );
  }

  const rows = await searchRead<{
    id: number;
    name: string;
    entry_move_id: false | [number, string];
  }>(
    'biotime.deduction.loan.accounts.send',
    [['id', '=', accountsSendId]],
    ['id', 'name', 'entry_move_id'],
    { limit: 1 },
    session,
  );
  const record = rows[0];
  const moveId = Array.isArray(record?.entry_move_id)
    ? record.entry_move_id[0]
    : null;
  if (!moveId) {
    throw new AppError(
      `تم إنشاء سجل السلف في Odoo برقم ${accountsSendId} لكن لم يرجع رقم القيد`,
      502,
      'ODOO_JOURNAL_FAILED',
    );
  }

  await prisma.odooConfig.update({
    where: { id: config.id },
    data: { lastPushAt: new Date() },
  });
  return {
    ...summary,
    accountsSendId,
    moveId,
    name: record?.name ?? String(accountsSendId),
    filename,
  };
}
