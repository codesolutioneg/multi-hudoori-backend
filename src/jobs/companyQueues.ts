import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../utils/logger';
import { prismaBase } from '../prisma/client';
import { enterTenant, runWithTenant } from '../tenant/context';
import { runBioTimeSyncJob } from './runners/biotime-sync.runner';
import { runNoPunchAlertJob } from './runners/no-punch-alerts.runner';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3';

let connection: IORedis | null = null;
let biotimeQueue: Queue | null = null;
let noPunchQueue: Queue | null = null;

function getConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  }
  return connection;
}

export type CompanyJobPayload = {
  companyId: string;
  trigger: string;
  withSync?: boolean;
};

async function withCompanyContext<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenant(
    { companyId, isImpersonatingCompany: false, actorUserId: 'job-worker' },
    fn,
  );
}

export function startCompanyJobQueues(): void {
  if (process.env.MULTI_JOBS_ENABLED === 'false') {
    logger.info('Multi company job queues disabled (MULTI_JOBS_ENABLED=false)');
    return;
  }

  try {
    const conn = getConnection();
    biotimeQueue = new Queue('hudoori-multi-biotime-sync', { connection: conn });
    noPunchQueue = new Queue('hudoori-multi-no-punch', { connection: conn });

    // eslint-disable-next-line no-new
    new Worker<CompanyJobPayload>(
      'hudoori-multi-biotime-sync',
      async (job: Job<CompanyJobPayload>) => {
        const { companyId, trigger } = job.data;
        await withCompanyContext(companyId, async () => {
          enterTenant({ companyId, isImpersonatingCompany: false, actorUserId: 'job-worker' });
          logger.info({ companyId, trigger, jobId: job.id }, 'BioTime sync job start');
          await runBioTimeSyncJob(trigger === 'startup' ? 'startup' : trigger === 'manual' ? 'manual' : 'cron');
        });
      },
      { connection: conn, concurrency: 2 },
    );

    // eslint-disable-next-line no-new
    new Worker<CompanyJobPayload>(
      'hudoori-multi-no-punch',
      async (job: Job<CompanyJobPayload>) => {
        const { companyId, trigger, withSync } = job.data;
        await withCompanyContext(companyId, async () => {
          enterTenant({ companyId, isImpersonatingCompany: false, actorUserId: 'job-worker' });
          logger.info({ companyId, trigger, jobId: job.id }, 'No-punch job start');
          await runNoPunchAlertJob(trigger, Boolean(withSync));
        });
      },
      { connection: conn, concurrency: 1 },
    );

    logger.info({ redis: REDIS_URL }, 'Multi company BullMQ workers started');

    // Enqueue per-company jobs on a schedule via setInterval (simple; replace with repeatable jobs later).
    const hours = Math.max(1, Number(process.env.SYNC_CRON_INTERVAL_HOURS ?? 12));
    const intervalMs = hours * 60 * 60 * 1000;

    const enqueueAll = async (kind: 'biotime' | 'nopunch', withSync: boolean) => {
      const companies = await prismaBase.company.findMany({
        where: { active: true },
        select: { id: true, code: true },
      });
      for (const c of companies) {
        const payload: CompanyJobPayload = {
          companyId: c.id,
          trigger: 'cron',
          withSync,
        };
        if (kind === 'biotime') {
          await biotimeQueue?.add(`biotime:${c.code}`, payload, {
            removeOnComplete: 50,
            removeOnFail: 20,
            jobId: `biotime-${c.id}-${Date.now()}`,
          });
        } else {
          await noPunchQueue?.add(`nopunch:${c.code}`, payload, {
            removeOnComplete: 50,
            removeOnFail: 20,
            jobId: `nopunch-${c.id}-${Date.now()}`,
          });
        }
      }
      logger.info({ kind, companies: companies.length }, 'Enqueued per-company jobs');
    };

    if (process.env.SYNC_CRON_ENABLED !== 'false') {
      setInterval(() => {
        void enqueueAll('biotime', false).catch((err) =>
          logger.error({ err }, 'Failed to enqueue biotime jobs'),
        );
      }, intervalMs);
      setInterval(() => {
        void enqueueAll('nopunch', true).catch((err) =>
          logger.error({ err }, 'Failed to enqueue no-punch jobs'),
        );
      }, 6 * 60 * 60 * 1000);
      logger.info({ intervalHours: hours }, 'Per-company job enqueue timers armed');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to start BullMQ — jobs deferred');
  }
}

/** Manual enqueue for one company (admin/ops). */
export async function enqueueCompanyBioTimeSync(companyId: string, trigger = 'manual'): Promise<void> {
  if (!biotimeQueue) {
    const conn = getConnection();
    biotimeQueue = new Queue('hudoori-multi-biotime-sync', { connection: conn });
  }
  await biotimeQueue.add(
    `biotime:${companyId}`,
    { companyId, trigger },
    { removeOnComplete: 20, removeOnFail: 10 },
  );
}
