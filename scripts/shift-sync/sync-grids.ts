/**
 * sync-grids.ts — استيراد ذكي لملفات Excel الخاصة بجداول الشيفتات إلى جداولها الصحيحة.
 *
 * يعمل بوضعين:
 *   - dry-run  (الافتراضي): قراءة فقط. يطبع لكل ملف الجدول الهدف، الموظفين
 *     المتطابقين/غير الموجودين، وأي «قيم شيفت غير معروفة» — من غير ما يكتب أي حاجة.
 *   - --apply : ينفّذ الاستيراد فعليًا عبر importShiftGridXlsx (بيكتب في قاعدة البيانات).
 *
 * تحديد الجدول الهدف:
 *   1) من ورقة _meta لو موجودة (shift_grid_id).
 *   2) لو الملف مفيهوش _meta: يحل الجدول بالاسم + التواريخ المستخرجة من اسم الملف
 *      (النمط: <Name>_<YYYY-MM-DD>_<YYYY-MM-DD>_<Dept>.xlsx) ثم يختم _meta تلقائيًا.
 *
 * الاستخدام:
 *   npx ts-node scripts/shift-sync/sync-grids.ts <folder>            # dry-run
 *   npx ts-node scripts/shift-sync/sync-grids.ts <folder> --apply    # تنفيذ
 *   npx ts-node scripts/shift-sync/sync-grids.ts <folder> --apply --create-missing
 *
 * الخيارات:
 *   --apply           نفّذ الكتابة (بدونها = معاينة فقط).
 *   --create-missing  أنشئ الموظفين غير الموجودين في القاعدة قبل الاستيراد.
 *
 * ⚠️ يعمل على قاعدة البيانات المحددة في .env (DATABASE_URL). تأكد من البيئة الصحيحة.
 */
