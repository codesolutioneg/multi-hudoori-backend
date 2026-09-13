/**
 * Backfill the frozen resigned/yellow state on already-sent payroll lines using
 * the actual Odoo-sent Excel files as ground truth.
 *
 * Rule per employee code on a matched payroll:
 *   resignedFrozen = (yellow in any matching sent file)
 *                    AND NOT (archived strictly AFTER the Odoo send time)
 *
 * The override drops people who were archived only after the sheet was sent — a
 * late re-download of the file would show them yellow, but at send time they were
 * still active. Union across duplicate downloads keeps anyone who was restored
 * after send (they were yellow at send).
 *
 *   set -a && source .env.dev && set +a && npx ts-node --transpile-only \
 *     src/scripts/backfillResignedFromSentFiles.ts [folder] [--apply]
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FOLDER =
  args.find((a) => !a.startsWith('--')) ||
  path.join(process.cwd(), 'files_to_check');

async function parseYellow(filePath: string): Promise<{ codes: Set<string>; yellow: Set<string> }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets.find((w) => /payroll/i.test(w.name)) || wb.worksheets[0]!;
  const codes = new Set<string>();
  const yellow = new Set<string>();
  sheet.eachRow((row) => {
    const code = String(row.getCell(1).value ?? '').trim();
    const name = String(row.getCell(2).value ?? '').trim();
    if (!/^\d+$/.test(code)) return;
    codes.add(code);
    if (name.includes('★')) yellow.add(code);
  });
  return { codes, yellow };
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

  // Union yellow sets per matched payrollId across duplicate files.
  const unionYellow = new Map<string, Set<string>>();
  const matchedFileNames = new Map<string, string[]>();

  for (const f of files) {
    const parsed = await parseYellow(path.join(FOLDER, f));
    let best: { id: string; overlap: number } | null = null;
    for (const p of sentPayrolls) {
      const codes = new Set(p.lines.map((l) => l.employee?.code ?? '').filter(Boolean));
      const overlap = [...parsed.codes].filter((c) => codes.has(c)).length;
      if (!best || overlap > best.overlap) best = { id: p.id, overlap };
    }
    if (!best || best.overlap < Math.max(5, parsed.codes.size * 0.5)) {
      console.log(`SKIP file (no match): ${f}`);
      continue;
    }
    if (!unionYellow.has(best.id)) unionYellow.set(best.id, new Set());
    parsed.yellow.forEach((c) => unionYellow.get(best!.id)!.add(c));
    const arr = matchedFileNames.get(best.id) ?? [];
    arr.push(f);
    matchedFileNames.set(best.id, arr);
  }

  let totalUpdated = 0;
  const report: any[] = [];

  for (const p of sentPayrolls) {
    const yellow = unionYellow.get(p.id);
    if (!yellow) {
      report.push({ loc: p.shiftGrid?.location?.name, note: 'no sent file — left as-is' });
      continue;
    }
    const sentAt = p.odooSentAt!;
    let updated = 0;
    let trueCount = 0;
    for (const line of p.lines) {
      const code = line.employee?.code ?? '';
      const archivedAfterSend = Boolean(
        line.employee?.archivedAt && line.employee.archivedAt.getTime() > sentAt.getTime(),
      );
      const frozen = yellow.has(code) && !archivedAfterSend;
      if (frozen) trueCount += 1;
      if ((line as { resignedFrozen?: boolean | null }).resignedFrozen !== frozen) {
        if (APPLY) {
          await prisma.payrollLine.update({
            where: { id: line.id },
            data: { resignedFrozen: frozen },
          });
        }
        updated += 1;
      }
    }
    totalUpdated += updated;
    report.push({
      loc: p.shiftGrid?.location?.name,
      files: matchedFileNames.get(p.id),
      fileYellowUnion: yellow.size,
      frozenTrue: trueCount,
      linesChanged: updated,
    });
  }

  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', totalUpdated, report }, null, 2));
  if (!APPLY) console.log('\nRe-run with --apply to write resignedFrozen from files.');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
