/**
 * Odoo biotime.transaction._should_skip_attendance_due_to_duplicate parity.
 * Always persist transactions; mark duplicates in DB (is_duplicate).
 */
import { Prisma, type BioTimeConfig, type Transaction } from '@prisma/client';
import { prisma } from '../../prisma/client';

function punchStateKey(state: string | null | undefined): string {
  return (state ?? '').trim() || '0';
}

function punchStateMatches(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const sa = punchStateKey(a);
  const sb = punchStateKey(b);
  if (sa === sb) return true;
  if (sa === '0' && (b == null || b === '')) return true;
  return false;
}

function txOrderKey(t: Pick<Transaction, 'punchTime' | 'biotimeTransactionId'>): [number, number] {
  return [t.punchTime.getTime(), t.biotimeTransactionId ?? Number.MAX_SAFE_INTEGER];
}

/** Mark one transaction after upsert — mirrors Odoo duplicate detection. */
export async function applyDuplicateMarking(
  transactionId: string,
  config?: Pick<BioTimeConfig, 'duplicateGraceMinutes' | 'duplicatePolicy'> | null,
): Promise<void> {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction?.empCode) return;

  const graceMinutes = config?.duplicateGraceMinutes ?? 0;
  if (graceMinutes <= 0) {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { isDuplicate: false, duplicateOfId: null },
    });
    return;
  }

  const punchState = punchStateKey(transaction.punchState);
  const windowStart = new Date(transaction.punchTime.getTime() - graceMinutes * 60000);
  const windowEnd = new Date(transaction.punchTime.getTime() + graceMinutes * 60000);

  const candidates = await prisma.transaction.findMany({
    where: {
      empCode: transaction.empCode,
      punchTime: { gte: windowStart, lte: windowEnd },
    },
    orderBy: [{ punchTime: 'asc' }, { biotimeTransactionId: 'asc' }],
  });

  const inWindow = candidates.filter((c) => punchStateMatches(c.punchState, punchState));
  if (inWindow.length <= 1) {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { isDuplicate: false, duplicateOfId: null },
    });
    return;
  }

  const canonical = inWindow.reduce((best, cur) =>
    txOrderKey(cur) < txOrderKey(best) ? cur : best,
  );

  if (canonical.id === transactionId) {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { isDuplicate: false, duplicateOfId: null },
    });
    return;
  }

  const policy = config?.duplicatePolicy ?? 'mark';
  if (policy === 'ignore') {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { isDuplicate: false, duplicateOfId: null },
    });
  } else {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { isDuplicate: true, duplicateOfId: canonical.id },
    });
  }
}

/**
 * Re-mark duplicates for a date range (after bulk sync or migration).
 *
 * Pass `empCodes` when only some employees were just synced (e.g. a branch punch
 * report): without it this scans every company punch in the range, which is the
 * slow, silent phase a branch pull does not need. `onProgress` lets a caller
 * surface this phase, since it runs after the "N/N employees" fetch loop ends.
 */
export async function remarkDuplicatesInRange(
  dateFrom?: Date,
  dateTo?: Date,
  opts?: {
    empCodes?: string[];
    onProgress?: (done: number, total: number) => Promise<void> | void;
  },
): Promise<number> {
  const config = await prisma.bioTimeConfig.findFirst();
  const empCodes = opts?.empCodes?.length
    ? [...new Set(opts.empCodes.map((c) => c?.trim()).filter(Boolean))]
    : undefined;

  const where: Prisma.TransactionWhereInput = {};
  if (dateFrom || dateTo) {
    where.punchTime = {
      ...(dateFrom ? { gte: dateFrom } : {}),
      ...(dateTo ? { lte: dateTo } : {}),
    };
  }
  if (empCodes) where.empCode = { in: empCodes };

  const rows = await prisma.transaction.findMany({
    where,
    orderBy: [{ empCode: 'asc' }, { punchTime: 'asc' }, { biotimeTransactionId: 'asc' }],
    select: { id: true },
  });

  const total = rows.length;
  let done = 0;
  for (const row of rows) {
    await applyDuplicateMarking(row.id, config);
    done++;
    if (opts?.onProgress && (done % 100 === 0 || done === total)) {
      await opts.onProgress(done, total);
    }
  }
  return total;
}
