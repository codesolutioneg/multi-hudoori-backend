/**
 * س1 / س6 PDF — Nova-style HTML print layout (2 A4 pages) via Puppeteer.
 * Digit boxes, money tables, section chips, tracking table, instructions + إقرار.
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

function resolveInsuranceLogoPath(): string | null {
  const dirs = [
    path.join(process.cwd(), 'assets/logos'),
    path.resolve(__dirname, '../../assets/logos'),
    path.resolve(__dirname, '../../../assets/logos'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const hit = fs
      .readdirSync(dir)
      .find((f) => /تأمين|التامين|insurance|\.png$/i.test(f) && f.endsWith('.png'));
    if (hit) return path.join(dir, hit);
    const anyPng = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.png'));
    if (anyPng) return path.join(dir, anyPng);
  }
  return null;
}

let logoDataUriCache: string | null | undefined;
/** Circular NOSI logo as data-URI for print header (Nova-style center). */
function getLogoDataUri(): string | null {
  if (logoDataUriCache !== undefined) return logoDataUriCache;
  const logoPath = resolveInsuranceLogoPath();
  if (!logoPath || !fs.existsSync(logoPath)) {
    logoDataUriCache = null;
    return null;
  }
  const b64 = fs.readFileSync(logoPath).toString('base64');
  logoDataUriCache = `data:image/png;base64,${b64}`;
  return logoDataUriCache;
}

