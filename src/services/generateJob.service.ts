import { SyncJobStatus } from '@prisma/client';
import { prisma } from '../prisma/client';
import { getCompanyId, runWithTenant } from '../tenant/context';
import { logger } from '../utils/logger';
import * as attendanceService from './attendance.service';
import * as overtimeService from './overtime.service';
import * as odooPushService from './odoo/odooPush.service';
import * as syncService from './biotime/sync.service';

async function finishJob(
  jobId: string,
  status: SyncJobStatus,
  message: string,
  progress = 100,
  companyId?: string | null,
): Promise<void> {
  const run = async () => {
    await prisma.syncJob.update({
      where: { id: jobId },
      data: { status, message, progress, finishedAt: new Date() },
    });
  };
  if (companyId) {
    await runWithTenant(
      { companyId, isImpersonatingCompany: false, actorUserId: 'generate-job' },
      run,
    );
  } else {
    await run();
  }
}

function runInBackground(jobId: string, jobType: string, work: () => Promise<string>): void {
  const companyId = getCompanyId();
  setImmediate(async () => {
    const run = async () => {
      try {
        const message = await work();
        await finishJob(jobId, SyncJobStatus.done, message, 100, companyId);
      } catch (err) {
        logger.error({ err, jobId, jobType, companyId }, 'Background generate job failed');
        try {
          await finishJob(
            jobId,
            SyncJobStatus.failed,
            err instanceof Error ? err.message : 'Generate failed',
            100,
            companyId,
          );
        } catch (finishErr) {
          logger.error({ finishErr, jobId }, 'Failed to mark generate job failed');
        }
      }
    };
    if (companyId) {
      await runWithTenant(
        { companyId, isImpersonatingCompany: false, actorUserId: 'generate-job' },
        run,
      );
    } else {
      await run();
    }
  });
}

function formatRemainAr(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'ثوانٍ قليلة';
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec} ثانية`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) {
    return sec > 0 ? `${min} دقيقة و${sec} ثانية` : `${min} دقيقة`;
  }
  const hours = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hours} ساعة و${remMin} دقيقة` : `${hours} ساعة`;
}

export async function queueAttendanceGenerate(options: {
  dateFrom: Date;
  dateTo: Date;
  shiftGridId?: string;
  employeeIds?: string[];
  deviceSns?: string[];
  skipExisting?: boolean;
  generateAbsences?: boolean;
}): Promise<string> {
  const job = await prisma.syncJob.create({
    data: {
      jobType: 'attendance_generate',
      status: SyncJobStatus.running,
      message: 'جاري تجهيز بيانات الحضور…',
      startedAt: new Date(),
      progress: 2,
    },
  });

  runInBackground(job.id, 'attendance_generate', async () => {
    const startedMs = Date.now();
    let lastPersistMs = 0;

    const result = await attendanceService.generateAttendance({
      ...options,
      onProgress: async ({ current, total, created, updated, skipped }) => {
        const now = Date.now();
        // Throttle DB writes so large months don't flood SyncJob updates.
        if (current !== total && current !== 0 && now - lastPersistMs < 800) return;
        lastPersistMs = now;

        const pct =
          total <= 0 ? 95 : Math.min(99, Math.max(3, Math.round((current / total) * 100)));
        let etaPart = '';
        if (current > 5 && current < total) {
          const elapsed = now - startedMs;
          const remainMs = (elapsed / current) * (total - current);
          etaPart = ` — متبقي ~${formatRemainAr(remainMs)}`;
        }
        const countsPart =
          created + updated + skipped > 0
            ? ` | جديد ${created} · محدّث ${updated}`
            : '';
        await prisma.syncJob.update({
          where: { id: job.id },
          data: {
            progress: pct,
            message:
              total <= 0
                ? 'لا توجد أيام حضور لتوليدها في هذه الفترة'
                : `توليد الحضور: ${current.toLocaleString('ar-EG')} من ${total.toLocaleString('ar-EG')} (${pct}٪)${etaPart}${countsPart}`,
          },
        });
      },
    });

    return `تم: ${result.created} جديد، ${result.updated} محدّث، ${result.skipped} متخطّى`;
  });

  return job.id;
}

