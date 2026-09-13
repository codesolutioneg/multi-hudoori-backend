/**
 * Verify the payroll Excel files that were sent to Odoo against current DEV data.
 * For each file in a folder: match it to a sent payroll (by period + emp-code
 * overlap) and diff the yellow/resigned set (and Cash/Fawry split when present).
 *
 *   set -a && source .env.dev && set +a && npx ts-node --transpile-only \
 *     src/scripts/verifySentPayrollFiles.ts [folder]
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { isResignedLine, isFawryPayment } from '../services/payrollExport.service';

const FOLDER =
  process.argv[2] || path.join(process.cwd(), 'files_to_check');

type ParsedFile = {
  file: string;
  dateFrom: string | null;
  dateTo: string | null;
  codes: Set<string>;
  yellow: Set<string>;
};

function parseDatesFromName(name: string): { from: string | null; to: string | null } {
  const m = name.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/);
  return m ? { from: m[1]!, to: m[2]! } : { from: null, to: null };
}

async function parsePayrollFile(filePath: string): Promise<ParsedFile> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet =
    wb.worksheets.find((w) => /payroll/i.test(w.name)) || wb.worksheets[0]!;
  const codes = new Set<string>();
  const yellow = new Set<string>();
  sheet.eachRow((row) => {
    const code = String(row.getCell(1).value ?? '').trim();
    const name = String(row.getCell(2).value ?? '').trim();
    if (!/^\d+$/.test(code)) return;
    codes.add(code);
    if (name.includes('★')) yellow.add(code);
  });
  const name = path.basename(filePath);
  const { from, to } = parseDatesFromName(name);
  return { file: name, dateFrom: from, dateTo: to, codes, yellow };
}

async function main() {
  const files = fs
    .readdirSync(FOLDER)
    .filter((f) => f.toLowerCase().endsWith('.xlsx') && /payroll/i.test(f));

  const sentPayrolls = await prisma.payroll.findMany({
    where: { odooSentAt: { not: null } },
    include: {
      shiftGrid: { include: { location: true } },
      lines: { include: { employee: true } },
    },
  });

  const results: any[] = [];
  const usedPayrollIds = new Set<string>();

  for (const f of files) {
    const parsed = await parsePayrollFile(path.join(FOLDER, f));
    // Rank sent payrolls by emp-code overlap with this file.
    let best: { id: string; loc: string; overlap: number } | null = null;
    for (const p of sentPayrolls) {
      const codes = new Set(
        p.lines.map((l) => l.employee?.code ?? '').filter(Boolean),
      );
      const overlap = [...parsed.codes].filter((c) => codes.has(c)).length;
      if (!best || overlap > best.overlap) {
        best = {
          id: p.id,
          loc: p.shiftGrid?.location?.name ?? p.name ?? p.id,
          overlap,
        };
      }
    }
    if (!best || best.overlap < Math.max(5, parsed.codes.size * 0.5)) {
      results.push({ file: f, matched: null, note: 'no good match (stale/other period?)' });
      continue;
    }

    const payroll = sentPayrolls.find((p) => p.id === best!.id)!;
    const nowYellow = new Set(
      payroll.lines
        .filter((l) => isResignedLine(l as any))
        .map((l) => l.employee?.code ?? ''),
    );
    const onlyFile = [...parsed.yellow].filter((c) => !nowYellow.has(c));
    const onlyNow = [...nowYellow].filter((c) => !parsed.yellow.has(c));

    results.push({
      file: f,
      matched: best.loc,
      payrollId: best.id,
      duplicateOfEarlierFile: usedPayrollIds.has(best.id),
      overlap: best.overlap,
      fileCodes: parsed.codes.size,
      fileYellow: parsed.yellow.size,
      nowYellow: nowYellow.size,
      yellowMatch: onlyFile.length === 0 && onlyNow.length === 0,
      onlyInOdooFile: onlyFile,
      onlyInDevNow: onlyNow,
    });
    usedPayrollIds.add(best.id);
  }

  const matched = results.filter((r) => r.matched);
  const okCount = matched.filter((r) => r.yellowMatch).length;
  console.log(JSON.stringify(results, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(
    `files=${results.length} matched=${matched.length} yellowMatch=${okCount}/${matched.length}`,
  );
  const mismatches = matched.filter((r) => !r.yellowMatch);
  if (mismatches.length) {
    console.log('MISMATCHES:');
    for (const m of mismatches) {
      console.log(
        `  ${m.file} (${m.matched}) onlyOdoo=[${m.onlyInOdooFile}] onlyDev=[${m.onlyInDevNow}]`,
      );
    }
  }
  const unmatched = results.filter((r) => !r.matched);
  if (unmatched.length) {
    console.log('UNMATCHED:', unmatched.map((u) => u.file));
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
