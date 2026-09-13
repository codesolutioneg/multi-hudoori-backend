import { config } from '../../config';
import { logger } from '../../utils/logger';
import { runScheduledBioTimeSync } from '../../services/biotime/sync.service';

export async function isScheduledAutoSyncEnabled(): Promise<boolean> {
  const { prisma } = await import('../../prisma/client');
  const cfg = await prisma.bioTimeConfig.findFirst({
    select: { scheduledAutoSyncEnabled: true },
  });
  return cfg?.scheduledAutoSyncEnabled !== false;
}

export async function runBioTimeSyncJob(
  trigger: 'cron' | 'startup' | 'manual',
): Promise<void> {
  await runScheduledBioTimeSync(trigger);
}

/** Startup catch-up when last sync is older than the configured interval. */
export async function maybeRunStartupBioTimeSync(
  isBusy: () => boolean,
): Promise<boolean> {
  if (isBusy()) return false;
  try {
    const { prisma } = await import('../../prisma/client');
    const cfg = await prisma.bioTimeConfig.findFirst();
    if (!cfg?.serverIp || !cfg.scheduledAutoSyncEnabled) return false;

    const intervalMs = config.syncCron.intervalHours * 60 * 60 * 1000;
    const last = cfg.lastEmployeeSync ?? cfg.lastTransactionSync;
    const stale = !last || Date.now() - last.getTime() > intervalMs;

    if (stale && cfg.serverIp) {
      logger.info('Running startup BioTime sync (data older than interval)');
      await runScheduledBioTimeSync('startup');
      return true;
    }
  } catch (err) {
    logger.error({ err }, 'Startup BioTime sync check failed');
  }
  return false;
}