export async function queueOvertimeGenerate(
  dateFrom: Date,
  dateTo: Date,
  employeeIds?: string[],
): Promise<string> {
  const job = await prisma.syncJob.create({
    data: {
      jobType: 'overtime_generate',
      status: SyncJobStatus.running,
      message: 'توليد تحليل الإضافي قيد التنفيذ…',
      startedAt: new Date(),
      progress: 5,
    },
  });

  runInBackground(job.id, 'overtime_generate', async () => {
    const result = await overtimeService.generateOvertimeAnalysis(dateFrom, dateTo, employeeIds);
    return `تم: ${result.created} جديد، ${result.updated} محدّث`;
  });

  return job.id;
}

export async function queueOdooPush(): Promise<string> {
  const job = await prisma.syncJob.create({
    data: {
      jobType: 'odoo_push',
      status: SyncJobStatus.running,
      message: 'رفع البيانات إلى Odoo…',
      startedAt: new Date(),
      progress: 5,
    },
  });

  runInBackground(job.id, 'odoo_push', async () => {
    return odooPushService.pushAllToOdoo(async (message, progress) => {
      await prisma.syncJob.update({
        where: { id: job.id },
        data: { message, progress: Math.min(99, progress) },
      });
    });
  });

  return job.id;
}

export async function queueEmployeePunchSync(
  empCodes: string[],
  dateFrom?: Date,
  dateTo?: Date,
): Promise<string> {
  const job = await prisma.syncJob.create({
    data: {
      jobType: 'employee_punch_sync',
      status: SyncJobStatus.running,
      message: 'مزامنة بصمات الموظف من BioTime…',
      startedAt: new Date(),
      progress: 10,
    },
  });

  runInBackground(job.id, 'employee_punch_sync', async () => {
    const count = await syncService.syncEmployeeTransactions(empCodes, dateFrom, dateTo, job.id);
    return count > 0 ? `تمت مزامنة ${count} بصمة` : 'لا توجد بصمات جديدة';
  });

  return job.id;
}

/**
 * Company-wide punch pull for a period (week slices — avoids 50k-page ceiling
 * and per-emp_code loops). Prefer this over syncing thousands of codes one-by-one.
 */
export async function queueCompanyPeriodPunchSync(
  dateFrom: Date,
  dateTo: Date,
): Promise<string> {
  const job = await prisma.syncJob.create({
    data: {
      jobType: 'employee_punch_sync',
      status: SyncJobStatus.running,
      message: 'جاري سحب بصمات الفترة من BioTime (كل الأكواد)…',
      startedAt: new Date(),
      progress: 2,
    },
  });

  runInBackground(job.id, 'employee_punch_sync', async () => {
    const count = await syncService.syncTransactionRangeInSlices(
      dateFrom,
      dateTo,
      async (done, total, synced) => {
        const progress = Math.min(99, Math.round((done / Math.max(total, 1)) * 100));
        await prisma.syncJob.update({
          where: { id: job.id },
          data: {
            progress,
            message: `مزامنة الفترة: شريحة ${done}/${total} (≈${synced} بصمة)`,
          },
        });
      },
    );
    return count > 0
      ? `تمت مزامنة ${count} بصمة للفترة`
      : 'لا توجد بصمات جديدة في الفترة';
  });

  return job.id;
}

export const PUNCH_REPORT_EXPORT_JOB = 'punch_report_export';

/**
 * Background: sync punches (if needed) + build punch-report Excel + save to disk.
 * Frontend polls job status then downloads via jobId — avoids proxy/browser timeouts.
 */
