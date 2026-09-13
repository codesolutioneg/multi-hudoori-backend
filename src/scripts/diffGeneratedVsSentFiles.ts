/**
 * Read-only diagnostic. For every payroll that was sent to Odoo, actually RUN the two
 * exporters and diff the produced workbooks against the file that went to Odoo:
 *   - exportPayrollXlsx    -> main sheet: payment method + grand total per employee
 *   - exportCashFawryXlsx  -> which sheet each employee lands on + their amount
 * Nothing is written; this only reports.
 *
 *   set -a && source .env && set +a && npx ts-node --transpile-only \
 *     src/scripts/diffGeneratedVsSentFiles.ts [folder]
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { exportPayrollXlsx, exportCashFawryXlsx } from '../services/payrollExport.service';

const FOLDER = process.argv[2] || path.join(process.cwd(), 'files_to_check');

const COL_CODE = 1;
const COL_METHOD = 37;
const COL_GRAND = 39;

type Row = { method: string; grand: number };

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'result' in (v as any)) return Number((v as any).result) || 0;
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function readMainSheet(sheet: ExcelJS.Worksheet): Map<string, Row> {
  const rows = new Map<string, Row>();
  sheet.eachRow((row) => {
    const code = String(row.getCell(COL_CODE).value ?? '').trim();
    if (!/^\d+$/.test(code)) return;
    rows.set(code, {
      method: String(row.getCell(COL_METHOD).value ?? '').trim() === 'فوري' ? 'فوري' : 'كاش',
      grand: num(row.getCell(COL_GRAND).value),
    });
  });
  return rows;
}

async function loadWorkbook(base64: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, 'base64') as any);
  return wb;
}

/** Cash/Fawry workbook -> code => { sheet, amount }. Cash sheet: col4. Fawry sheet: col5. */
function readCashFawry(wb: ExcelJS.Workbook): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const ws of wb.worksheets) {
    const fawry = ws.name.includes('فوري');
    const amountCol = fawry ? 5 : 4;
    ws.eachRow((row) => {
      const code = String(row.getCell(1).value ?? '').trim();
      if (!/^\d+$/.test(code)) return;
      out.set(code, { method: fawry ? 'فوري' : 'كاش', grand: num(row.getCell(amountCol).value) });
    });
  }
  return out;
}

async function main() {
  const files = fs
    .readdirSync(FOLDER)
    .filter((f) => f.toLowerCase().endsWith('.xlsx') && /payroll/i.test(f));

  const sentPayrolls = await prisma.payroll.findMany({
    where: { odooSentAt: { not: null } },
    include: { shiftGrid: { include: { location: true } }, lines: { include: { employee: true } } },
  });

  const seen = new Set<string>();
  let mainMethodBad = 0;
  let mainAmountBad = 0;
  let mainAmountDrift = 0;
  let cfSheetBad = 0;
  let cfAmountBad = 0;
  let cfAmountDrift = 0;

  for (const f of files) {
    const wbSent = new ExcelJS.Workbook();
    await wbSent.xlsx.readFile(path.join(FOLDER, f));
    const sentSheet = wbSent.worksheets.find((w) => /payroll/i.test(w.name)) || wbSent.worksheets[0]!;
    const sent = readMainSheet(sentSheet);

    let best: { p: (typeof sentPayrolls)[number]; overlap: number } | null = null;
    for (const p of sentPayrolls) {
      const codes = new Set(p.lines.map((l) => l.employee?.code ?? '').filter(Boolean));
      const overlap = [...sent.keys()].filter((c) => codes.has(c)).length;
      if (!best || overlap > best.overlap) best = { p, overlap };
    }
    if (!best || best.overlap === 0 || seen.has(best.p.id)) continue;
    seen.add(best.p.id);
    const loc = best.p.shiftGrid?.location?.name ?? best.p.name ?? best.p.id;

    const mainNow = readMainSheet(
      (await loadWorkbook((await exportPayrollXlsx(best.p.id)).base64)).worksheets[0]!,
    );
    const cfNow = readCashFawry(await loadWorkbook((await exportCashFawryXlsx(best.p.id)).base64));

    let mM = 0, mA = 0, cS = 0, cA = 0, mD = 0, cD = 0;
    for (const [code, s] of sent) {
      const m = mainNow.get(code);
      const c = cfNow.get(code);
      if (m) {
        if (m.method !== s.method) { mM++; mainMethodBad++; }
        const d = Math.round((m.grand - s.grand) * 100) / 100;
        if (Math.abs(d) >= 0.01) { mA++; mainAmountBad++; mD += d; mainAmountDrift += d; }
      }
      if (c) {
        if (c.method !== s.method) { cS++; cfSheetBad++; }
        const d = Math.round((c.grand - s.grand) * 100) / 100;
        if (Math.abs(d) >= 0.01) { cA++; cfAmountBad++; cD += d; cfAmountDrift += d; }
      }
    }

    const ok = mM + mA + cS + cA === 0;
    console.log(
      `  ${loc.padEnd(10)} ${ok ? 'OK' : ''}` +
        (ok
          ? ''
          : `main: ${mM} wrong method, ${mA} wrong amount (${mD.toFixed(2)})  |  ` +
            `cash/fawry: ${cS} wrong sheet, ${cA} wrong amount (${cD.toFixed(2)})`),
    );
  }

  console.log('\n=== TOTAL vs files sent to Odoo ===');
  console.log(`  main Excel      : ${mainMethodBad} wrong payment method, ${mainAmountBad} wrong amount, drift ${mainAmountDrift.toFixed(2)}`);
  console.log(`  Cash/Fawry Excel: ${cfSheetBad} on the wrong sheet, ${cfAmountBad} wrong amount, drift ${cfAmountDrift.toFixed(2)}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
