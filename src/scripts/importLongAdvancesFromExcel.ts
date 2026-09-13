/**
 * One-shot import of long advances from Excel (employee code, total, installments).
 *
 *   npx ts-node --transpile-only src/scripts/importLongAdvancesFromExcel.ts [--dry-run] [--file path]
 */
import * as path from 'path';
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { confirmLongAdvance, createLongAdvance, round2 } from '../services/advances.service';

const DEFAULT_XLSX = path.resolve(
  __dirname,
  '../../files_to_sync/1/New Microsoft Excel Worksheet (2).xlsx',
);
const DEDUCTION_START = new Date('2026-08-25T00:00:00.000Z');
const IMPORT_TAG = '[IMPORT long-adv 2026-08-25 xlsx]';
const SKIP_CODES = new Set(['22']);

/** Empty code in sheet → resolved employee code */
const CODE_OVERRIDES: Record<string, string> = {
  'ابراهيم فوزي': '277',
};

type SheetRow = {
  rowNum: number;
  code: string;
  name: string;
  total: number;
  installmentsRaw: string;
};

function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'object') {
    const o = value as { text?: string; result?: unknown };
    if (o.result != null) return cellText(o.result);
    if (o.text) return String(o.text).trim();
  }
  return String(value).trim();
}

function cellNum(value: unknown): number {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

export function parseInstallments(raw: unknown): number {
  const s = cellText(raw);
  const digits = s.match(/\d+/);
  if (digits) return Math.max(1, parseInt(digits[0], 10));
  if (/شهرين|شهران/.test(s)) return 2;
  if (/شهر/.test(s)) return 1;
  throw new Error(`تعذّر قراءة عدد الأقساط: "${s}"`);
}

async function loadRows(filePath: string): Promise<SheetRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('لا يوجد شيت في الملف');

  const rows: SheetRow[] = [];
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const name = cellText(row.getCell(3).value);
    let code = cellText(row.getCell(2).value);
    if (!code && name) {
      const short = name.trim();
      code = CODE_OVERRIDES[short] ?? CODE_OVERRIDES[short.split(/\s+/).slice(0, 2).join(' ')] ?? '';
    }
    const total = round2(cellNum(row.getCell(6).value));
    const installmentsRaw = cellText(row.getCell(7).value);
    if (!code && total <= 0) return;
    rows.push({ rowNum, code, name, total, installmentsRaw });
  });
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileIdx = args.indexOf('--file');
  const filePath = fileIdx >= 0 ? args[fileIdx + 1] : DEFAULT_XLSX;

  const rows = await loadRows(filePath);
  const summary = {
    created: [] as string[],
    skipped: [] as string[],
    errors: [] as string[],
  };

  for (const row of rows) {
    const label = `row ${row.rowNum} code=${row.code || '?'} ${row.name}`;
    try {
      if (!row.code) {
        summary.errors.push(`${label}: لا يوجد كود موظف`);
        continue;
      }
      if (SKIP_CODES.has(row.code)) {
        summary.skipped.push(`${label}: موجود مسبقاً على النظام (تخطي)`);
        continue;
      }
      if (row.total <= 0) {
        summary.errors.push(`${label}: المبلغ صفر أو فارغ`);
        continue;
      }

      const installments = parseInstallments(row.installmentsRaw);
      const employee = await prisma.employeeProfile.findFirst({
        where: { code: row.code },
        select: { id: true, code: true, name: true },
      });
      if (!employee) {
        summary.errors.push(`${label}: الموظف غير موجود في النظام`);
        continue;
      }

      const existing = await prisma.advanceLong.findFirst({
        where: {
          employeeId: employee.id,
          state: { not: 'cancelled' },
          notes: { contains: IMPORT_TAG },
        },
      });
      if (existing) {
        summary.skipped.push(`${label}: مستورد مسبقاً (${existing.id})`);
        continue;
      }

      const duplicate = await prisma.advanceLong.findFirst({
        where: {
          employeeId: employee.id,
          state: { not: 'cancelled' },
          totalAmount: row.total,
          installments,
        },
      });
      if (duplicate) {
        summary.skipped.push(
          `${label}: سلفة نشطة/مسودة بنفس المبلغ (${duplicate.id}, ${duplicate.state})`,
        );
        continue;
      }

      if (dryRun) {
        summary.created.push(
          `${label}: would create total=${row.total} inst=${installments} start=${DEDUCTION_START.toISOString().slice(0, 10)}`,
        );
        continue;
      }

      const adv = await createLongAdvance({
        employeeId: employee.id,
        totalAmount: row.total,
        installments,
        startDate: DEDUCTION_START,
        notes: IMPORT_TAG,
      });
      await confirmLongAdvance(adv.id);
      summary.created.push(
        `${label}: ${employee.name} → ${row.total} / ${installments} (${adv.id})`,
      );
    } catch (e) {
      summary.errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(JSON.stringify({ filePath, dryRun, deductionStart: DEDUCTION_START.toISOString().slice(0, 10), ...summary }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
