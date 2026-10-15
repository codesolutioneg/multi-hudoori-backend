/**
 * Official-style س1 / س6 PDF (2 A4 pages) via Puppeteer + Arabic font.
 */
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { InsuranceFormType } from '@prisma/client';

function resolveArabicFontPath(): string {
  const candidates = [
    path.join(process.cwd(), 'assets/fonts/NotoSansArabic-Regular.ttf'),
    path.resolve(__dirname, '../../assets/fonts/NotoSansArabic-Regular.ttf'),
    path.resolve(__dirname, '../../../assets/fonts/NotoSansArabic-Regular.ttf'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

let fontBase64Cache: string | null = null;
function getFontBase64(): string {
  if (!fontBase64Cache) {
    const fontPath = resolveArabicFontPath();
    if (!fs.existsSync(fontPath)) {
      throw new Error(`Arabic font missing at ${fontPath}`);
    }
    fontBase64Cache = fs.readFileSync(fontPath).toString('base64');
  }
  return fontBase64Cache;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function p(payload: Record<string, unknown>, key: string): string {
  return esc(payload[key]);
}

function digitBoxes(value: unknown, len: number): string {
  const s = String(value ?? '').replace(/\D/g, '');
  const padded = s.padStart(len, ' ').slice(-len);
  return [...padded]
    .map(
      (ch) =>
        `<span class="dbox">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`,
    )
    .join('');
}

function check(on: boolean): string {
  return on ? '✔' : '';
}

function sharedCss(fontBase64: string): string {
  return `
@font-face {
  font-family: 'NotoArabic';
  src: url('data:font/ttf;base64,${fontBase64}') format('truetype');
}
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  font-family: 'NotoArabic', Tahoma, sans-serif;
  direction: rtl;
  color: #111;
  font-size: 11px;
  background: #fff;
}
.page {
  width: 210mm;
  min-height: 297mm;
  padding: 12mm 12mm 10mm;
  page-break-after: always;
  position: relative;
}
.page:last-child { page-break-after: auto; }
.header {
  text-align: center;
  border-bottom: 2px solid #1a3a6b;
  padding-bottom: 6px;
  margin-bottom: 10px;
}
.header h1 { margin: 0; font-size: 15px; color: #1a3a6b; }
.header h2 { margin: 4px 0 0; font-size: 13px; font-weight: 700; }
.row { display: flex; gap: 8px; align-items: center; margin: 5px 0; flex-wrap: wrap; }
.label { font-weight: 700; min-width: 90px; }
.field {
  flex: 1;
  border-bottom: 1px solid #333;
  min-height: 18px;
  padding: 1px 4px;
}
.box {
  border: 1px solid #333;
  padding: 8px;
  margin: 8px 0;
  border-radius: 2px;
}
.box-title {
  font-weight: 700;
  margin: -8px -8px 8px;
  padding: 4px 8px;
  background: #eef2f8;
  border-bottom: 1px solid #333;
}
.dbox {
  display: inline-block;
  width: 14px;
  height: 16px;
  border: 1px solid #333;
  text-align: center;
  line-height: 16px;
  margin-left: 1px;
  font-size: 10px;
}
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; }
.check { display: inline-block; width: 14px; height: 14px; border: 1px solid #333; text-align: center; line-height: 12px; margin-left: 4px; }
.muted { color: #555; font-size: 10px; }
.sign {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin-top: 28px;
}
.sign .line { border-top: 1px solid #333; margin-top: 36px; padding-top: 4px; text-align: center; }
.notes li { margin-bottom: 6px; line-height: 1.45; }
.footer-note {
  position: absolute;
  bottom: 8mm;
  left: 12mm;
  right: 12mm;
  font-size: 9px;
  color: #666;
  border-top: 1px dashed #aaa;
  padding-top: 4px;
}
`;
}

function buildS1Html(payload: Record<string, unknown>, fontBase64: string): string {
  const category = String(payload.subscriptionCategory ?? 'عاملين لدى الغير');
  const estType = String(payload.establishmentType ?? 'نمطي');
  const medical = String(payload.medicalExamDone ?? '');
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"/><style>${sharedCss(fontBase64)}</style></head><body>
<section class="page">
  <div class="header">
    <h1>الهيئة القومية للتأمين الاجتماعي</h1>
    <div class="muted">مكتب: <span class="field" style="display:inline-block;min-width:160px">${p(payload, 'office')}</span></div>
    <h2>طلب اشتراك مؤمن عليه — نموذج س1</h2>
  </div>

  <div class="box">
    <div class="box-title">بيانات مقدم الطلب</div>
    <div class="grid2">
      <div class="row"><span class="label">مقدم الطلب</span><span class="field">${p(payload, 'applicantName')}</span></div>
      <div class="row"><span class="label">الصفة</span><span class="field">${p(payload, 'applicantRole')}</span></div>
      <div class="row"><span class="label">رقم تأميني</span><div>${digitBoxes(payload.applicantInsuranceNumber, 10)}</div></div>
      <div class="row"><span class="label">رقم قومي</span><div>${digitBoxes(payload.applicantNationalId, 14)}</div></div>
      <div class="row"><span class="label">تليفون</span><span class="field">${p(payload, 'applicantPhone')}</span></div>
    </div>
  </div>

  <div class="box">
    <div class="box-title">بيانات المؤمن عليه</div>
    <div class="row"><span class="label">الاسم</span><span class="field">${p(payload, 'employeeName')}</span></div>
    <div class="row"><span class="label">الرقم التأميني</span><div>${digitBoxes(payload.insuranceNumber, 10)}</div></div>
    <div class="row"><span class="label">الرقم القومي</span><div>${digitBoxes(payload.nationalId, 14)}</div></div>
    <div class="grid2">
      <div class="row"><span class="label">الجنسية</span><span class="field">${p(payload, 'nationality')}</span></div>
      <div class="row"><span class="label">المؤهل</span><span class="field">${p(payload, 'qualification')}</span></div>
      <div class="row"><span class="label">المهنة</span><span class="field">${p(payload, 'jobTitle')}</span></div>
      <div class="row"><span class="label">تاريخ بدء الاشتراك</span><span class="field">${p(payload, 'subscriptionStartDate')}</span></div>
      <div class="row"><span class="label">القطاع</span><span class="field">${p(payload, 'sector')}</span></div>
      <div class="row"><span class="label">كود الاشتراك</span><span class="field">${p(payload, 'subscriptionCode')}</span></div>
      <div class="row"><span class="label">نوع المدة</span><span class="field">${p(payload, 'durationType')}</span></div>
      <div class="row"><span class="label">أجر الاشتراك</span><span class="field">${p(payload, 'subscriptionWage')}</span></div>
      <div class="row"><span class="label">الأجر الشامل</span><span class="field">${p(payload, 'totalWage')}</span></div>
      <div class="row"><span class="label">رقم التليفون</span><span class="field">${p(payload, 'phone')}</span></div>
    </div>
    <div class="row" style="margin-top:8px">
      <span class="label">فئة الاشتراك</span>
      <span><span class="check">${check(category.includes('عاملين لدى الغير') || category === '1')}</span> عاملين لدى الغير</span>
      <span style="margin-right:12px"><span class="check">${check(category.includes('مخابز') || category === '3')}</span> العاملين بالمخابز</span>
    </div>
  </div>

  <div class="box">
    <div class="box-title">بيانات العجز إن وجدت</div>
    <div class="grid2">
      <div class="row"><span class="label">تاريخ بداية العجز</span><span class="field">${p(payload, 'disabilityStartDate')}</span></div>
      <div class="row"><span class="label">نسبة العجز</span><span class="field">${p(payload, 'disabilityPercent')}</span></div>
      <div class="row"><span class="label">الكشف الطبي</span>
        <span><span class="check">${check(medical === 'نعم' || medical === 'yes')}</span> نعم</span>
        <span style="margin-right:10px"><span class="check">${check(medical === 'لا' || medical === 'no')}</span> لا</span>
      </div>
    </div>
  </div>

  <div class="box">
    <div class="box-title">بيانات المنشأة</div>
    <div class="row"><span class="label">اسم المنشأة</span><span class="field">${p(payload, 'establishmentName')}</span></div>
    <div class="row"><span class="label">الرقم التأميني للمنشأة</span><div>${digitBoxes(payload.establishmentInsuranceNumber, 10)}</div></div>
    <div class="row">
      <span class="label">نوع المنشأة</span>
      <span><span class="check">${check(estType.includes('نمطي'))}</span> نمطي</span>
      <span style="margin-right:12px"><span class="check">${check(estType.includes('سيارة'))}</span> سيارة</span>
    </div>
    <div class="grid2">
      <div class="row"><span class="label">عقار رقم</span><span class="field">${p(payload, 'buildingNumber')}</span></div>
      <div class="row"><span class="label">شارع</span><span class="field">${p(payload, 'street')}</span></div>
      <div class="row"><span class="label">قرية</span><span class="field">${p(payload, 'village')}</span></div>
      <div class="row"><span class="label">قسم / مركز</span><span class="field">${p(payload, 'district')}</span></div>
      <div class="row"><span class="label">محافظة</span><span class="field">${p(payload, 'governorate')}</span></div>
      <div class="row"><span class="label">عنوان المنشأة</span><span class="field">${p(payload, 'establishmentAddress')}</span></div>
    </div>
  </div>

  <div class="sign">
    <div><div class="line">توقيع المؤمن عليه</div></div>
    <div><div class="line">توقيع صاحب العمل / المدير المسئول</div></div>
  </div>
  <div class="row" style="margin-top:16px"><span class="label">تحريرا في</span><span class="field">${p(payload, 'issueDate')}</span></div>
  <div class="footer-note">بعد قيام مختص الشباك الأمامي برفع المستندات على النظام بمثابة إقرار بمطابقة التوقيع.</div>
</section>

<section class="page">
  <div class="header">
    <h1>الهيئة القومية للتأمين الاجتماعي</h1>
    <h2>إرشادات وإقرار — نموذج س1 (صفحة 2)</h2>
  </div>
  <div class="box">
    <div class="box-title">إرشادات</div>
    <ol class="notes">
      <li>على صاحب العمل أن يرسل هذا النموذج مع طلب اشتراكه في الهيئة لأول مرة وخلال أسبوعين على الأكثر من تاريخ التحاق أي عامل جديد بالعمل.</li>
      <li>التوقيع على هذا النموذج بما يفيد الإطلاع والموافقة على جميع البيانات الواردة به.</li>
      <li>يستخدم هذا النموذج كطلب اشتراك في تأمين إصابات العمل فقط في الحالات المحددة قانونًا.</li>
    </ol>
  </div>
  <div class="box">
    <div class="box-title">إقرار</div>
    <div class="row"><span class="label">اسم المنشأة</span><span class="field">${p(payload, 'establishmentName')}</span></div>
    <div class="row"><span class="label">العنوان</span><span class="field">${p(payload, 'establishmentAddress')}</span></div>
    <p style="line-height:1.55;margin-top:10px">
      أقر أنا الموقع على هذا النموذج بالالتزام بعرض المؤمن عليه
      <strong>${p(payload, 'employeeName')}</strong>
      على اللجنة الطبية المختصة وإثبات حالته الصحية خلال أسبوعين على الأكثر من تاريخ التحاقه بالعمل.
    </p>
  </div>
  <div class="sign">
    <div><div class="line">توقيع المؤمن عليه</div></div>
    <div><div class="line">توقيع صاحب العمل / المدير المسئول</div></div>
  </div>
</section>
</body></html>`;
}

function buildS6Html(payload: Record<string, unknown>, fontBase64: string): string {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"/><style>${sharedCss(fontBase64)}</style></head><body>
<section class="page">
  <div class="header">
    <h1>الهيئة القومية للتأمين الاجتماعي</h1>
    <div class="muted">مكتب: <span class="field" style="display:inline-block;min-width:160px">${p(payload, 'office')}</span></div>
    <h2>إخطار بإنتهاء اشتراك مؤمن عليه — نموذج س6</h2>
  </div>

  <div class="box">
    <div class="box-title">بيانات مقدم الطلب</div>
    <div class="grid2">
      <div class="row"><span class="label">مقدم الطلب</span><span class="field">${p(payload, 'applicantName')}</span></div>
      <div class="row"><span class="label">الصفة</span><span class="field">${p(payload, 'applicantRole')}</span></div>
      <div class="row"><span class="label">رقم تأميني</span><div>${digitBoxes(payload.applicantInsuranceNumber, 10)}</div></div>
      <div class="row"><span class="label">رقم قومي</span><div>${digitBoxes(payload.applicantNationalId, 14)}</div></div>
      <div class="row"><span class="label">تليفون</span><span class="field">${p(payload, 'applicantPhone')}</span></div>
    </div>
  </div>

  <div class="box">
    <div class="box-title">بيانات المؤمن عليه</div>
    <div class="row"><span class="label">الاسم</span><span class="field">${p(payload, 'employeeName')}</span></div>
    <div class="row"><span class="label">الرقم التأميني</span><div>${digitBoxes(payload.insuranceNumber, 10)}</div></div>
    <div class="row"><span class="label">الرقم القومي</span><div>${digitBoxes(payload.nationalId, 14)}</div></div>
  </div>

  <div class="box">
    <div class="box-title">بيانات المنشأة وانتهاء الاشتراك</div>
    <div class="row"><span class="label">اسم المنشأة</span><span class="field">${p(payload, 'establishmentName')}</span></div>
    <div class="row"><span class="label">رقم المنشأة</span><div>${digitBoxes(payload.establishmentInsuranceNumber, 10)}</div></div>
    <div class="row"><span class="label">عنوان المنشأة</span><span class="field">${p(payload, 'establishmentAddress')}</span></div>
    <div class="grid2">
      <div class="row"><span class="label">تاريخ انتهاء الاشتراك</span><span class="field">${p(payload, 'subscriptionEndDate')}</span></div>
      <div class="row"><span class="label">سبب انتهاء الاشتراك</span><span class="field">${p(payload, 'endReason')}</span></div>
      <div class="row"><span class="label">رقم الإخطار</span><span class="field">${p(payload, 'noticeNumber')}</span></div>
      <div class="row"><span class="label">تاريخ الإخطار</span><span class="field">${p(payload, 'noticeDate')}</span></div>
    </div>
  </div>

  <p style="margin-top:14px;line-height:1.5">أقر أن البيانات بعاليه صحيحة وأن المؤمن عليه تسلم صورة من هذا الإخطار.</p>
  <div class="sign">
    <div><div class="line">توقيع المؤمن عليه</div></div>
    <div><div class="line">توقيع المدير المسئول</div></div>
  </div>
  <div class="footer-note">يلزم التأكد من توقيع كل من العامل أو صاحب العمل على الإقرار الموضح خلف النموذج.</div>
</section>

<section class="page">
  <div class="header">
    <h1>الهيئة القومية للتأمين الاجتماعي</h1>
    <h2>إرشادات وإقرار — نموذج س6 (صفحة 2)</h2>
  </div>
  <div class="box">
    <div class="box-title">إرشادات</div>
    <ol class="notes">
      <li>يحرر هذا النموذج ويرسل للهيئة خلال أسبوع من تاريخ تحقق انتهاء خدمة المؤمن عليه أو انتهاء مدة التلمذة/التدرج أو انتهاء العمل بالمشروع الصيفي.</li>
      <li>يلزم مطابقة التوقيع بمعرفته من المدير المسئول.</li>
    </ol>
  </div>
  <div class="box">
    <div class="box-title">إقرار</div>
    <div class="row"><span class="label">اسم المنشأة</span><span class="field">${p(payload, 'establishmentName')}</span></div>
    <div class="row"><span class="label">رقمها التأميني</span><span class="field">${p(payload, 'establishmentInsuranceNumber')}</span></div>
    <div class="row"><span class="label">العنوان</span><span class="field">${p(payload, 'establishmentAddress')}</span></div>
    <div class="row"><span class="label">اسم المؤمن عليه</span><span class="field">${p(payload, 'employeeName')}</span></div>
    <div class="row"><span class="label">رقمه التأميني</span><span class="field">${p(payload, 'insuranceNumber')}</span></div>
  </div>
  <div class="sign">
    <div><div class="line">توقيع المؤمن عليه</div></div>
    <div><div class="line">توقيع صاحب العمل</div></div>
  </div>
</section>
</body></html>`;
}

export async function renderInsuranceFormPdf(input: {
  formType: InsuranceFormType;
  payload: Record<string, unknown>;
  meta?: { employeeName?: string | null; createdAt?: string; createdByName?: string | null };
}): Promise<{ base64: string; filename: string }> {
  const fontBase64 = getFontBase64();
  const html =
    input.formType === InsuranceFormType.S1
      ? buildS1Html(input.payload, fontBase64)
      : buildS6Html(input.payload, fontBase64);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    const label = input.formType === InsuranceFormType.S1 ? 'S1' : 'S6';
    const who = String(input.meta?.employeeName || 'form')
      .replace(/[^\w\u0600-\u06FF-]+/g, '_')
      .slice(0, 40);
    const day = (input.meta?.createdAt || new Date().toISOString()).slice(0, 10);
    return {
      base64: Buffer.from(buf).toString('base64'),
      filename: `insurance_${label}_${who}_${day}.pdf`,
    };
  } finally {
    await browser.close();
  }
}