import ExcelJS from 'exceljs';
import { readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { prisma } from '../../src/prisma/client';
import { importShiftGridXlsx } from '../../src/services/shiftGridExcel.service';
import { excelLabelToCellFlags } from '../../src/services/shiftGridExcelLabels';

const args = process.argv.slice(2);
const folder = resolve(args.find((a) => !a.startsWith('--')) || 'files_to_sync/1');
const APPLY = args.includes('--apply');
const CREATE_MISSING = args.includes('--create-missing');

/**
 * خريطة القيم القديمة (SH …) → أكواد الشيفتات الحالية في القاعدة.
 * مشتقة من ملفات 26 يوليو (نفس الأقسام) التي كانت محفوظة بالفعل بالأكواد الجديدة:
 *   الصباحي "SH h M" → O.h  ،  الليلي "SH h N" → C.h
 * "SH 12 M" له شيفت مطابق بنفس الاسم فلا يحتاج تحويل.
 * أضف أي قيمة قديمة جديدة هنا فقط.
 */
const LEGACY_LABEL_MAP: Record<string, string> = {
  'SH 6 M - شيفت 6 صباحا': 'O.6',
  'SH 7 M - شيفت ٧  صباحي': 'O.7',
  'SH 7.5 M - شيفت 7.5 صباحي': 'O.7.5',
  'Sh 8 M - شيفت ٨ صباحي': 'O.8',
  'SH 9 M - شيفت ٩ صباحي': 'O.9',
  'SH 1 N - شيفت 1 مساءا': 'B.1',
  'SH 2 N - شيفت 2 مساءا': 'B.2',
  'SH 2.5 N - شيفت 2.5 مساءا': 'B.2.5',
  'SH 3 N - شيفت 3 مساءا': 'C.3',
  'SH 3.5 N - شيفت 3.5 مسائي': 'C.3.5',
  'SH 3.15 N - شيفت 3.15 مساءا': 'C.3.15',
  'SH 10 N - شيفت 10 مساءا': 'C.10',
  'SH 11 N - شيفت 11 مساءا': 'C.11',
  'SH 12 N - شيفت 12 ظهر': 'B.12',
  'SH 12.5 N - شيفت 12.5 ظهر': 'B.12.5',
};

/**
 * أكواد غلط في الإكسيل → الكود المعتمد في النظام.
 * كليفن دوبيزل ظهر بكود 495 في أسبوع 2–8 أغسطس وهو مسجّل عندنا بـ 1050.
 */
const CODE_REMAP: Record<string, string> = {
  '495': '1050',
};

function remapLabel(label: string): string {
  const t = label.trim();
  return LEGACY_LABEL_MAP[t] ?? t;
}

function normCode(v: unknown): string {
  const t = String(v ?? '').trim();
  if (t.endsWith('.0') && /^\d+$/.test(t.slice(0, -2))) return t.slice(0, -2);
  return t;
}

function remapCode(code: string): string {
  return CODE_REMAP[code] ?? code;
}

function readMeta(wb: ExcelJS.Workbook): Record<string, string> {
  const meta = wb.getWorksheet('_meta');
  const map: Record<string, string> = {};
  if (meta) {
    for (let r = 1; r <= meta.rowCount; r++) {
      const k = String(meta.getCell(r, 1).value ?? '').trim().toLowerCase();
      const v = String(meta.getCell(r, 2).value ?? '').trim();
      if (k) map[k] = v;
    }
  }
  return map;
}

function dataSheet(wb: ExcelJS.Workbook): ExcelJS.Worksheet {
  return (
    wb.getWorksheet('جدول الشيفتات') ??
    wb.worksheets.find((w) => !w.name.startsWith('_') && w.name !== 'مرجع الشيفتات') ??
    wb.worksheets[0]
  );
}

/** كل قيم الشيفتات الفريدة + أكواد الموظفين من ورقة الجدول. */
function parseGridSheet(sheet: ExcelJS.Worksheet): { codes: string[]; labels: string[] } {
  let headerRow = -1;
  let codeCol = -1;
  const dayCols: number[] = [];

  sheet.eachRow((row, r) => {
    if (headerRow !== -1) return;
    row.eachCell((cell, col) => {
      const v = String(cell.value ?? '').trim();
      if (v === 'كود الموظف' || /^employee code$/i.test(v)) {
        headerRow = r;
        codeCol = col;
      }
    });
    if (headerRow === r) {
      row.eachCell((cell, col) => {
        if (col > codeCol && String(cell.value ?? '').trim()) dayCols.push(col);
      });
    }
  });

  const codes = new Set<string>();
  const labels = new Set<string>();
  if (headerRow === -1) return { codes: [], labels: [] };

  sheet.eachRow((row, r) => {
    if (r <= headerRow) return;
    const code = remapCode(normCode(row.getCell(codeCol).value));
    if (!code || !/\d/.test(code)) return; // صفوف عناوين الأقسام ليس بها كود رقمي
    codes.add(code);
    for (const col of dayCols) {
      const v = String(row.getCell(col).value ?? '').trim();
      if (v) labels.add(remapLabel(v));
    }
  });

  return { codes: [...codes], labels: [...labels] };
}

function parseNameDates(file: string): { name: string; from: string; to: string } | null {
  const m = basename(file).match(/^(.*)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_/);
  if (!m) return null;
  return { name: m[1], from: m[2], to: m[3] };
}

/** أعد كتابة الأكواد والقيم القديمة داخل الورقة قبل الاستيراد. */
function rewriteSheet(sheet: ExcelJS.Worksheet): { labels: number; codes: number } {
  let headerRow = -1;
  let codeCol = -1;
  const dayCols: number[] = [];
  sheet.eachRow((row, r) => {
    if (headerRow !== -1) return;
    row.eachCell((cell, col) => {
      if (String(cell.value ?? '').trim() === 'كود الموظف') {
        headerRow = r;
        codeCol = col;
      }
    });
    if (headerRow === r) {
      row.eachCell((cell, col) => {
        if (col > codeCol && String(cell.value ?? '').trim()) dayCols.push(col);
      });
    }
  });
  let labels = 0;
  let codes = 0;
  if (headerRow === -1) return { labels, codes };
  sheet.eachRow((row, r) => {
    if (r <= headerRow) return;
    const codeCell = row.getCell(codeCol);
    const raw = normCode(codeCell.value);
    const mappedCode = remapCode(raw);
    if (raw && mappedCode !== raw) {
      codeCell.value = mappedCode;
      codes++;
    }
    for (const col of dayCols) {
      const cell = row.getCell(col);
      const v = String(cell.value ?? '').trim();
      if (!v) continue;
      const mapped = remapLabel(v);
      if (mapped !== v) {
        cell.value = mapped;
        labels++;
      }
    }
  });
  return { labels, codes };
}

/** يعيد كتابة القيم/الأكواد القديمة + يختم _meta ثم يرجّع base64 جاهز للاستيراد. */
async function prepareWorkbook(wb: ExcelJS.Workbook, gridId: string): Promise<string> {
  rewriteSheet(dataSheet(wb));
  let meta = wb.getWorksheet('_meta');
  if (!meta) meta = wb.addWorksheet('_meta');
  meta.getCell(1, 1).value = 'shift_grid_id';
  meta.getCell(1, 2).value = gridId;
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

async function main() {
  console.log(`\nMode: ${APPLY ? '🟥 APPLY (سيكتب في القاعدة)' : '🟩 DRY-RUN (قراءة فقط)'}`);
  console.log(`Folder: ${folder}`);
  console.log(`Create missing employees: ${CREATE_MISSING ? 'نعم' : 'لا'}\n`);

  const shifts = await prisma.shift.findMany();
  const empRows = await prisma.employeeProfile.findMany({ select: { code: true } });
  const knownCodes = new Set(empRows.map((e) => normCode(e.code)).filter(Boolean));

  const files = readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.xlsx')).sort();
  let blocking = 0;

  for (const file of files) {
    const path = join(folder, file);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const meta = readMeta(wb);
    let gridId = meta.shift_grid_id || meta.grid_id || '';
    let resolvedBy = 'meta';

    if (!gridId) {
      const nd = parseNameDates(file);
      if (nd) {
        const matches = await prisma.shiftGrid.findMany({
          where: { name: nd.name, dateFrom: new Date(nd.from), dateTo: new Date(nd.to) },
          select: { id: true, name: true, state: true },
        });
        if (matches.length === 1) {
          gridId = matches[0].id;
          resolvedBy = `name+dates (${nd.name} ${nd.from}→${nd.to})`;
        } else {
          console.log('='.repeat(72));
          console.log('FILE:', file);
          console.log(`  ❌ لا يمكن تحديد الجدول: عدد الجداول المطابقة = ${matches.length}`);
          blocking++;
          continue;
        }
      }
    }

    const grid = gridId
      ? await prisma.shiftGrid.findUnique({
          where: { id: gridId },
          select: { id: true, name: true, state: true, dateFrom: true, dateTo: true },
        })
      : null;

    const { codes, labels } = parseGridSheet(dataSheet(wb));
    const missing = codes.filter((c) => !knownCodes.has(c));
    const unknownLabels = labels.filter((l) => {
      try {
        excelLabelToCellFlags(l, shifts);
        return false;
      } catch {
        return true;
      }
    });

    console.log('='.repeat(72));
    console.log('FILE:', file);
    console.log('  grid       :', grid ? `${grid.name} [${grid.id}] state=${grid.state}` : '❌ غير موجود');
    console.log('  resolvedBy :', resolvedBy);
    console.log('  employees  :', `${codes.length} (متطابق ${codes.length - missing.length} / ناقص ${missing.length})`);
    if (missing.length) console.log('  missing    :', missing.join(', '));
    console.log('  labels     :', labels.length, '— غير معروف:', unknownLabels.length);
    if (unknownLabels.length) console.log('  ⚠ unknown  :', unknownLabels.join(' | '));

    const canApply = grid && grid.state !== 'confirmed' && unknownLabels.length === 0
      && (CREATE_MISSING || missing.length === 0);
    if (!canApply) {
      if (!grid) blocking++;
      else if (grid.state === 'confirmed') { console.log('  ⛔ الجدول مؤكد — يتطلب فتحه للتعديل'); blocking++; }
      else if (unknownLabels.length) { console.log('  ⛔ يوجد قيم غير معروفة — لن يُستورد'); blocking++; }
      else if (missing.length) console.log('  ℹ موظفون ناقصون — استخدم --create-missing لإنشائهم');
    }

    if (APPLY && canApply && grid) {
      const base64 = await prepareWorkbook(wb, grid.id);
      const result = await importShiftGridXlsx(grid.id, base64, {
        createEmployeeCodes: CREATE_MISSING ? missing : [],
      });
      console.log('  ✅ applied :', JSON.stringify({
        updated: result.updated,
        cleared: result.cleared,
        added: result.added,
        createdEmployees: result.createdEmployees,
        skippedCodes: result.skippedCodes,
        errors: result.errors,
      }));
    }
  }

  console.log('='.repeat(72));
  console.log(`Files: ${files.length} — blocking issues: ${blocking}`);
  if (!APPLY) console.log('DRY-RUN فقط. أعد التشغيل مع --apply للتنفيذ.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
