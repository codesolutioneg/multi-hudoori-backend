import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer';
import type { HiringAppointment, Location } from '@prisma/client';
import { readCompanyLogoDataUri } from './companyLogo.service';
import { requireCompanyId } from '../tenant/context';

const FONT_PATH = path.resolve(__dirname, '../../assets/fonts/NotoSansArabic-Regular.ttf');

function uploadRoot(): string {
  return path.join(process.cwd(), 'uploads', requireCompanyId(), 'hiring-appointments');
}

export type HiringAppointmentPdfInput = HiringAppointment & { location?: Location | null };

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

function formatDocDate(value: Date): string {
  const d = value.getDate();
  const m = value.getMonth() + 1;
  const y = value.getFullYear();
  return `${d}/${m}/${y}`;
}

function buildHiringAppointmentHtml(appointment: HiringAppointmentPdfInput, logoDataUri?: string | null): string {
  const branchName = appointment.location?.name?.trim() || '—';
  const fontBase64 = getFontBase64();

  const rows: [string, string][] = [
    ['التاريخ', formatDocDate(appointment.appointmentDate)],
    ['السيد/', appointment.employeeName.trim()],
    ['رقم الموبيل', appointment.mobilePhone.trim()],
    ['رقم البطاقة', appointment.nationalId.trim()],
    ['الوظيفة', appointment.jobTitle.trim() || '—'],
    ['الفرع', branchName],
    ['كود البصمه', appointment.fingerprintCode.trim()],
    ['اول يوم عمل', formatDocDate(appointment.firstWorkingDay)],
  ];

  const rowHtml = rows
    .map(([label, value]) => `
      <div class="row">
        <span class="label">${escapeHtml(label)}</span>
        <span class="sep">:</span>
        <span class="value">${escapeHtml(value)}</span>
      </div>`)
    .join('');

  const logoHtml = logoDataUri
    ? `<img class="logo" src="${logoDataUri}" alt="Company logo" />`
    : '';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <style>
    @font-face {
      font-family: 'NotoArabic';
      src: url('data:font/ttf;base64,${fontBase64}') format('truetype');
      font-weight: normal;
      font-style: normal;
    }
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 210mm;
      height: 297mm;
      overflow: hidden;
    }
    body {
      padding: 42px;
      font-family: 'NotoArabic', 'Segoe UI', Tahoma, sans-serif;
      direction: rtl;
      color: #000;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      page-break-after: avoid;
      page-break-inside: avoid;
    }
    .outer {
      border: 1.5px solid #000;
      padding: 8px;
      height: calc(297mm - 84px);
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .inner {
      border: 0.8px solid #000;
      padding: 40px 28px 32px;
      height: 100%;
      break-inside: avoid;
      page-break-inside: avoid;
      position: relative;
    }
    .logo {
      position: absolute;
      top: 12px;
      left: 16px;
      max-height: 56px;
      max-width: 140px;
      object-fit: contain;
    }
    h1 {
      margin: 0 0 36px;
      text-align: center;
      font-size: 22px;
      font-weight: 700;
      text-decoration: underline;
      text-underline-offset: 6px;
    }
    .row {
      display: flex;
      flex-direction: row;
      align-items: baseline;
      justify-content: flex-start;
      gap: 8px;
      margin-bottom: 22px;
      font-size: 16px;
      line-height: 1.6;
    }
    .label { white-space: nowrap; }
    .sep { white-space: nowrap; }
    .value { flex: 1; text-align: right; word-break: break-word; }
  </style>
</head>
<body>
  <div class="outer">
    <div class="inner">
      ${logoHtml}
      <h1>تعيين جديد</h1>
      ${rowHtml}
    </div>
  </div>
</body>
</html>`;
}

export async function generateHiringAppointmentPdf(
  appointment: HiringAppointmentPdfInput,
): Promise<{ relativePath: string; fullPath: string }> {
  const root = uploadRoot();
  await fsPromises.mkdir(root, { recursive: true });
  const filename = `${appointment.id}.pdf`;
  const fullPath = path.join(root, filename);
  const relativePath = filename;

  const logoDataUri = await readCompanyLogoDataUri();
  const html = buildHiringAppointmentHtml(appointment, logoDataUri);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: fullPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close();
  }

  return { relativePath, fullPath };
}

export async function readHiringAppointmentPdf(relativePath: string): Promise<Buffer | null> {
  const fullPath = path.join(uploadRoot(), relativePath);
  try {
    return await fsPromises.readFile(fullPath);
  } catch {
    return null;
  }
}
