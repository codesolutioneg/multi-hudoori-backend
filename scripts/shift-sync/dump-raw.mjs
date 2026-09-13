/**
 * dump-raw.mjs — طباعة تفصيلية لملف واحد: ورقة «مرجع الشيفتات» (القيم المسموح بها)
 * وأول صفوف «جدول الشيفتات» بأرقام الأعمدة، لفهم مكان الكود/الاسم/الأيام.
 *
 * الاستخدام:
 *   node scripts/shift-sync/dump-raw.mjs "<path-to-xlsx>" [rows]
 */
import ExcelJS from 'exceljs';
import { resolve } from 'node:path';

const file = resolve(process.argv[2]);
const maxRows = Number(process.argv[3] || 8);

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);

const ref = wb.getWorksheet('مرجع الشيفتات');
if (ref) {
  console.log('--- مرجع الشيفتات (valid dropdown labels) ---');
  ref.eachRow((row, r) => {
    const vals = [];
    row.eachCell((c, col) => vals.push(`[${col}] ${String(c.value ?? '').trim()}`));
    console.log(r, vals.join('  '));
  });
}

const opts = wb.getWorksheet('_grid_options');
if (opts) {
  console.log('\n--- _grid_options ---');
  opts.eachRow((row, r) => {
    const vals = [];
    row.eachCell((c, col) => vals.push(`[${col}] ${String(c.value ?? '').trim()}`));
    if (vals.length) console.log(r, vals.join('  '));
  });
}

const sheet =
  wb.getWorksheet('جدول الشيفتات') ??
  wb.worksheets.find((w) => !w.name.startsWith('_') && w.name !== 'مرجع الشيفتات');
console.log('\n--- جدول الشيفتات (first', maxRows, 'rows, by column index) ---');
let printed = 0;
sheet.eachRow((row, r) => {
  if (printed >= maxRows) return;
  const vals = [];
  row.eachCell({ includeEmpty: true }, (c, col) => {
    const v = String(c.value ?? '').trim().replace(/\n/g, ' ');
    vals.push(`[${col}]${v}`);
  });
  console.log(r, '::', vals.join(' | '));
  printed++;
});
