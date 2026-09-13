import { logger } from '../../utils/logger';
import { NO_PUNCH_WINDOW_DAYS, computeNoPunchAlerts } from '../../services/noPunchAlerts.service';
import { syncTransactions } from '../../services/biotime/sync.service';
import { generateAttendance } from '../../services/attendance.service';

/** Pull recent punches, generate attendance, then refresh the no-punch snapshot. */
export async function runNoPunchAlertJob(
  trigger: string,
  withSync: boolean,
): Promise<void> {
  if (withSync) {
    const dateTo = new Date();
    const dateFrom = new Date(Date.now() - NO_PUNCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    try {
      const synced = await syncTransactions(dateFrom, dateTo);
      logger.info({ trigger, synced, dateFrom, dateTo }, 'No-punch job: BioTime punches synced');
    } catch (err) {
      logger.error({ err, trigger }, 'No-punch job: punch sync failed (continuing with local data)');
    }

    try {
      const result = await generateAttendance({
        dateFrom,
        dateTo,
        generateAbsences: true,
      });
      logger.info({ trigger, ...result }, 'No-punch job: attendance generated');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, trigger },
        'No-punch job: attendance generate skipped',
      );
    }
  }

  const items = await computeNoPunchAlerts();
  logger.info({ trigger, count: items.length, withSync }, 'No-punch alerts job finished');
}
