/**
 * Re-freeze `payroll_lines.payment_method` for the payrolls that were sent to Odoo,
 * taking the value straight from the «طريقة الدفع» column of the Excel that was
 * actually sent. No inference: the sent file is the reference, so a re-download
 * lands on the same Cash/Fawry split that Odoo received.
 *
 * Needed because the earlier backfill derived the split from `hasFawryAccount` alone,
 * while Odoo puts every resigned employee on Cash regardless of their Fawry account.
 *
 *   set -a && source .env && set +a && npx ts-node --transpile-only \
 *     src/scripts/backfillPaymentMethodFromSentFiles.ts [folder] [--apply]
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FOLDER = args.find((a) => !a.startsWith('--')) || path.join(process.cwd(), 'files_to_check');

const COL_CODE = 1;
const COL_METHOD = 37;

type Method = 'كاش' | 'فوري';

async function readMethods(filePath: string): Promise<Map<string, Method>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets.find((w) => /payroll/i.test(w.name)) || wb.worksheets[0]!;
  const out = new Map<string, Method>();
  sheet.eachRow((row) => {
    const code = String(row.getCell(COL_CODE).value ?? '').trim();
    if (!/^\d+$/.test(code)) return;
    const raw = String(row.getCell(COL_METHOD).value ?? '').trim();
    out.set(code, raw === 'فوري' ? 'فوري' : 'كاش');
  });
  return out;
}

async function main() {
  const files = fs
    .readdirSync(FOLDER)
    .filter((f) => f.toLowerCase().endsWith('.xlsx') && /payroll/i.test(f));

  const payrolls = await prisma.payroll.findMany({
    where: { odooSentAt: { not: null } },
    include: { shiftGrid: { include: { location: true } }, lines: { include: { employee: true } } },
  });

  // A payroll can appear in more than one downloaded copy; keep the best-matching file
  // and make sure duplicate copies agree before trusting them.
  const byPayroll = new Map<string, { loc: string; methods: Map<string, Method>; files: string[] }>();

  for (const f of files) {
    const methods = await readMethods(path.join(FOLDER, f));
    let best: { p: (typeof payrolls)[number]; overlap: number } | null = null;
    for (const p of payrolls) {
      const codes = new Set(p.lines.map((l) => l.employee?.code ?? '').filter(Boolean));
      const overlap = [...methods.keys()].filter((c) => codes.has(c)).length;
      if (!best || overlap > best.overlap) best = { p, overlap };
    }
    if (!best || best.overlap === 0) {
      console.log(`  !! ${f}: no matching sent payroll, skipped`);
      continue;
    }
    const loc = best.p.shiftGrid?.location?.name ?? best.p.name ?? best.p.id;
    const prev = byPayroll.get(best.p.id);
    if (!prev) {
      byPayroll.set(best.p.id, { loc, methods, files: [f] });
      continue;
    }
    const conflicts = [...methods].filter(([c, m]) => prev.methods.has(c) && prev.methods.get(c) !== m);
    if (conflicts.length) {
      console.log(
        `  !! ${loc}: duplicate copies disagree on ${conflicts.length} employee(s) — ` +
          `${prev.files.join(', ')} vs ${f}. Skipping this payroll.`,
      );
      byPayroll.delete(best.p.id);
      continue;
    }
    prev.files.push(f);
  }

  let changed = 0;
  let missing = 0;
  const updates: { id: string; method: Method }[] = [];

  for (const p of payrolls) {
    const entry = byPayroll.get(p.id);
    if (!entry) {
      console.log(`  -- ${p.shiftGrid?.location?.name ?? p.id}: no sent file, left untouched`);
      continue;
    }
    let n = 0;
    for (const line of p.lines) {
      const code = line.employee?.code ?? '';
      const want = entry.methods.get(code);
      if (!want) {
        missing++;
        continue;
      }
      if (line.paymentMethod !== want) {
        updates.push({ id: line.id, method: want });
        n++;
      }
    }
    changed += n;
    console.log(`  ${entry.loc.padEnd(10)} ${n} line(s) to fix  (from ${entry.files.length} file copy/copies)`);
  }

  console.log(
    `\n${APPLY ? 'APPLYING' : 'DRY RUN'}: ${changed} payroll line(s) to update` +
      (missing ? `, ${missing} line(s) not present in any sent file (left untouched)` : ''),
  );

  if (!APPLY) {
    console.log('Re-run with --apply to write.');
    await prisma.$disconnect();
    return;
  }

  for (const u of updates) {
    await prisma.payrollLine.update({ where: { id: u.id }, data: { paymentMethod: u.method } });
  }
  console.log(`Done: ${updates.length} line(s) updated.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
