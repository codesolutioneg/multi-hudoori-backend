import { startSyncScheduler } from './sync.scheduler';
import { logger } from '../utils/logger';
import { startCompanyJobQueues } from './companyQueues';

/**
 * Multi-tenant schedulers:
 * - Legacy single-tenant in-process cron is OFF by default.
 * - Per-company BioTime / no-punch work goes through BullMQ (Redis).
 */
export function startAllSchedulers(): void {
  // Keep legacy sync scheduler behind env (defaults off in .env.dev).
  startSyncScheduler();

  if (process.env.MULTI_ENABLE_LEGACY_CRON === 'true') {
    logger.warn('MULTI_ENABLE_LEGACY_CRON=true is ignored in multi — use BullMQ queues');
  }

  startCompanyJobQueues();
}
