/**
 * Backfill frozen payment_method on already-sent / confirmed payrolls.
 * For Odoo-sent sheets: ignore later archive (use hasFawryAccount only).
 *
 *   set -a && source .env.dev && set +a && npx ts-node --transpile-only \
 *     src/scripts/backfillPayrollPaymentMethod.ts --apply
 */
import { PayrollState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { freezePayrollPaymentMethods } from '../services/payrollExport.service';

const APPLY = process.argv.includes('--apply');

async function main() {
  const payrolls = await prisma.payroll.findMany({
    where: {
      OR: [{ odooSentAt: { not: null } }, { state: PayrollState.confirmed }],
    },
    select: {
      id: true,
      name: true,
      odooSentAt: true,
      state: true,
      dateFrom: true,
      dateTo: true,
      shiftGrid: { select: { location: { select: { name: true } } } },
    },
    orderBy: { dateFrom: 'desc' },
  });

  const samples: string[] = [];
  let totalUpdated = 0;

  for (const p of payrolls) {
    const branch = p.shiftGrid?.location?.name ?? p.name ?? p.id;
    if (!APPLY) {
      if (samples.length < 10) {
        samples.push(
          `${branch} | ${p.dateFrom.toISOString().slice(0, 10)}→${p.dateTo.toISOString().slice(0, 10)} | sent=${Boolean(p.odooSentAt)} | ${p.state}`,
        );
      }
      continue;
    }
    const updated = await freezePayrollPaymentMethods(p.id, {
      overwrite: false,
      ignoreResignation: Boolean(p.odooSentAt),
      // Reconstruct the yellow/archived state as it was at Odoo send time so
      // people archived after sending don't appear yellow in re-downloads.
      resignedAsOf: p.odooSentAt ?? null,
    });
    totalUpdated += updated;
    if (samples.length < 10) {
      samples.push(`${branch} | updatedLines=${updated}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? 'apply' : 'dry-run',
        payrolls: payrolls.length,
        totalUpdated: APPLY ? totalUpdated : undefined,
        samples,
      },
      null,
      2,
    ),
  );
  if (!APPLY) console.log('\nRe-run with --apply to freeze payment methods.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