export async function queuePunchReportExport(options: {
  dateFrom: Date;
  dateTo: Date;
  includeAllBiotimeCodes?: boolean;
  employeeIds?: string[];
  syncFirst?: boolean;
}): Promise<string> {
  const job = await prisma.syncJob.create({
    data: {
      jobType: PUNCH_REPORT_EXPORT_JOB,
      status: SyncJobStatus.running,
      message: 'جاري تجهيز تقرير البصمات…',
      startedAt: new Date(),
      progress: 1,
    },
  });

  runInBackground(job.id, PUNCH_REPORT_EXPORT_JOB, async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { listAllBiotimeEmpCodes } = await import('./biotimeEmpCodes.service');
    const { exportPunchReportFileResponse } = await import('./punchReportExcel.service');
    const {
      resolveEmployeesBiotimeCodes,
    } = await import('./employeePunchReport.service');

    const syncFirst = options.syncFirst !== false;
    const update = async (progress: number, message: string) => {
      await prisma.syncJob.update({
        where: { id: job.id },
        data: { progress, message },
      });
    };

    if (syncFirst) {
      if (options.includeAllBiotimeCodes) {
        // Scheduled auto-sync already keeps company punches current, so a full
        // month re-pull here is redundant and the main cause of the timeout.
        // Only pull what's new since the last sync (fast) then build from stored data.
        await update(5, 'جاري تحديث أحدث البصمات من BioTime…');
        try {
          await syncService.syncTransactionsIncremental();
        } catch (err) {
          logger.warn({ err, jobId: job.id }, 'Incremental sync before punch export failed; using stored data');
        }
      } else if (options.employeeIds?.length) {
        await update(5, 'جاري سحب بصمات الموظفين المحددين…');
        const resolved = await resolveEmployeesBiotimeCodes(options.employeeIds);
        if (resolved.codes.length) {
          await syncService.syncEmployeeTransactions(
            resolved.codes,
            options.dateFrom,
            options.dateTo,
            job.id,
          );
        }
      }
    }

    await update(58, 'جاري تجهيز قائمة الأكواد…');
    let empCodes: string[] | undefined;
    let employeeIds: string[] | undefined;
    if (options.includeAllBiotimeCodes) {
      empCodes = await listAllBiotimeEmpCodes();
      if (!empCodes.length) {
        throw new Error('لا توجد أكواد موظفين على خادم BioTime');
      }
    } else {
      employeeIds = options.employeeIds ?? [];
      if (!employeeIds.length) {
        throw new Error('لا يوجد موظفون للتصدير');
      }
    }

    await update(65, 'جاري توليد ملف Excel…');
    const file = await exportPunchReportFileResponse({
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      ...(empCodes ? { empCodes, includeInactive: true } : { employeeIds }),
    });

    await update(92, 'جاري حفظ الملف…');
    const dir = path.join(process.cwd(), 'storage', 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${job.id}.xlsx`);
    fs.writeFileSync(filePath, Buffer.from(file.base64, 'base64'));

    // Final message is JSON so the download endpoint / UI can pick up the file.
    return JSON.stringify({
      ready: true,
      filename: file.filename,
    });
  });

  return job.id;
}

export const PUNCH_REPORT_SYNC_JOB = 'punch_report_sync';

/**
 * Pulls punches for one branch's employees as a job. Company-wide pulls take
 * minutes even for a few days; a branch of ~40 employees finishes in about a
 * minute and reports progress employee by employee. A run already covering
 * this branch+period is reused rather than starting a second pull.
 */
export async function queuePunchReportSync(options: {
  dateFrom: Date;
  dateTo: Date;
  locationId: string;
  empCodes: string[];
}): Promise<string> {
  const running = await prisma.syncJob.findFirst({
    where: {
      jobType: PUNCH_REPORT_SYNC_JOB,
      status: SyncJobStatus.running,
      message: { contains: options.locationId },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (running) return running.id;

  const job = await prisma.syncJob.create({
    data: {
      jobType: PUNCH_REPORT_SYNC_JOB,
      status: SyncJobStatus.running,
      // locationId is embedded so a concurrent run for another branch can start,
      // and so a reopen of this dialog reuses the same job.
      message: `مزامنة بصمات الفرع ${options.locationId}…`,
      startedAt: new Date(),
      progress: 2,
    },
  });

  runInBackground(job.id, PUNCH_REPORT_SYNC_JOB, async () => {
    // Same completeness as shift-grid punch sync: pull the full period from BioTime
    // (not only known Hudoori emp codes), so punches before hiringDate are stored too.
    const synced = await syncService.syncTransactions(
      options.dateFrom,
      options.dateTo,
      job.id,
    );
    await syncService.recordTransactionRangeCoverage(
      options.dateFrom,
      options.dateTo,
      options.locationId,
    );
    return synced > 0 ? `تمت مزامنة ${synced} بصمة` : 'لا توجد بصمات جديدة';
  });

  return job.id;
}

export async function getJobStatus(jobId: string) {
  const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
  if (!job) return null;
  let result: Record<string, unknown> | null = null;
  const raw = job.message ?? '';
  if (job.status === SyncJobStatus.done && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') result = parsed;
    } catch {
      result = null;
    }
  }
  return {
    id: job.id,
    jobType: job.jobType,
    status: job.status,
    progress: job.progress,
    // Prefer a short human message while running; keep JSON only in result when done.
    message:
      result?.ready === true
        ? `جاهز للتنزيل: ${String(result.filename ?? '')}`
        : raw,
    result,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
