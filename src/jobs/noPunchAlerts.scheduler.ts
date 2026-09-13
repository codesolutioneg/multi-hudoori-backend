import cron from 'node-cron';
import { logger } from '../utils/logger';
import { runExclusive } from './job-lock';
import { runNoPunchAlertJob } from './runners/no-punch-alerts.runner';

const JOB = 'no-punch-alerts';

export function startNoPunchAlertScheduler(): void {
  // Every 6 hours: pull last 7 days punches → generate attendance → refresh alerts
  cron.schedule('20 */6 * * *', () => {
    void runExclusive(JOB, () => runNoPunchAlertJob('cron', true));
  });
  logger.info({ schedule: '20 */6 * * *' }, 'No-punch alerts scheduler started');

  // Warm snapshot from local DB shortly after boot (full sync runs on first cron tick)
  setTimeout(() => {
    void runExclusive(JOB, () => runNoPunchAlertJob('startup', false));
  }, 30_000);
}
