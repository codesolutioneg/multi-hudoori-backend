import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../utils/logger';
import { isJobRunning, runExclusive } from './job-lock';
import {
  isScheduledAutoSyncEnabled,
  maybeRunStartupBioTimeSync,
  runBioTimeSyncJob,
} from './runners/biotime-sync.runner';

const JOB = 'biotime-sync';

export function startSyncScheduler(): void {
  if (!config.syncCron.enabled) {
    logger.info('BioTime sync cron disabled (SYNC_CRON_ENABLED=false)');
    return;
  }

  const { expression: schedule, timezone } = config.syncCron;
  if (!cron.validate(schedule)) {
    logger.error({ schedule }, 'Invalid SYNC_CRON_EXPRESSION — BioTime sync cron not started');
    return;
  }

  cron.schedule(schedule, async () => {
    if (!(await isScheduledAutoSyncEnabled())) {
      logger.info('Skipping scheduled BioTime sync — disabled in dashboard settings');
      return;
    }
    await runExclusive(
      JOB,
      async () => {
        await runBioTimeSyncJob('cron');
      },
      {
        onSkip: () =>
          logger.warn('Skipping scheduled BioTime sync — previous run still active'),
      },
    );
  }, { timezone });

  logger.info({ schedule, timezone }, 'BioTime sync scheduler started');

  setTimeout(() => {
    void maybeRunStartupBioTimeSync(() => isJobRunning(JOB));
  }, 15_000);
}
