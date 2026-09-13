/**
 * DEV seed: create short advances + manual deductions from the closed-system
 * Brisk Open Air Mall July payroll Excel, for employees already on the
 * Bri.Mad July cycle-test shift grid.
 *
 * Does NOT create payroll, does NOT create employees, does NOT touch punches.
 * Idempotent via notes marker `[SEED July2026 Bri.Mad]`.
 *
 *   npx ts-node --transpile-only src/scripts/seedBriskJulyAdvancesDeductionsDev.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { AdvanceState, DeductionState } from '@prisma/client';
import { prisma } from '../prisma/client';

const GRID_ID = 'cmsd7v1r10001w0h2payjxmu8';
const XLSX = path.resolve(
  __dirname,
  '../../files_to_test/Brisk_Open_Air_Mall (3).xlsx',
);
const SEED_TAG = '[SEED July2026 Bri.Mad]';
/** Short advances link by calendar month of payroll.dateTo → July 1..25 */
const ADVANCE_DATE = new Date('2026-07-15T00:00:00.000Z');
/** Deductions link by payroll dateFrom..dateTo → June 26..July 25 */
const DEDUCTION_DATE = new Date('2026-07-15T00:00:00.000Z');
const LONG_START = new Date('2026-07-01T00:00:00.000Z');

type RowMoney = {
  code: string;
  name: string;
  salaryAdvance: number;
  longAdvance: number;
  checks: number;
  manualDebit: number;
  penalty: number;
  fines: number;
  documents: number;
  health: number;
  fraction: number;
};

function cellNum(value: unknown): number {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object') {
    const o = value as { result?: unknown };
    if (o.result != null) return cellNum(o.result);
  }
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'object') {
    const o = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (o.result != null) return cellText(o.result);
    if (o.text) return String(o.text).trim();
    if (o.richText) return o.richText.map((t) => t.text).join('').trim();
  }
  return String(value).trim();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function loadExcelRows(): Promise<RowMoney[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const sheet = wb.getWorksheet('Payroll');
  if (!sheet) throw new Error('Payroll sheet missing');

  // Row 5 = English keys
  const keyRow = sheet.getRow(5);
  const col: Record<string, number> = {};
  keyRow.eachCell((cell, c) => {
    const k = cellText(cell.value);
    if (k) col[k] = c;
  });

  const need = [
    'employee_code',
    'employee_name',
    'salary_advance',
    'long_term_advance',
    'deduction_checks',
    'manual_debit',
    'penalty_deduction_value',
    'fines',
    'documents_deduction',
    'health_certificates_deduction',
    'fraction_deduction',
  ];
  for (const k of need) {
    if (!col[k]) throw new Error(`Missing column key: ${k}`);
  }

  const rows: RowMoney[] = [];
  for (let r = 6; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const code = cellText(row.getCell(col.employee_code).value);
    if (!code || !/^\d+$/.test(code)) continue;
    rows.push({
      code,
      name: cellText(row.getCell(col.employee_name).value),
      salaryAdvance: round2(cellNum(row.getCell(col.salary_advance).value)),
      longAdvance: round2(cellNum(row.getCell(col.long_term_advance).value)),
      checks: round2(cellNum(row.getCell(col.deduction_checks).value)),
      manualDebit: round2(cellNum(row.getCell(col.manual_debit).value)),
      penalty: round2(cellNum(row.getCell(col.penalty_deduction_value).value)),
      fines: round2(cellNum(row.getCell(col.fines).value)),
      documents: round2(cellNum(row.getCell(col.documents_deduction).value)),
      health: round2(cellNum(row.getCell(col.health_certificates_deduction).value)),
      fraction: round2(cellNum(row.getCell(col.fraction_deduction).value)),
    });
  }
  return rows;
}

