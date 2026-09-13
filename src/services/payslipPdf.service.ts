/**
 * Payslip breakdown + PDF — Odoo get_payslip_report_values / action_print_payslip
 */
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { prisma } from '../prisma/client';
import { NotFoundError } from '../utils/errors';
import { getPayslipValues } from './payrollExport.service';
import { exportFileResponse } from './payrollExport.service';

const FONT_PATH = path.resolve(__dirname, '../../assets/fonts/NotoSansArabic-Regular.ttf');

let fontBase64Cache: string | null = null;

function getFontBase64(): string {
  if (!fontBase64Cache) {
    if (!fs.existsSync(FONT_PATH)) {
      throw new Error(`Arabic font missing at ${FONT_PATH}`);
    }
    fontBase64Cache = fs.readFileSync(FONT_PATH).toString('base64');
  }
  return fontBase64Cache;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtVal(v: number | string): string {
  if (v === '-' || v === '') return '—';
  if (typeof v === 'string') return escapeHtml(v);
  if (v === Math.round(v)) return String(Math.round(v));
  return v.toFixed(2);
}

function buildPayslipHtml(
  values: ReturnType<typeof getPayslipValues>,
  payrollName: string,
): string {
  const fontBase64 = getFontBase64();
  const earnRows = values.earningRows
    .map(([val, label]) => `
      <tr>
        <td>${escapeHtml(label)}</td>
        <td>${fmtVal(val)}</td>
      </tr>`)
    .join('');
  const dedRows = values.deductionRows
    .map(([val, label]) => `
      <tr>
        <td>${escapeHtml(label)}</td>
        <td>${fmtVal(val)}</td>
      </tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <style>
    @font-face {
      font-family: 'NotoArabic';
      src: url('data:font/ttf;base64,${fontBase64}') format('truetype');
    }
    @page { size: A4; margin: 12mm; }
    body { font-family: 'NotoArabic', sans-serif; font-size: 11px; color: #222; }
    h1 { color: #3F6EA5; font-size: 18px; margin: 0 0 8px; }
    .meta { margin-bottom: 12px; line-height: 1.6; }
    .cols { display: flex; gap: 16px; }
    .col { flex: 1; }
    h2 { font-size: 13px; background: #8FB0D6; color: #fff; padding: 6px; margin: 0 0 6px; text-align: center; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
    td { border: 1px solid #ccc; padding: 4px 6px; text-align: center; }
    .net { font-size: 14px; font-weight: bold; border: 2px solid #333; padding: 8px; text-align: center; margin-top: 8px; }
    .page-break { page-break-after: always; }
  </style>
</head>
<body>
  <h1>مسير راتب — PAYSLIP</h1>
  <div class="meta">
    <div><b>الكشف:</b> ${escapeHtml(payrollName)}</div>
    <div><b>الفترة:</b> ${escapeHtml(values.periodLabel)}</div>
    <div><b>الكود:</b> ${fmtVal(values.employeeCode)} — <b>${escapeHtml(values.employeeName)}</b></div>
    <div><b>الوظيفة:</b> ${escapeHtml(values.position || '—')} — <b>م:</b> ${values.serial}</div>
  </div>
  <div class="cols">
    <div class="col">
      <h2>الاستحقاقات</h2>
      <table>${earnRows}</table>
    </div>
    <div class="col">
      <h2>الاستقطاعات</h2>
      <table>${dedRows}</table>
    </div>
  </div>
  <div class="net">صافي الراتب: ${fmtVal(values.excelNet)}</div>
</body>
</html>`;
}

async function htmlToPdfBase64(html: string): Promise<string> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    return Buffer.from(pdf).toString('base64');
  } finally {
    await browser.close();
  }
}

async function loadLineWithPayroll(lineId: string) {
  const line = await prisma.payrollLine.findUnique({
    where: { id: lineId },
    include: {
      employee: { include: { department: true, workLocation: true } },
      payroll: true,
    },
  });
  if (!line) throw new NotFoundError('Payroll line not found');
  return line;
}

export async function getPayslipDetail(lineId: string) {
  const line = await loadLineWithPayroll(lineId);
  const payroll = {
    id: line.payroll.id,
    name: line.payroll.name ?? '',
    dateFrom: line.payroll.dateFrom,
    dateTo: line.payroll.dateTo,
    shiftGridId: line.payroll.shiftGridId,
    lines: [],
  };
  const values = getPayslipValues(line, payroll, line.sequence || 1);
  return {
    payrollId: line.payrollId,
    payrollName: line.payroll.name ?? '',
    dateFrom: line.payroll.dateFrom.toISOString().slice(0, 10),
    dateTo: line.payroll.dateTo.toISOString().slice(0, 10),
    lineId: line.id,
    employeeId: line.employeeId,
    netSalary: line.netSalary,
    totalEarnings: line.totalEarnings,
    totalDeductions: line.totalDeductions,
    ...values,
  };
}

export async function generatePayslipPdf(lineId: string) {
  const line = await loadLineWithPayroll(lineId);
  const payroll = {
    id: line.payroll.id,
    name: line.payroll.name ?? '',
    dateFrom: line.payroll.dateFrom,
    dateTo: line.payroll.dateTo,
    shiftGridId: line.payroll.shiftGridId,
    lines: [],
  };
  const values = getPayslipValues(line, payroll, line.sequence || 1);
  const html = buildPayslipHtml(values, line.payroll.name ?? '');
  const base64 = await htmlToPdfBase64(html);
  const code = String(line.employeeCode || 'emp').replace(/\//g, '_');
  return exportFileResponse(base64, `payslip_${code}.pdf`.replace(/[^\w.-]/g, '_'));
}

export async function generateAllPayslipsPdf(payrollId: string) {
  const payroll = await prisma.payroll.findUnique({
    where: { id: payrollId },
    include: {
      lines: {
        include: { employee: { include: { department: true, workLocation: true } } },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (!payroll.lines.length) {
    throw new NotFoundError('لا توجد سطور في الكشف');
  }

  const payrollCtx = {
    id: payroll.id,
    name: payroll.name ?? '',
    dateFrom: payroll.dateFrom,
    dateTo: payroll.dateTo,
    shiftGridId: payroll.shiftGridId,
    lines: payroll.lines,
  };

  const parts = payroll.lines.map((line, i) => {
    const values = getPayslipValues(line, payrollCtx, line.sequence || i + 1);
    const html = buildPayslipHtml(values, payroll.name ?? '');
    return `<div class="page-break">${html.replace(/<\/?html[^>]*>/g, '').replace(/<\/?head>[\s\S]*?<\/head>/g, '').replace(/<\/?body[^>]*>/g, '')}</div>`;
  });

  const fontBase64 = getFontBase64();
  const fullHtml = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"/>
  <style>
    @font-face { font-family: 'NotoArabic'; src: url('data:font/ttf;base64,${fontBase64}') format('truetype'); }
    @page { size: A4; margin: 12mm; }
    body { font-family: 'NotoArabic', sans-serif; }
    .page-break { page-break-after: always; }
  </style></head><body>${parts.join('')}</body></html>`;

  const base64 = await htmlToPdfBase64(fullHtml);
  const name = (payroll.name || 'payroll').replace(/\//g, '_');
  return exportFileResponse(base64, `payslips_${name}.pdf`);
}

export { exportFileResponse };
