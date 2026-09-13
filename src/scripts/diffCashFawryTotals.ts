/**
 * Read-only diagnostic. For every sent payroll: run both exporters, then compare
 *   sum(grand total) of the CASH rows in the main payroll Excel   vs  the «كاش» sheet total
 *   sum(grand total) of the FAWRY rows in the main payroll Excel  vs  the «فوري» sheet total
 * Also reports the head-count on each side, so a mismatch caused by someone landing
 * on the wrong sheet is distinguishable from a pure arithmetic difference.
 *
 *   set -a && source .env && set +a && npx ts-node --transpile-only \
 *     src/scripts/diffCashFawryTotals.ts
 */
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { exportPayrollXlsx, exportCashFawryXlsx } from '../services/payrollExport.service';

const COL_CODE = 1;
const COL_METHOD = 37;
const COL_GRAND = 39;

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'result' in (v as any)) return Number((v as any).result) || 0;
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function load(base64: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, 'base64') as any);
  return wb;
}

async function main() {
  const payrolls = await prisma.payroll.findMany({
    where: { odooSentAt: { not: null } },
    include: { shiftGrid: { include: { location: true } } },
    orderBy: { createdAt: 'asc' },
  });

  let gCash = 0;
  let gFawry = 0;

  console.log(
    '  branch      cash: main / sheet (diff)                 fawry: main / sheet (diff)',
  );

  for (const p of payrolls) {
    const main = (await load((await exportPayrollXlsx(p.id)).base64)).worksheets[0]!;
    let mainCash = 0;
    let mainFawry = 0;
    let nCash = 0;
    let nFawry = 0;
    main.eachRow((row) => {
      const code = String(row.getCell(COL_CODE).value ?? '').trim();
      if (!/^\d+$/.test(code)) return;
      const grand = num(row.getCell(COL_GRAND).value);
      if (String(row.getCell(COL_METHOD).value ?? '').trim() === 'فوري') {
        mainFawry += grand;
        nFawry++;
      } else {
        mainCash += grand;
        nCash++;
      }
    });

    const cf = await load((await exportCashFawryXlsx(p.id)).base64);
    let sheetCash = 0;
    let sheetFawry = 0;
    let sCash = 0;
    let sFawry = 0;
    for (const ws of cf.worksheets) {
      const isFawry = ws.name.includes('فوري');
      const amountCol = isFawry ? 5 : 4;
      ws.eachRow((row) => {
        const code = String(row.getCell(1).value ?? '').trim();
        if (!/^\d+$/.test(code)) return;
        const v = num(row.getCell(amountCol).value);
        if (isFawry) {
          sheetFawry += v;
          sFawry++;
        } else {
          sheetCash += v;
          sCash++;
        }
      });
    }

    const dCash = r2(sheetCash - mainCash);
    const dFawry = r2(sheetFawry - mainFawry);
    gCash += dCash;
    gFawry += dFawry;

    const loc = (p.shiftGrid?.location?.name ?? p.name ?? p.id).padEnd(10);
    const flag = Math.abs(dCash) < 0.01 && Math.abs(dFawry) < 0.01 ? 'OK ' : '>> ';
    console.log(
      `${flag} ${loc} ${r2(mainCash).toFixed(2).padStart(12)} / ${r2(sheetCash).toFixed(2).padStart(12)} ` +
        `(${dCash >= 0 ? '+' : ''}${dCash.toFixed(2)}) [${nCash}v${sCash}]   ` +
        `${r2(mainFawry).toFixed(2).padStart(12)} / ${r2(sheetFawry).toFixed(2).padStart(12)} ` +
        `(${dFawry >= 0 ? '+' : ''}${dFawry.toFixed(2)}) [${nFawry}v${sFawry}]`,
    );
  }

  console.log(`\nTOTAL cash diff ${gCash.toFixed(2)}   |   fawry diff ${gFawry.toFixed(2)}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