function logoHtml(logoSrc: string | null): string {
  if (!logoSrc) return '';
  return `<div class="top-logo"><img src="${logoSrc}" alt="الهيئة القومية للتأمين الاجتماعي" /></div>`;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function p(payload: Record<string, unknown>, key: string, fallback = ''): string {
  const v = payload[key];
  if (v === null || v === undefined || String(v).trim() === '') return esc(fallback);
  return esc(v);
}

function digitsOnly(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

/** Nova fills boxes RTL: reverse digit string, pad to len. */
function digitBoxes(value: unknown, len: number): string {
  const raw = digitsOnly(value);
  const reversed = [...raw].reverse().join('');
  const chars: string[] = [];
  for (let i = 0; i < len; i++) chars.push(reversed[i] ?? '');
  return chars
    .map((ch) => `<span class="dbox">${ch ? esc(ch) : ''}</span>`)
    .join('');
}

function emptyBoxes(len: number): string {
  return Array.from({ length: len }, () => '<span class="dbox"></span>').join('');
}

/** Split amount into قرش (2) + جنيه (5) boxes — Nova style. */
function moneyBoxes(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) {
    return `<table class="money"><tbody>
      <tr><td>قرش</td><td>جنيه</td></tr>
      <tr><td>${emptyBoxes(2)}</td><td>${emptyBoxes(5)}</td></tr>
    </tbody></table>`;
  }
  const pounds = Math.floor(Math.abs(n));
  const pennies = Math.round((Math.abs(n) - pounds) * 100);
  return `<table class="money"><tbody>
    <tr><td>قرش</td><td>جنيه</td></tr>
    <tr>
      <td>${digitBoxes(String(pennies).padStart(2, '0'), 2)}</td>
      <td>${digitBoxes(String(pounds), 5)}</td>
    </tr>
  </tbody></table>`;
}

/** DD / MM / YYYY digit boxes with slash dividers. */
function dateBoxes(value: unknown): string {
  const s = String(value ?? '').trim();
  let d = '', m = '', y = '';
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (iso) {
    y = iso[1];
    m = iso[2];
    d = iso[3];
  } else if (dmy) {
    d = dmy[1].padStart(2, '0');
    m = dmy[2].padStart(2, '0');
    y = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
  }
  if (!d && !m && !y) {
    return `${emptyBoxes(2)}<span class="slash">/</span>${emptyBoxes(2)}<span class="slash">/</span>${emptyBoxes(4)}`;
  }
  return `${digitBoxes(d, 2)}<span class="slash">/</span>${digitBoxes(m, 2)}<span class="slash">/</span>${digitBoxes(y, 4)}`;
}

function dots(n = 40): string {
  return '.'.repeat(n);
}

function sectionChip(label: string): string {
  return `<div class="chip-row"><span class="chip">${esc(label)}</span></div>`;
}

function trackingTable(headers: string[]): string {
  return `<table class="track">
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>
      <tr><td class="bold">الاسم</td><td></td><td></td><td></td><td></td></tr>
      <tr><td class="bold">التوقيع</td><td></td><td></td><td></td><td></td></tr>
      <tr><td class="bold">التاريخ</td><td></td><td></td><td></td><td></td></tr>
    </tbody>
  </table>`;
}

function sharedCss(fontBase64: string): string {
  return `
@font-face {
  font-family: 'FormArabic';
  src: url('data:font/ttf;base64,${fontBase64}') format('truetype');
}
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  font-family: 'FormArabic', Tahoma, 'Segoe UI', sans-serif;
  direction: rtl;
  color: #000;
  font-size: 13px;
  line-height: 1.45;
  background: #fff;
  font-weight: 700;
}
.page {
  width: 210mm;
  min-height: 297mm;
  padding: 14mm 12mm 10mm;
  page-break-after: always;
}
.page:last-child { page-break-after: auto; }
.bold { font-weight: 700; }
.top {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  border-bottom: 1.5px solid #000;
  padding-bottom: 6px;
  margin-bottom: 8px;
  gap: 8px;
}
.top .right { text-align: right; }
.top .left { text-align: left; }
.top .right p, .top .left p { margin: 0 0 2px; font-size: 13px; }
.top-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
}
.top-logo img {
  width: 52px;
  height: 52px;
  object-fit: contain;
}
.form-title {
  text-align: center;
  font-size: 15px;
  margin: 6px 0 10px;
  padding-bottom: 4px;
}
.form-title span {
  border-bottom: 1px solid #000;
  padding-bottom: 2px;
}
.dbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 18px;
  border: 1px solid #000;
  margin-left: -1px;
  font-size: 11px;
  font-weight: 700;
  vertical-align: middle;
}
.slash { display: inline-block; margin: 0 3px; font-weight: 700; }
.row { margin: 5px 0; }
.inline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; }
.chip-row {
  display: flex;
  align-items: center;
  margin: 12px 0 8px;
  gap: 8px;
}
.chip-row::before, .chip-row::after {
  content: '';
  flex: 1;
  border-top: 1px solid #000;
}
.chip {
  display: inline-block;
  padding: 2px 28px;
  border: 1px solid #000;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
}
table.money {
  display: inline-table;
  border-collapse: collapse;
  vertical-align: middle;
  font-size: 10px;
}
table.money td {
  border: 1px solid #000;
  padding: 1px 3px;
  text-align: center;
}
table.cats {
  width: 100%;
  border-collapse: collapse;
  margin: 4px 0 8px;
  font-size: 12px;
}
table.cats td { padding: 2px 4px; vertical-align: middle; }
.cat-num {
  display: inline-flex;
  width: 18px; height: 18px;
  border: 1px solid #000;
  align-items: center;
  justify-content: center;
  margin-left: 4px;
  font-size: 11px;
}
table.track {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 11px;
}
table.track th, table.track td {
  border: 1px solid #000;
  padding: 4px 3px;
  text-align: center;
  min-height: 22px;
}
table.track th { background: #fff; }
.note-line { margin: 6px 0; font-size: 12px; }
.guide { margin: 8px 0; }
.guide h3 {
  margin: 0 0 8px;
  font-size: 14px;
  text-align: center;
  border-bottom: 1px solid #000;
  display: inline-block;
}
.guide p, .decl p {
  margin: 6px 0;
  font-size: 11.5px;
  line-height: 1.55;
  font-weight: 700;
}
.sig-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin: 14px 0;
  text-align: center;
}
.sig-blank { margin-top: 6px; letter-spacing: 2px; }
.stamp {
  width: 120px;
  height: 50px;
  border: 1px solid #000;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.hr { border: none; border-top: 1px solid #000; margin: 8px 0; }
.muted-dots { letter-spacing: 1px; }
.small { font-size: 11px; }
.job-code { display: inline-flex; align-items: center; gap: 4px; }
`;
}

function buildS1Html(
  payload: Record<string, unknown>,
  fontBase64: string,
  logoSrc: string | null,
): string {
  const category = String(payload.subscriptionCategory ?? 'عاملين لدى الغير');
  const cat1 = category.includes('عاملين') || category === '1' || !category;
  const office = p(payload, 'office', '..................');
  const estName = p(payload, 'establishmentName');
  const estNo = payload.establishmentInsuranceNumber;
  const tax = payload.taxRegistrationNumber;
  const empName = p(payload, 'employeeName');
  const nationality = p(payload, 'nationality', 'مصرى');
  const qualification = p(payload, 'qualification');
  const jobTitle = p(payload, 'jobTitle');
  const jobCode = payload.jobCode ?? payload.insuJobCode ?? '';
  const basic = payload.basicSalary ?? payload.mainSalaryNew ?? '';
  const subWage = payload.subscriptionWage ?? payload.mainSalary ?? '';
  const totalWage = payload.totalWage ?? payload.insGrossSalary ?? '';
  const phone = p(payload, 'phone', dots(28));
  const email = p(payload, 'email', dots(28));

  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"/><style>${sharedCss(fontBase64)}</style></head><body>
<section class="page">
  <div class="top">
    <div class="right">
      <p>الهيئة القومية للتأمين الاجتماعي</p>
      <p>مكتب &nbsp;${office}</p>
    </div>
    ${logoHtml(logoSrc)}
    <div class="left">
      <p>نموذج رقم (١)</p>
    </div>
  </div>
  <div class="form-title"><span>طلب أشتراك مؤمن عليه</span></div>

  <table class="cats">
    <tr>
      <td><span>الفئة :</span></td>
      <td><span class="cat-num">١</span> عاملين لدى الغير ${cat1 ? '✓' : ''}</td>
      <td></td>
      <td><span class="cat-num">٢</span> أصحاب أعمال</td>
      <td></td>
    </tr>
    <tr>
      <td></td>
      <td><span class="cat-num">٣</span> المصريين بالخارج</td>
      <td></td>
      <td><span class="cat-num">٤</span> عمالة غير منتظمة</td>
      <td></td>
    </tr>
  </table>

  <div class="row inline">
    <span>رقم المنشأة:</span>
    <span>${digitBoxes(estNo, 8)}</span>
  </div>
  <div class="row grid2">
    <div>اسم المنشأة: &nbsp;${estName || dots(60)}</div>
    <div>رقم التسجيل الضريبى للمنشأة : &nbsp;${
      tax
        ? digitBoxes(tax, 9)
        : `${dots(12)} / ${dots(12)} / ${dots(12)}`
    }</div>
  </div>

  ${sectionChip('بيانات المؤمن عليه')}

  <div class="row inline"><span>الرقم التأميني:</span>${digitBoxes(payload.insuranceNumber, 9)}</div>
  <div class="row inline"><span>الرقم القومي:</span>${digitBoxes(payload.nationalId, 14)}</div>
  <div class="row">اسم المؤمن عليه: &nbsp;${empName || dots(40)}&nbsp;&nbsp; الجنسية: &nbsp;${nationality}</div>
  <div class="row inline">
    <span>المؤهل: &nbsp;${qualification || dots(16)}</span>
    <span class="job-code">كود المهنة: ${digitBoxes(jobCode, 6)}</span>
    <span>المسمى: &nbsp;${jobTitle || dots(24)}</span>
  </div>
  <div class="row inline">
    <span>تاريخ بدء الاشتراك:</span>
    ${dateBoxes(payload.subscriptionStartDate ?? payload.insuranceDate)}
  </div>
  <div class="row inline small">
    <span>نوع المدة ${emptyBoxes(2)} المسمى: ${dots(30)}</span>
    <span>كود الاشتراك ${emptyBoxes(2)}</span>
    <span>المسمى: ${dots(12)} القطاع: ${p(payload, 'sector', dots(12))}</span>
  </div>

  <div class="row inline" style="margin-top:8px;align-items:flex-start">
    <span>* أجر اساسي :</span>${moneyBoxes(basic)}
    <span>*أجر /دخل الاشتراك :</span>${moneyBoxes(subWage)}
    <span>*الأجر الشامل :</span>${moneyBoxes(totalWage)}
  </div>
  <div class="row grid2 small">
    <div>(لحساب 7%وفقا لقانون العمل)</div>
    <div>(لحساب اشتراك التأمين الصحي الشامل)</div>
  </div>

  <div class="row small">صلة القرابة بصاحب العمل : ${emptyBoxes(1)} &nbsp; ${dots(20)}
    <span>*تستوفى للأقارب حتى الدرجة الثانية بالمنشآت الفردية.</span>
  </div>
  <div class="row inline small">
    بيانات العجز إن وجدت:تاريخ بداية العجز:
    ${dateBoxes(payload.disabilityStartDate)}
    &nbsp;نسبة العجز:${p(payload, 'disabilityRate', dots(8))}%
  </div>

  ${sectionChip('بيانات محل إقامة المؤمن عليه')}

  <div class="grid2">
    <div>
      <div class="row bold" style="text-align:center">العنوان داخل مصر</div>
      <div class="row inline">عقار رقم : ${digitBoxes(payload.buildingNumber, 4)}</div>
      <div class="row inline">شياخة / قرية : ${digitBoxes(payload.village, 2)} &nbsp; ${p(payload, 'village', '')}</div>
      <div class="row">شارع / حارة : ${p(payload, 'street', dots(50))}</div>
      <div class="row inline">قسم / مركز : ${digitBoxes(payload.district, 2)} &nbsp; ${p(payload, 'district', '')}
        &nbsp;&nbsp; محافظة : ${digitBoxes(payload.governorate, 2)} &nbsp; ${p(payload, 'governorate', '')}
      </div>
    </div>
    <div>
      <div class="row bold" style="text-align:center">العنوان خارج مصر</div>
      <div class="row">الدولة : ${dots(20)}</div>
      <div class="row">المدينة : ${dots(20)}</div>
      <div class="row">جهة العمل : ${dots(28)}</div>
    </div>
  </div>

  <div class="grid2" style="margin-top:10px">
    <div>توقيع المؤمن عليه : ${dots(40)}</div>
    <div>توقيع المدير المسؤل : ${dots(28)}</div>
  </div>
  <div class="row">رقم التليفون : ${phone}</div>
  <div class="row">البريد الإلكتروني : ${email}</div>
  <div class="row">تحريرا في: &nbsp;&nbsp; ${dateBoxes(payload.issueDate)}</div>
  <div class="row" style="text-align:left">تم مطابقة التوقيع بمعرفتي : ${dots(28)}</div>

  ${trackingTable(['البيان', 'مستلم الطلب', 'المراجـــع', 'سجل آليا بمعرفة', 'روجـع آليا بمعرفة'])}
  <p class="note-line">ملحوظة: على صاحب العمل والعامل الإطلاع على التوجيهات الموضحة خلف النموذج مع التوقيع على الإقرار.  (أنظر خلفه)</p>
</section>

<section class="page">
  <div class="guide">
    <div style="text-align:center"><h3>إرشـــــادات</h3></div>
    <p>١. على صاحب العمل بالقطاع الخاص آن يرسل هذا النموذج من أصل وصورتين بالنسبة لكل مــن العاملين لديه مع طلب اشتراكه فى الهيئة لأول مرة وخلال أسبوعين على الاكثر من تاريخ التحاق أي عامل جديد بالعمل لديه سواءً كان التحاقا نهائيا أو تحت الاختبار .</p>
    <p>٢. يرفق بالنموذج لدى اشتراك المؤمن عليه لأول مرة بالهيئة صورة شهادة الميلاد المميكنة وصورة بطاقة الرقم القومي أو صورة جواز السغر يتـــم مطابقتها على الأصل بمعرفة الموظف المختص .</p>
    <p>٣. التوقيع على هذا النموذج بما يفيد الإطلاع والمواققة على جميع البيانات الواردة به ولا يجوز لمــــن وقع عليه آن يعارض في تلك البيانات آمام الهيئة وله آن يلجاً إلى مكتب علاقات العمل المختص أو القضاء .</p>
    <p>٤. يستخدم هذا النموذج كطلب اشتراك في تأمين إصابات العمل فقط بالنسبة للغئات التالية:</p>
    <p>(أ) من تجاوز سن الشيخوخة وأوقف انتفاعه بتأمين الشيخوخة والعجز والوفاة.</p>
    <p>(ب) العاملون الذين يخضعون لأحكام قانون العمل ممن تقل أعمارهم عن ١٨ سنة.</p>
    <p>(ج) العاملون المتدرجون والتلاميذ الصناعيون والطلاب المشتغلون في مشروعات التشغيل الصيفي والخدمة العامة.</p>
    <p>(د) يقتصر استيفاء الأجر على الفئات التي يتقاضى فيها المؤمن عليه أجرا من صاحب العمل.</p>
  </div>

  <div class="decl">
    <div style="text-align:center;margin:12px 0 8px"><h3 style="display:inline-block;border-bottom:1px solid #000;margin:0;font-size:14px">إقــــــــرار</h3></div>
    <div class="row">اسم المنشأة: &nbsp;${estName}&nbsp; رقمها التأميني: &nbsp;${esc(String(estNo ?? ''))}</div>
    <div class="row">العنــوان: &nbsp;${p(payload, 'establishmentAddress')}</div>
    <p>أقر أنا الموقع علــى هـذا النمـوذج بــالالتزام بعرض المـؤمن عليـه علـى اللجنـة الطبيـة المختصـة بالهيئـة المعنيةبالتأمين الصحى أو الجهة الطبية المختصة لإجراء الفحص الطبي الأولى وإثبات حالته الصحية وقت توقيع الكشف الطبي مع الالتزام بموافاة مكتب الهيئة التابع له المشأة بتقرير اللياقة الطبية الصادر من الجهة الطبية المختصة عن حالته الصحية خلالأسبوعين على الأكثر من تاريخ التحاقه بالعمل تطبيقالأحكام قانون العمل.</p>
    <p style="text-align:center;margin-top:16px">توقيع (صاحب العمل / المدير المسئول)</p>
    <p class="sig-blank" style="text-align:center">( &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; )</p>
    <p>١ ـ أقر أنا &nbsp;${empName || dots(40)}&nbsp; العامل بالمنشأة عاليه بأن أثبت حالتي الصحية أمام اللجنة الطبية المختصة بالهيئة المعنية بالتأمين الصحي أو الجهة الطبية المختصة وموافاة مكتب الهيئة التابع له المنشـــأة بالتقرير الطبي عن حالتي الصحية خلال أسبوعين من تاريخ التحاقي بالعمل وفي حالة عـدم قيامي بذالك فـإن الهيئة القومية للتأمين الاجتماعي ليس عليها آدنــى التزام قانونــي بصرف أيـة مستحقات تأمينية تترتب على العجز أيا كان نوعه السابق أو المعاصر لتاريخ الالتحاق بالعمل .</p>
    <p style="text-align:center;margin-top:16px">توقيع المؤمن عليه</p>
    <p class="sig-blank" style="text-align:center">( &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; )</p>
  </div>
</section>
</body></html>`;
}

function buildS6Html(
  payload: Record<string, unknown>,
  fontBase64: string,
  logoSrc: string | null,
): string {
  const office = p(payload, 'office', '..................');
  const estName = p(payload, 'establishmentName');
  const estNo = payload.establishmentInsuranceNumber;
  const empName = p(payload, 'employeeName');
  const endReason = p(payload, 'endReason', '..................');

  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"/><style>${sharedCss(fontBase64)}</style></head><body>
<section class="page">
  <div class="top">
    <div class="right">
      <p>الهيئة القومية للتأمين الاجتماعي</p>
      <p>صندوق العاملين ب ..................</p>
      <p>منطقة : ..................</p>
      <p>مكتب : ${office}</p>
    </div>
    ${logoHtml(logoSrc)}
    <div class="left">
      <p>نموذج رقم (٦) قرار وزاري رقم (٥٥٤) لسنة ٢٠٠٧</p>
      <div class="inline" style="margin-top:6px">
        <span>وحدة : ..................</span>
        ${emptyBoxes(2)}
      </div>
    </div>
  </div>

  <div class="form-title"><span>إخطار بإنتهاء اشتراك مؤمن عليه</span></div>

  <div class="row inline">
    <span>رقـــم المنشــأة</span>
    ${digitBoxes(estNo, 8)}
  </div>
  <div class="row">مسمـــى : ${estName}</div>
  <div class="row">رقم التسجيل الضريبى للمنشأة : ${
    payload.taxRegistrationNumber
      ? digitBoxes(payload.taxRegistrationNumber, 9)
      : ''
  }</div>

  ${sectionChip('بيانات المؤمن عليه')}

  <div class="row inline"><span>الرقم التأميني : </span>${digitBoxes(payload.insuranceNumber, 8)}</div>
  <div class="row inline"><span>الرقم القومي : </span>${digitBoxes(payload.nationalId, 14)}</div>
  <div class="row">الاسم : ${empName}</div>
  <div class="row inline">
    <span>تاريخ انتهاء الاشتراك</span>
    ${dateBoxes(payload.subscriptionEndDate ?? payload.departureDate)}
    <span style="margin-right:16px">سبب انتهاء الاشتراك</span>
    <span>${endReason}</span>
    ${emptyBoxes(1)}
  </div>

  ${sectionChip('بيانات محل اقامة المؤمن عليه')}

  <div class="row inline">
    <span> عقار رقم : </span>${digitBoxes(payload.buildingNumber, 4)}
    <span> شارع/حارة : </span>
    <span class="muted-dots">${p(payload, 'street', dots(60))}</span>
  </div>
  <div class="row inline">
    <span> شياخة/قرية </span><span>${p(payload, 'village', dots(16))}</span>${digitBoxes(payload.villageCode ?? '', 2)}
    <span> قسم/مركز </span><span>${p(payload, 'district', dots(16))}</span>${digitBoxes(payload.districtCode ?? '', 2)}
    <span> محافظة </span><span>${p(payload, 'governorate', dots(16))}</span>${digitBoxes(payload.governorateCode ?? '', 2)}
  </div>

  ${sectionChip('إقــرار المؤمن عليه والمدير المسئول')}
  <p class="note-line">أقــر أن البيانات بعالية صحيحة وأن المؤمن عليه تسلم صورة من هذا الإخطار.</p>
  <div class="grid2">
    <div>
      توقيع المؤمن عليه ${dots(28)}
      <div class="inline" style="margin-top:4px">&nbsp;/&nbsp;/&nbsp;٢٠</div>
    </div>
    <div>
      توقيع المدير المسئول ${dots(28)}
      <div class="inline" style="margin-top:4px">&nbsp;/&nbsp;/&nbsp;٢٠</div>
    </div>
  </div>
  <div class="row" style="margin-top:8px">تم مطابقة التوقيع بمعرفتي/ ${dots(28)}</div>

  ${sectionChip('إقــرار المدير المسئول في حالة وجود نزاع')}
  <p class="note-line">أقــر أن البيانات بعالية صحيحة وإنني أرسلت صورة من هذا الإخطار إلى المؤمن عليه بخطاب موصى عليه بعلم</p>
  <div class="row inline">
    الوصول برقم ${dots(28)}
    بتاريخ &nbsp;/&nbsp;/&nbsp;٢٠
  </div>
  <div class="grid2" style="margin-top:12px;align-items:center">
    <div class="stamp">خاتـــم الجهــة</div>
    <div>
      توقيع المدير المسئول ${dots(28)}
      <div class="inline" style="margin-top:4px">&nbsp;/&nbsp;/&nbsp;٢٠</div>
    </div>
  </div>

  <hr class="hr"/>
  ${trackingTable(['البيان', 'مستلم الاخطار', 'المراجع', 'مسجل الي', 'مراجع الي'])}
  <hr class="hr"/>
  <div class="row inline">
    <span style="border-bottom:1px solid #000">ملحوظة:</span>
    <span>يلزم التأكد من توقيع كل من العامل وصاحب العمل على الإقرار الموضح خلف الاستمارة.</span>
  </div>
  <p class="note-line">(أنظــر خلفه)</p>
</section>

<section class="page">
  <div class="guide">
    <div style="text-align:center"><h3>ارشادات</h3></div>
    <p>١. تحرر هذه الاستمارة من أصل وصورتين، يُرسل الأصل إلى مكتب التأمينات المختص خلال أسبوع من تاريخ انتهاء الخدمة، ويحتفظ صاحب العمل بصورة، وتُسلم صورة للعامل بعد توقيعه أو تُرسل له بخطاب مسجل بعلم الوصول خلال 24 ساعة من إرسالها للمكتب في حالة رفضه التوقيع.</p>
    <p>٢. في حالة التأخير في تقديم هذه الاستمارة، يلتزم صاحب العمل بأداء مبلغ إضافي يقدر بنسبة 20% من قيمة الاشتراك المستحق عن الأجر الأساسي في الشهر الأخير من مدة الاشتراك، عن كل شهر تأخير في الإخطار من تاريخ انتهاء الخدمة حتى تاريخ إرسال الاستمارة، مع حذف كسور الشهر.</p>
  </div>

  <div class="decl">
    <div style="text-align:center;margin:14px 0 8px"><h3 style="display:inline-block;border-bottom:1px solid #000;margin:0;font-size:14px">اقرار</h3></div>
    <div class="grid2">
      <div>اسم المنشأة : ${estName}</div>
      <div class="inline">رقمها التأميني : ${digitBoxes(estNo, 8)}</div>
    </div>
    <div class="row">العنوان : ${p(payload, 'establishmentAddress')}</div>
    <div class="grid2">
      <div>اسم المؤمن عليه : ${empName}</div>
      <div class="inline">رقمه التأميني : ${digitBoxes(payload.insuranceNumber, 8)}</div>
    </div>

    <p style="margin-top:12px">١. أقر أنا الموقع أدناه بأنني قد قمت بسحب البطاقة العلاجية من المؤمن عليه وتم تسليمها لفرع الهيئة العامة للتأمين الصحي المختص. وفي حالة ظهور ما يخالف ذلك، أكون مسئولًا بالتضامن مع العامل في مواجهة الهيئة العامة للتأمين الصحي عن كافة مصاريف العلاج والرعاية الطبية تعويضًا عن الانتفاع بدون وجه حق بمزايا العلاج والرعاية الطبية بعد انتهاء الخدمة.</p>
    <div class="sig-pair">
      <div>توقيع المؤمن عليه<div class="sig-blank">( &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; )</div></div>
      <div>توقيع صاحب العمل<div class="sig-blank">( &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; )</div></div>
    </div>

    <p>٢. أقر أنا الموقع أدناه بأن المؤمن عليه محل هذه الاستمارة قد رفض تسليم البطاقة العلاجية، وقمنا بإخطار الهيئة العامة للتأمين الصحي ببيانات المؤمن عليه لإيقاف التعامل معه.</p>
    <div class="sig-pair">
      <div></div>
      <div>توقيع صاحب العمل<div class="sig-blank">( &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; )</div></div>
    </div>
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
  const logoSrc = getLogoDataUri();
  const html =
    input.formType === InsuranceFormType.S1
      ? buildS1Html(input.payload, fontBase64, logoSrc)
      : buildS6Html(input.payload, fontBase64, logoSrc);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
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
