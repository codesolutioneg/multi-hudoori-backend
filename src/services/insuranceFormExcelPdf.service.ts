/**
 * Insurance forms س1 / س6 PDF from official Excel template + LibreOffice Calc.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { InsuranceFormType } from '@prisma/client';
import { AppError } from '../utils/errors';

const MASTER_SHEET = 'الجدول الاساسي';
const SHEET_S1 = 'س1';
const SHEET_S6 = 'س6';
const CODE_SHEETS = ['اكواد المهن', 'اكواد اخرى'] as const;

/** First two printed pages = form sheet (must be first tab; helper sheets hidden). */
const PDF_FILTER =
  'pdf:calc_pdf_Export:{"PageRange":{"type":"string","value":"1-2"}}';

/**
 * Keep formulas + lookup sheets for LibreOffice recalc; only control print order.
 * Manual formula flattening broke digit boxes (full number in every cell).
 */
function setSheetOrder(ws: ExcelJS.Worksheet, orderNo: number): void {
  (ws as ExcelJS.Worksheet & { orderNo: number }).orderNo = orderNo;
}

function configureWorkbookForPdfExport(
  wb: ExcelJS.Workbook,
  formType: InsuranceFormType,
): ExcelJS.Worksheet {
  const formSheetName = formType === InsuranceFormType.S1 ? SHEET_S1 : SHEET_S6;
  const form = wb.getWorksheet(formSheetName);
  if (!form) {
    throw new AppError('ورقة الاستمارة غير موجودة في القالب', 500, 'CONFIG');
  }
  setSheetOrder(form, 0);
  form.state = 'visible';

  const master = wb.getWorksheet(MASTER_SHEET);
  if (master) {
    master.state = 'veryHidden';
    master.pageSetup.printArea = 'A1:A1';
    setSheetOrder(master, 90);
  }
  for (const name of CODE_SHEETS) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    ws.state = 'veryHidden';
    ws.pageSetup.printArea = 'A1:A1';
    setSheetOrder(ws, 80);
  }
  const otherForm = formType === InsuranceFormType.S1 ? SHEET_S6 : SHEET_S1;
  const other = wb.getWorksheet(otherForm);
  if (other) {
    other.state = 'veryHidden';
    other.pageSetup.printArea = 'A1:A1';
    setSheetOrder(other, 70);
  }
  return form;
}

/** Payload field → master row header (row 3). */
const PAYLOAD_TO_HEADER: Record<string, string> = {
  employeeName: 'اسم المؤمن عليه',
  nationalId: 'الرقم القومي',
  insuranceNumber: 'الرقم التأميني',
  nationality: 'الجنسية',
  qualification: 'المؤهل',
  jobTitle: 'المهنة',
  subscriptionStartDate: 'تاريخ بدأ الاشتراك',
  sector: 'القطاع',
  subscriptionCode: 'كود الاشتراك',
  durationType: 'نوع المدة',
  subscriptionWage: 'اجر الاشتراك',
  totalWage: 'الاجر الشامل',
  disabilityStartDate: 'تاريخ بداية العجز',
  disabilityRate: 'نسبة العجز',
  medicalExam: 'استيفاء الكشف الطبي',
  buildingNumber: 'عقار رقم',
  street: 'شارع',
  village: 'قرية',
  district: 'قسم / مركز',
  governorate: 'محافظة',
  phone: 'رقم التليفون',
  establishmentName: 'اسم المنشأة',
  establishmentAddress: 'عنوان المنشأة',
  establishmentType: 'نوع المنشأة',
  establishmentInsuranceNumber: 'الرقم التأميني للمنشأة',
  office: 'المكتب',
  subscriptionCategory: 'فئة الاشتراك',
  subscriptionEndDate: 'تاريخ انتهاء الاشتراك',
  endReason: 'سبب انتهاء الاشتراك',
  noticeNumber: 'رقم الاخطار',
  noticeDate: 'تاريخ الاخطار',
  applicantName: 'اسم مقدم الطلب',
  applicantRole: 'صفة مقدم الطلب',
  applicantInsuranceNumber: 'الرقم التأميني لمقدم الطلب',
  applicantPhone: 'رقم تليفون مقدم الطلب',
  applicantNationalId: 'رقم قومي مقدم الطلب',
};

const DATE_HEADERS = new Set([
  'تاريخ بدأ الاشتراك',
  'تاريخ انتهاء الاشتراك',
  'تاريخ الاخطار',
  'تاريخ بداية العجز',
]);

const NUMERIC_HEADERS = new Set(['اجر الاشتراك', 'الاجر الشامل', 'نسبة العجز']);

function resolveTemplatePath(): string {
  const candidates = [
    path.join(process.cwd(), 'assets/insurance-forms/template.xlsx'),
    path.resolve(__dirname, '../../assets/insurance-forms/template.xlsx'),
    path.resolve(__dirname, '../../../assets/insurance-forms/template.xlsx'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new AppError('ملف قالب استمارة التأمينات غير موجود على الخادم', 500, 'CONFIG');
}

function str(v: unknown): string {
  return String(v ?? '').trim();
}

function parseDateCell(value: unknown): Date | string | null {
  const s = str(value);
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) {
    return new Date(
      Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])),
    );
  }
  return s;
}

