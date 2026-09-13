/**
 * inspect-files.mjs — يقرأ ملفات Excel الخاصة بجداول الشيفتات ويطبع لكل ملف:
 *   - معرّف الجدول (shift_grid_id) وتاريخ من/إلى واسم الجدول من ورقة _meta
 *   - أسماء الأوراق
 *   - عدد صفوف الموظفين وأكواد الموظفين
 *   - كل قيم الشيفتات (labels) الفريدة الموجودة في الخلايا
 *
 * الاستخدام:
 *   node scripts/shift-sync/inspect-files.mjs <folder>
 * مثال:
 *   node scripts/shift-sync/inspect-files.mjs files_to_sync/1
 *
 * لا يعدّل أي شيء — قراءة فقط.
 */
import ExcelJS from 'exceljs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const folder = resolve(process.argv[2] || 'files_to_sync/1');

function readMeta(wb) {
  const meta = wb.getWorksheet('_meta');
  const map = {};
  if (meta) {
    for (let r = 1; r <= meta.rowCount; r++) {
      const k = String(meta.getCell(r, 1).value ?? '').trim().toLowerCase();
      const v = String(meta.getCell(r, 2).value ?? '').trim();
      if (k) map[k] = v;
    }
  }
  return map;
}

function dataSheet(wb) {
  return (
    wb.worksheets.find((w) => w.name === 'جدول الشيفتات') ??
    wb.worksheets.find((w) => !w.name.startsWith('_') && w.name !== 'مرجع الشيفتات') ??
    wb.worksheets[0]
  );
}

const files = readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.xlsx'));

for (const file of files.sort()) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(folder, file));
  const meta = readMeta(wb);
  const sheet = dataSheet(wb);

  const codes = new Set();
  const labels = new Set();
  let headerRow = -1;

  // نحاول نكتشف صف العناوين (أول صف فيه "كود" أو "code")
  sheet.eachRow((row, rowNumber) => {
    const first = String(row.getCell(1).value ?? '').trim();
    if (headerRow === -1 && /كود|code/i.test(first)) headerRow = rowNumber;
  });

  sheet.eachRow((row, rowNumber) => {
    if (headerRow !== -1 && rowNumber <= headerRow) return;
    const code = String(row.getCell(1).value ?? '').trim();
    if (!code) return;
    codes.add(code);
    // بقية الأعمدة = خلايا الأيام
    row.eachCell((cell, colNumber) => {
      if (colNumber <= 2) return; // كود + اسم
      const v = String(cell.value ?? '').trim();
      if (v) labels.add(v);
    });
  });

  console.log('='.repeat(70));
  console.log('FILE:', file);
  console.log('  shift_grid_id:', meta.shift_grid_id || meta.grid_id || '(none)');
  console.log('  grid_name    :', meta.grid_name || meta.name || '(none)');
  console.log('  date_from    :', meta.date_from || '(none)');
  console.log('  date_to      :', meta.date_to || '(none)');
  console.log('  sheets       :', wb.worksheets.map((w) => w.name).join(', '));
  console.log('  employees    :', codes.size);
  console.log('  shift labels :', [...labels].sort().join(' | '));
}
console.log('='.repeat(70));
console.log(`Total files: ${files.length}`);
