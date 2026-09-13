/**
 * Optional live BioTime PULL-ONLY smoke (DEV).
 *
 * Manual — not part of default `npm test`.
 *
 *   BIOTIME_LIVE_PULL=1 npx ts-node scripts/live-biotime-pull-smoke.ts
 *
 * Hard bans: push-biotime, pushToBiotime, sync-all with auto-push.
 * Only syncTransactions / pull-path against real connector from .env.dev.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as syncService from '../src/services/biotime/sync.service';

const prisma = new PrismaClient();

const FORBIDDEN = ['pushToBiotime', 'push-biotime', 'pushEmployees', 'pushEmployee'];

async function assertDevDatabase(): Promise<void> {
  const rows = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  const db = rows[0]?.db ?? '';
  if (db !== 'biotime_dev' && process.env.ALLOW_LIVE_PULL_NON_DEV !== '1') {
    throw new Error(
      `Refusing live pull: database is "${db}", expected biotime_dev. Set ALLOW_LIVE_PULL_NON_DEV=1 to override.`,
    );
  }
  console.log(`DB: ${db}`);
}

async function main() {
  if (process.env.BIOTIME_LIVE_PULL !== '1') {
    console.log('Skipped: set BIOTIME_LIVE_PULL=1 to run this smoke (pull-only, DEV).');
    process.exit(0);
  }

  console.log('=== BioTime live PULL-ONLY smoke (DEV) ===');
  console.log('Forbidden:', FORBIDDEN.join(', '));

  await assertDevDatabase();

  const config = await prisma.bioTimeConfig.findFirst();
  if (!config?.serverIp) {
    throw new Error('No BioTime server configured in biotime_config');
  }
  if (config.autoPushToBiotime) {
    throw new Error('autoPushToBiotime must be false for this smoke — refusing to continue');
  }
  console.log(`BioTime: ${config.serverIp}:${config.serverPort} autoPush=${config.autoPushToBiotime}`);

  const before = await prisma.transaction.count();
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - 2 * 24 * 60 * 60 * 1000);

  // Pull-only: transactions for a short window. Never queue full sync-all / push.
  const count = await syncService.syncTransactions(dateFrom, dateTo);
  const after = await prisma.transaction.count();

  console.log({
    syncedReturned: count,
    transactionsBefore: before,
    transactionsAfter: after,
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
  });

  if (count < 0) {
    throw new Error('syncTransactions returned a negative count');
  }

  console.log('OK: pull-only smoke finished; no push methods invoked.');
}

main()
  .catch((err) => {
    console.error('LIVE PULL SMOKE FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