function formatIssueDateDisplay(value: unknown): string {
  const s = str(value);
  if (!s) return '';
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${d} / ${m} / ${y}`;
  }
  return s;
}

function headerColumnMap(master: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  master.getRow(3).eachCell({ includeEmpty: false }, (cell, col) => {
    const h = str(cell.value);
    if (h) map.set(h, col);
  });
  return map;
}

function upsertMasterRow(
  master: ExcelJS.Worksheet,
  employeeCode: string | number,
  payload: Record<string, unknown>,
): void {
  const headers = headerColumnMap(master);
  const codeCol = headers.get('الكود') ?? 2;
  let targetRow = 0;
  for (let r = 4; r <= 2000; r++) {
    const existing = master.getCell(r, codeCol).value;
    if (existing == null || existing === '') {
      if (!targetRow) targetRow = r;
      continue;
    }
    if (String(existing) === String(employeeCode)) {
      targetRow = r;
      break;
    }
  }
  if (!targetRow) throw new AppError('جدول البيانات في القالب ممتلئ', 500, 'CONFIG');

  const row = master.getRow(targetRow);
  row.getCell(codeCol).value =
    typeof employeeCode === 'number' ? employeeCode : str(employeeCode) || employeeCode;

  for (const [key, header] of Object.entries(PAYLOAD_TO_HEADER)) {
    const col = headers.get(header);
    if (!col) continue;
    const raw = payload[key];
    if (raw === undefined || raw === null || str(raw) === '') continue;
    if (DATE_HEADERS.has(header)) {
      const d = parseDateCell(raw);
      row.getCell(col).value = d;
    } else if (NUMERIC_HEADERS.has(header)) {
      const n = Number(String(raw).replace(/,/g, ''));
      row.getCell(col).value = Number.isFinite(n) ? n : str(raw);
    } else {
      row.getCell(col).value = str(raw);
    }
  }
}

function fillIssueDate(formSheet: ExcelJS.Worksheet, payload: Record<string, unknown>): void {
  const display = formatIssueDateDisplay(payload.issueDate);
  if (!display) return;
  // Merged F54:P54 placeholder for «تحريرا في» date boxes.
  formSheet.getCell('F54').value = display;
}

function trimWorkbookForFill(wb: ExcelJS.Workbook, formType: InsuranceFormType): ExcelJS.Worksheet {
  const formSheetName = formType === InsuranceFormType.S1 ? SHEET_S1 : SHEET_S6;
  const keep = new Set<string>([MASTER_SHEET, formSheetName, ...CODE_SHEETS]);
  for (const ws of [...wb.worksheets]) {
    if (!keep.has(ws.name)) wb.removeWorksheet(ws.id);
  }
  const form = wb.getWorksheet(formSheetName);
  if (!form) {
    throw new AppError('ورقة الاستمارة غير موجودة في القالب', 500, 'CONFIG');
  }
  return form;
}

function resolveSofficePath(): string {
  for (const bin of ['soffice', 'libreoffice']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch {
      /* try next */
    }
  }
  throw new AppError(
    'LibreOffice غير مثبت — مطلوب لتصدير PDF من قالب Excel',
    500,
    'CONFIG',
  );
}

export function isInsuranceExcelPdfAvailable(): boolean {
  try {
    resolveSofficePath();
    resolveTemplatePath();
    return true;
  } catch {
    return false;
  }
}

async function buildFilledWorkbook(
  formType: InsuranceFormType,
  payload: Record<string, unknown>,
  employeeCode: string,
): Promise<{ wb: ExcelJS.Workbook; formSheet: ExcelJS.Worksheet }> {
  const code = str(employeeCode) || str(payload.employeeCode) || str(payload.code);
  if (!code) {
    throw new AppError('كود الموظف مطلوب لتوليد PDF من القالب', 400, 'VALIDATION');
  }
  const lookupCode = /^\d+$/.test(code) ? Number(code) : code;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(resolveTemplatePath());
  const master = wb.getWorksheet(MASTER_SHEET);
  if (!master) throw new AppError('ورقة الجدول الأساسي مفقودة من القالب', 500, 'CONFIG');

  upsertMasterRow(master, lookupCode, payload);
  const formSheet = trimWorkbookForFill(wb, formType);
  formSheet.getCell('AI2').value = lookupCode;
  if (formType === InsuranceFormType.S1) {
    fillIssueDate(formSheet, payload);
  }
  configureWorkbookForPdfExport(wb, formType);
  return { wb, formSheet };
}

function convertXlsxToPdf(xlsxPath: string, outDir: string): string {
  const soffice = resolveSofficePath();
  execFileSync(
    soffice,
    ['--headless', '--convert-to', PDF_FILTER, '--outdir', outDir, xlsxPath],
    { timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const base = path.basename(xlsxPath, path.extname(xlsxPath));
  const pdfPath = path.join(outDir, `${base}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    throw new AppError('فشل تحويل Excel إلى PDF', 500, 'EXPORT');
  }
  return pdfPath;
}

export async function renderInsuranceFormPdfFromExcel(input: {
  formType: InsuranceFormType;
  payload: Record<string, unknown>;
  meta?: { employeeName?: string; createdAt?: string; employeeCode?: string | null };
}): Promise<{ base64: string; filename: string }> {
  const payload = input.payload ?? {};
  const employeeCode =
    str(input.meta?.employeeCode) ||
    str(payload.employeeCode) ||
    str(payload.code);

  const { wb } = await buildFilledWorkbook(input.formType, payload, employeeCode);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insurance-form-'));
  const xlsxPath = path.join(tmpDir, 'form.xlsx');
  try {
    await wb.xlsx.writeFile(xlsxPath);
    const pdfPath = convertXlsxToPdf(xlsxPath, tmpDir);
    const base64 = fs.readFileSync(pdfPath).toString('base64');
    const label = input.formType === InsuranceFormType.S1 ? 'S1' : 'S6';
    const who = str(input.meta?.employeeName || payload.employeeName || 'form')
      .replace(/[^\w\u0600-\u06FF-]+/g, '_')
      .slice(0, 40);
    const day = (input.meta?.createdAt || new Date().toISOString()).slice(0, 10);
    return {
      base64,
      filename: `insurance_${label}_${who}_${day}.pdf`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
