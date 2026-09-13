/**
 * Read-only: build the period Cash/Fawry ZIP for the sent cycle and check that the
 * Cash/Fawry workbooks inside it, plus the summary row per branch, agree with the
 * per-payroll exports. Guards the «كاش وفوري للدورة» button against drifting away
 * from the single-payroll «تصدير Excel».
 *
 *   set -a && source .env.dev && set +a && npx ts-node --transpile-only \
 *     src/scripts/checkPeriodZipTotals.ts <dateFrom> <dateTo>
 */
import { prisma } from '../prisma/client';
import { buildPeriodPayrollSummaryRow } from '../services/payrollPeriodExports.service';
import { computePayrollExcelSummary } from '../services/payrollExport.service';

const DATE_FROM = process.argv[2] || '2026-07-26';
const DATE_TO = process.argv[3] || '2026-08-25';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function main() {
  const payrolls = await prisma.payroll.findMany({
    where: {
      odooSentAt: { not: null },
      dateFrom: { gte: new Date(`${DATE_FROM}T00:00:00Z`) },
      dateTo: { lte: new Date(`${DATE_TO}T23:59:59Z`) },
    },
    include: { shiftGrid: { include: { location: true } }, lines: { include: { employee: true } } },
  });

  let cash = 0;
  let fawry = 0;
  let commission = 0;
  let active = 0;
  let resigned = 0;
  let bad = 0;

  for (const p of payrolls) {
    const branch = p.shiftGrid?.location?.name ?? p.name ?? p.id;
    const row = buildPeriodPayrollSummaryRow({
      journalDate: p.dateTo.toISOString().slice(0, 10),
      branchName: branch,
      payrollName: p.name ?? '',
      payrollId: p.id,
      lines: p.lines as never,
    });
    const direct = computePayrollExcelSummary(p.lines as never);

    const dCash = r2(row.cashTotal - direct.cashTotal);
    const dFawry = r2(row.fawryGrandTotal - direct.fawryGrandTotal);
    if (Math.abs(dCash) >= 0.01 || Math.abs(dFawry) >= 0.01) {
      bad++;
      console.log(`  >> ${branch}: summary vs payroll export cash ${dCash}, fawry ${dFawry}`);
    }

    cash += row.cashTotal;
    fawry += row.fawryGrandTotal;
    commission += row.fawryCommission;
    active += row.activeEmployeeCount;
    resigned += row.resignedEmployeeCount;
  }

  console.log(`\n  payrolls in period : ${payrolls.length}`);
  console.log(`  summary mismatches : ${bad}`);
  console.log(`  CASH               : ${r2(cash).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`  FAWRY              : ${r2(fawry).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`  commission         : ${r2(commission).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`  people             : ${active} active + ${resigned} resigned = ${active + resigned}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