async function main() {
  if (!fs.existsSync(XLSX)) throw new Error(`Missing ${XLSX}`);

  const grid = await prisma.shiftGrid.findUnique({ where: { id: GRID_ID } });
  if (!grid) throw new Error(`Grid not found: ${GRID_ID}`);

  const onGrid = await prisma.shiftGridLine.findMany({
    where: { gridId: GRID_ID },
    distinct: ['employeeId'],
    select: {
      employeeId: true,
      employee: { select: { id: true, code: true, name: true } },
    },
  });
  const byCode = new Map(
    onGrid
      .filter((g) => g.employee.code)
      .map((g) => [String(g.employee.code).trim(), g.employee]),
  );

  const excelRows = await loadExcelRows();
  console.log(`Excel rows: ${excelRows.length}, on grid: ${byCode.size}`);

  let shortCreated = 0;
  let shortSkipped = 0;
  let longCreated = 0;
  let longSkipped = 0;
  let dedCreated = 0;
  let dedSkipped = 0;
  let notOnGrid = 0;
  const details: string[] = [];

  for (const row of excelRows) {
    const emp = byCode.get(row.code);
    if (!emp) {
      notOnGrid++;
      continue;
    }

    // --- Short advance ---
    if (row.salaryAdvance > 0) {
      const note = `${SEED_TAG} salary_advance`;
      const existing = await prisma.advanceShort.findFirst({
        where: {
          employeeId: emp.id,
          notes: note,
          state: { not: AdvanceState.cancelled },
        },
      });
      if (existing) {
        shortSkipped++;
      } else {
        await prisma.advanceShort.create({
          data: {
            employeeId: emp.id,
            amount: row.salaryAdvance,
            state: AdvanceState.pending,
            isDeducted: false,
            date: ADVANCE_DATE,
            deductionStartDate: ADVANCE_DATE,
            sourceGridId: GRID_ID,
            notes: note,
            limitOverride: true,
            overrideReason: 'Seeded from closed-system July payroll reference (DEV cycle test)',
          },
        });
        shortCreated++;
        details.push(`short ${row.code} ${row.salaryAdvance}`);
      }
    }

    // --- Long advance installment (one-shot remaining = excel month amount) ---
    if (row.longAdvance > 0) {
      const note = `${SEED_TAG} long_term_advance`;
      const existing = await prisma.advanceLong.findFirst({
        where: {
          employeeId: emp.id,
          notes: note,
          state: { not: AdvanceState.cancelled },
        },
      });
      if (existing) {
        longSkipped++;
      } else {
        await prisma.advanceLong.create({
          data: {
            employeeId: emp.id,
            totalAmount: row.longAdvance,
            installmentAmount: row.longAdvance,
            installments: 1,
            state: AdvanceState.running,
            date: LONG_START,
            startDate: LONG_START,
            nextDeductionDate: LONG_START,
            notes: note,
            limitOverride: true,
            overrideReason: 'Seeded from closed-system July payroll reference (DEV cycle test)',
          },
        });
        longCreated++;
        details.push(`long ${row.code} ${row.longAdvance}`);
      }
    }

    const dedSpecs: { type: string; amount: number; label: string }[] = [
      { type: 'personal_checks', amount: row.checks, label: 'deduction_checks' },
      { type: 'manual_debit', amount: row.manualDebit, label: 'manual_debit' },
      { type: 'admin', amount: row.penalty, label: 'penalty_deduction_value' },
      { type: 'fines', amount: row.fines, label: 'fines' },
      { type: 'documents', amount: row.documents, label: 'documents_deduction' },
      {
        type: 'health_certificates',
        amount: row.health,
        label: 'health_certificates_deduction',
      },
      { type: 'fraction', amount: row.fraction, label: 'fraction_deduction' },
    ];

    for (const spec of dedSpecs) {
      if (spec.amount <= 0) continue;
      const note = `${SEED_TAG} ${spec.label}`;
      const existing = await prisma.deduction.findFirst({
        where: {
          employeeId: emp.id,
          notes: note,
          state: { not: DeductionState.cancelled },
        },
      });
      if (existing) {
        dedSkipped++;
        continue;
      }
      await prisma.deduction.create({
        data: {
          employeeId: emp.id,
          type: spec.type,
          amount: spec.amount,
          date: DEDUCTION_DATE,
          state: DeductionState.draft,
          notes: note,
          reference: `SEED-JUL26-${row.code}-${spec.type}`,
        },
      });
      dedCreated++;
      details.push(`ded ${row.code} ${spec.type} ${spec.amount}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        gridId: GRID_ID,
        excelRows: excelRows.length,
        excelNotOnGridOrSkippedEmp: notOnGrid,
        shortAdvances: { created: shortCreated, alreadyExisted: shortSkipped },
        longAdvances: { created: longCreated, alreadyExisted: longSkipped },
        deductions: { created: dedCreated, alreadyExisted: dedSkipped },
        sample: details.slice(0, 25),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
