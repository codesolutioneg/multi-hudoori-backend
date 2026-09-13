import { SyncJobStatus } from '@prisma/client';
import { prisma } from '../../prisma/client';
import {
  formatBioTimeDateTime,
  formatBioTimeRange,
  parseBioTimePunchTime,
} from '../../utils/biotimeTimezone';
import { logger } from '../../utils/logger';
import { BioTimeConnector, BioTimeEmployee, BioTimeTransaction } from './biotimeConnector.service';
import { pushPendingEmployeesToBioTime, EmployeePushResult } from './employeePush.service';
import { applyDuplicateMarking, remarkDuplicatesInRange } from './transactionDuplicate.service';

const JOB_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
const TRANSACTION_RANGE_JOB = 'transaction_range';

function syncDayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

type TransactionRangeCoverage = {
  dateFrom: string;
  dateTo: string;
  /** Absent for a company-wide pull, which therefore covers every branch. */
  locationId?: string;
};

/**
 * Marks a period as pulled from BioTime. Kept out of `bioTimeConfig` because a
 * single "last synced at" cannot answer whether an arbitrary report period was
 * covered. These rows are excluded from the sync-jobs screen by its jobType
 * filter, so they stay an internal marker.
 */
export async function recordTransactionRangeCoverage(
  dateFrom: Date,
  dateTo: Date,
  locationId?: string,
): Promise<void> {
  const now = new Date();
  await prisma.syncJob.create({
    data: {
      jobType: TRANSACTION_RANGE_JOB,
      status: SyncJobStatus.done,
      progress: 100,
      message: JSON.stringify({
        dateFrom: syncDayKey(dateFrom),
        dateTo: syncDayKey(dateTo),
        ...(locationId ? { locationId } : {}),
      } satisfies TransactionRangeCoverage),
      startedAt: now,
      finishedAt: now,
    },
  });
}

export async function isTransactionRangeCoveredRecently(
  dateFrom: Date,
  dateTo: Date,
  locationId?: string,
): Promise<boolean> {
  const config = await prisma.bioTimeConfig.findFirst({
    select: { transactionSyncIntervalMins: true },
  });
  const freshnessMinutes = Math.max(5, config?.transactionSyncIntervalMins ?? 15);
  const freshSince = new Date(Date.now() - freshnessMinutes * 60 * 1000);
  const rows = await prisma.syncJob.findMany({
    where: {
      jobType: TRANSACTION_RANGE_JOB,
      status: SyncJobStatus.done,
      finishedAt: { gte: freshSince },
    },
    select: { message: true },
    orderBy: { finishedAt: 'desc' },
    take: 50,
  });
  const requestedFrom = syncDayKey(dateFrom);
  const requestedTo = syncDayKey(dateTo);
  return rows.some((row) => {
    try {
      const coverage = JSON.parse(row.message ?? '') as TransactionRangeCoverage;
      if (coverage.dateFrom > requestedFrom || coverage.dateTo < requestedTo) return false;
      // A company-wide pull covers every branch; a branch pull only its own.
      return !coverage.locationId || coverage.locationId === locationId;
    } catch {
      return false;
    }
  });
}

async function resolveEmployeeByEmpCode(empCode: string): Promise<string | null> {
  const code = empCode.trim();
  if (!code) return null;

  const mapping = await prisma.employeeMapping.findFirst({
    where: { biotimeEmpCode: code },
    select: { employeeId: true },
  });
  if (mapping) return mapping.employeeId;

  const emp = await prisma.employeeProfile.findFirst({
    where: {
      OR: [{ code }, { barcode: code }, { identificationId: code }],
    },
    select: { id: true },
  });
  return emp?.id ?? null;
}

/** Odoo biotime.transaction._sync_single_transaction */
async function syncSingleTransaction(
  row: BioTimeTransaction,
  config: Awaited<ReturnType<typeof prisma.bioTimeConfig.findFirst>>,
): Promise<'created' | 'updated' | 'skipped'> {
  const empCode = String(row.emp_code ?? '').trim();
  const punchTime = row.punch_time ? parseBioTimePunchTime(String(row.punch_time)) : null;
  if (!row.id || !empCode || !punchTime || isNaN(punchTime.getTime())) return 'skipped';

  const employeeId = await resolveEmployeeByEmpCode(empCode);
  const payload = {
    empCode,
    employeeId,
    punchTime,
    punchState: row.punch_state != null ? String(row.punch_state) : null,
    terminalSn: row.terminal_sn ?? null,
    terminalAlias: row.terminal_alias ?? null,
  };

  const existing = await prisma.transaction.findUnique({
    where: { biotimeTransactionId: row.id },
  });

  let localId: string;
  if (existing) {
    await prisma.transaction.update({
      where: { id: existing.id },
      data: payload,
    });
    localId = existing.id;
    await applyDuplicateMarking(localId, config);
    return 'updated';
  }

  const created = await prisma.transaction.create({
    data: { biotimeTransactionId: row.id, ...payload },
  });
  localId = created.id;
  await applyDuplicateMarking(localId, config);
  return 'created';
}

function biotimeDeptId(row: BioTimeEmployee): number | undefined {
  if (row.department == null) return undefined;
  return typeof row.department === 'object' ? row.department.id : row.department;
}

async function resolveDepartmentId(biotimeDeptIdVal?: number): Promise<string | undefined> {
  if (!biotimeDeptIdVal) return undefined;
  const dept = await prisma.department.findFirst({ where: { biotimeDeptId: biotimeDeptIdVal } });
  return dept?.id;
}

const BIOTIME_SYNC_JOB_TYPES = ['biotime_scheduled', 'biotime_manual', 'biotime_pull'] as const;

async function isSyncLocked(): Promise<boolean> {
  const running = await prisma.syncJob.findFirst({
    where: {
      jobType: { in: [...BIOTIME_SYNC_JOB_TYPES] },
      status: SyncJobStatus.running,
      startedAt: { gte: new Date(Date.now() - JOB_STALE_MS) },
    },
  });
  return Boolean(running);
}

async function createSyncJob(jobType: string, message?: string) {
  return prisma.syncJob.create({
    data: {
      jobType,
      status: SyncJobStatus.running,
      message: message ?? 'Starting sync',
      startedAt: new Date(),
      progress: 0,
    },
  });
}

async function finishSyncJob(
  jobId: string,
  status: SyncJobStatus,
  message: string,
  progress = 100,
): Promise<void> {
  await prisma.syncJob.update({
    where: { id: jobId },
    data: { status, message, progress, finishedAt: new Date() },
  });
}

export async function syncEmployees(): Promise<number> {
  const connector = await BioTimeConnector.fromDb();
  let page = 1;
  let count = 0;

  while (page <= 100) {
    const response = await connector.getEmployees(page, 200);
    const rows = response.data ?? [];
    if (!rows.length) break;

    for (const row of rows) {
      const empCode = String(row.emp_code ?? '').trim();
      const firstName = String(row.first_name ?? '').trim();
      const lastName = String(row.last_name ?? '').trim();
      const fullName = `${firstName} ${lastName}`.trim();
      const name = fullName || empCode || `Employee ${row.id}`;
      const displayName = fullName || name;
      const deptId = await resolveDepartmentId(biotimeDeptId(row));
      const bioDeptId = biotimeDeptId(row);

      let employee = await prisma.employeeProfile.findFirst({
        where: { OR: [{ code: empCode }, { mapping: { biotimeEmpId: row.id } }] },
        include: { mapping: true },
      });

      if (!employee) {
        employee = await prisma.employeeProfile.create({
          data: {
            name,
            displayName,
            code: empCode,
            barcode: empCode,
            departmentId: deptId,
            biotimeSynced: true,
            mapping: {
              create: {
                biotimeEmpId: row.id,
                biotimeEmpCode: empCode,
                firstName: row.first_name,
                lastName: row.last_name,
                cardNo: row.card_no,
                mobile: row.mobile,
                email: row.email,
                gender: row.gender,
                biotimeDepartmentId: bioDeptId,
                lastSync: new Date(),
              },
            },
          },
          include: { mapping: true },
        });
      } else if (employee.biotimeSynced) {
        await prisma.employeeProfile.update({
          where: { id: employee.id },
          data: {
            name: fullName || employee.name || name,
            displayName: fullName || employee.displayName || displayName,
            code: empCode || employee.code,
            biotimeSynced: true,
            ...(deptId ? { departmentId: deptId } : {}),
          },
        });
        if (employee.mapping) {
          await prisma.employeeMapping.update({
            where: { id: employee.mapping.id },
            data: {
              biotimeEmpId: row.id,
              biotimeEmpCode: empCode,
              firstName: row.first_name,
              lastName: row.last_name,
              cardNo: row.card_no ?? employee.mapping.cardNo,
              mobile: row.mobile ?? employee.mapping.mobile,
              email: row.email ?? employee.mapping.email,
              gender: row.gender ?? employee.mapping.gender,
              biotimeDepartmentId: bioDeptId,
              lastSync: new Date(),
            },
          });
        } else {
          await prisma.employeeMapping.create({
            data: {
              employeeId: employee.id,
              biotimeEmpId: row.id,
              biotimeEmpCode: empCode,
              firstName: row.first_name,
              lastName: row.last_name,
              biotimeDepartmentId: bioDeptId,
              lastSync: new Date(),
            },
          });
        }
      } else if (employee.mapping) {
        await prisma.employeeMapping.update({
          where: { id: employee.mapping.id },
          data: {
            biotimeEmpId: row.id,
            biotimeEmpCode: empCode || employee.mapping.biotimeEmpCode,
            biotimeDepartmentId: bioDeptId ?? employee.mapping.biotimeDepartmentId,
            lastSync: new Date(),
          },
        });
      } else {
        await prisma.employeeMapping.create({
          data: {
            employeeId: employee.id,
            biotimeEmpId: row.id,
            biotimeEmpCode: empCode,
            firstName: row.first_name,
            lastName: row.last_name,
            biotimeDepartmentId: bioDeptId,
            lastSync: new Date(),
          },
        });
      }
      count++;
    }

    if (!response.next) break;
    page++;
  }

  const config = await prisma.bioTimeConfig.findFirst();
  if (config) {
    await prisma.bioTimeConfig.update({
      where: { id: config.id },
      data: { lastEmployeeSync: new Date() },
    });
  }

  await linkAppUsersToEmployees();
  return count;
}

/** Match app users (created in Admin) to BioTime employee rows by email/login/code */
export async function linkAppUsersToEmployees(): Promise<number> {
  const unlinked = await prisma.employeeProfile.findMany({
    where: { userId: null },
    include: { mapping: true },
  });
  let linked = 0;

  for (const emp of unlinked) {
    const candidates = [emp.workEmail, emp.mapping?.email, emp.code].filter(Boolean) as string[];
    if (!candidates.length) continue;

    const user = await prisma.user.findFirst({
      where: {
        active: true,
        OR: candidates.flatMap((c) => [{ login: c }, { email: c }]),
      },
    });

    if (!user) continue;

    const taken = await prisma.employeeProfile.findUnique({ where: { userId: user.id } });
    if (taken && taken.id !== emp.id) continue;

    await prisma.employeeProfile.update({
      where: { id: emp.id },
      data: { userId: user.id },
    });
    linked++;
  }

  return linked;
}

export async function syncDepartments(): Promise<number> {
  const connector = await BioTimeConnector.fromDb();
  let page = 1;
  let count = 0;

  while (page <= 50) {
    const response = await connector.getDepartments(page, 200);
    const rows = response.data ?? [];
    if (!rows.length) break;

    for (const row of rows) {
      const name = row.dept_name ?? `Dept ${row.id}`;
      let dept = await prisma.department.findFirst({
        where: { OR: [{ biotimeDeptId: row.id }, { name }] },
        include: { mapping: true },
      });

      if (!dept) {
        dept = await prisma.department.create({
          data: {
            name,
            biotimeDeptId: row.id,
            biotimeDeptCode: row.dept_code,
            mapping: {
              create: {
                biotimeDeptId: row.id,
                biotimeDeptCode: row.dept_code,
                biotimeDeptName: name,
              },
            },
          },
          include: { mapping: true },
        });
      } else {
        await prisma.department.update({
          where: { id: dept.id },
          data: { name, biotimeDeptId: row.id, biotimeDeptCode: row.dept_code },
        });
      }
      count++;
    }

    if (!response.next) break;
    page++;
  }

  const config = await prisma.bioTimeConfig.findFirst();
  if (config) {
    await prisma.bioTimeConfig.update({
      where: { id: config.id },
      data: { lastDepartmentSync: new Date() },
    });
  }

  return count;
}

export async function syncDevices(): Promise<number> {
  const connector = await BioTimeConnector.fromDb();
  let page = 1;
  let count = 0;

  while (page <= 20) {
    const response = await connector.getDevices(page, 200);
    const rows = response.data ?? [];
    if (!rows.length) break;

    for (const row of rows) {
      const name = row.alias ?? row.sn ?? `Device ${row.id}`;
      await prisma.device.upsert({
        where: { biotimeId: row.id },
        create: {
          biotimeId: row.id,
          name,
          alias: row.alias,
          serialNumber: row.sn,
          ipAddress: row.ip_address,
        },
        update: {
          name,
          alias: row.alias,
          serialNumber: row.sn,
          ipAddress: row.ip_address,
        },
      });
      count++;
    }

    if (!response.next) break;
    page++;
  }

  return count;
}

async function fetchTransactionsPage(
  connector: BioTimeConnector,
  page: number,
  pageSize: number,
  filters: Record<string, unknown>,
  maxRetries = 3,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await connector.getTransactions(page, pageSize, filters);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw lastError;
}

export async function syncTransactions(
  dateFrom?: Date,
  dateTo?: Date,
  jobId?: string,
): Promise<number> {
  const connector = await BioTimeConnector.fromDb();
  const config = await prisma.bioTimeConfig.findFirst();
  let page = 1;
  let syncedCount = 0;
  let createdCount = 0;
  let updatedCount = 0;
  let errorsCount = 0;
  const pageSize = 100;

  const range = formatBioTimeRange(dateFrom, dateTo);
  const filters: Record<string, unknown> = { ...range };
  if (!dateFrom && !dateTo && config?.lastTransactionSync) {
    filters.start_time = formatBioTimeDateTime(config.lastTransactionSync);
    filters.end_time = formatBioTimeDateTime(new Date());
  } else if (!dateFrom && !dateTo) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    filters.start_time = formatBioTimeDateTime(dayAgo);
    filters.end_time = formatBioTimeDateTime(new Date());
  }

  let totalPages = 0;

  while (page <= 500) {
    let response;
    try {
      response = await fetchTransactionsPage(connector, page, pageSize, filters);
      errorsCount = 0;
    } catch (err) {
      errorsCount++;
      logger.warn({ err, page }, 'Transaction sync page failed');
      if (errorsCount >= 5) break;
      page++;
      continue;
    }

    const rows = response.data ?? [];
    const totalCount = response.count ?? 0;
    if (page === 1 && totalCount) {
      totalPages = Math.ceil(totalCount / pageSize);
    }

    if (jobId) {
      const progress = totalPages ? Math.min(99, Math.round((page / totalPages) * 100)) : Math.min(50, page * 5);
      await prisma.syncJob.update({
        where: { id: jobId },
        data: {
          progress,
          message: `page=${page};pages=${totalPages || 0};total=${totalCount};synced=${syncedCount};new=${createdCount};updated=${updatedCount}`,
        },
      });
    }

    if (!rows.length) break;

    for (const row of rows) {
      try {
        const result = await syncSingleTransaction(row, config);
        if (result === 'skipped') continue;
        syncedCount++;
        if (result === 'created') createdCount++;
        else updatedCount++;
      } catch (err) {
        logger.warn({ err, biotimeId: row.id }, 'sync single transaction failed');
      }
    }

    const isLastPage = rows.length < pageSize;
    const allFetched = totalCount > 0 && page * pageSize >= totalCount;
    if (!response.next || isLastPage || allFetched) break;
    page++;
  }

  if (dateFrom || dateTo) {
    await remarkDuplicatesInRange(dateFrom, dateTo);
  }

  if (dateFrom && dateTo) {
    await recordTransactionRangeCoverage(dateFrom, dateTo);
  }

  if (config) {
    await prisma.bioTimeConfig.update({
      where: { id: config.id },
      data: { lastTransactionSync: dateTo ?? new Date() },
    });
  }

  logger.info({ syncedCount, createdCount, updatedCount, dateFrom, dateTo }, 'Transaction sync complete');
  return syncedCount;
}

/**
 * Pulls a long period in week-size slices. A single `syncTransactions` call stops
 * at 500 pages (50k punches), which a month of company-wide punches can reach, so
 * slicing keeps every call far from that ceiling and gives the caller something
 * to report progress with. Coverage for the whole period is recorded only after
 * every slice succeeded, so a failure halfway cannot mark it as synced.
 */
export async function syncTransactionRangeInSlices(
  dateFrom: Date,
  dateTo: Date,
  onSliceProgress?: (done: number, total: number, synced: number) => Promise<void>,
  sliceDays = 7,
): Promise<number> {
  const sliceMs = sliceDays * 24 * 60 * 60 * 1000;
  const slices: { from: Date; to: Date }[] = [];
  for (let start = dateFrom.getTime(); start <= dateTo.getTime(); start += sliceMs) {
    const end = Math.min(start + sliceMs - 1, dateTo.getTime());
    slices.push({ from: new Date(start), to: new Date(end) });
  }

  let synced = 0;
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i]!;
    synced += await syncTransactions(slice.from, slice.to);
    await onSliceProgress?.(i + 1, slices.length, synced);
  }

  await recordTransactionRangeCoverage(dateFrom, dateTo);
  return synced;
}

/**
 * Targeted punch sync for a single employee (by emp_code) within a date range.
 * Much lighter than {@link syncTransactions} — only pulls that employee's punches,
 * so it comfortably fits within request timeouts for on-demand exports.
 */
export async function syncEmployeeTransactions(
  empCodes: string[],
  dateFrom?: Date,
  dateTo?: Date,
  jobId?: string,
): Promise<number> {
  const codes = [...new Set(empCodes.map((c) => c?.trim()).filter(Boolean))] as string[];
  if (!codes.length) return 0;

  const connector = await BioTimeConnector.fromDb();
  const config = await prisma.bioTimeConfig.findFirst();
  const pageSize = 100;
  const range = formatBioTimeRange(dateFrom, dateTo);
  let syncedCount = 0;
  const totalEmployees = codes.length;

  for (let empIndex = 0; empIndex < codes.length; empIndex++) {
    const empCode = codes[empIndex]!;
    let page = 1;
    let errorsCount = 0;
    const filters: Record<string, unknown> = { ...range, emp_code: empCode };

    if (jobId) {
      const base = Math.round((empIndex / Math.max(totalEmployees, 1)) * 90) + 5;
      await prisma.syncJob.update({
        where: { id: jobId },
        data: {
          message: `سحب بصمات الموظف ${empCode} (${empIndex + 1}/${totalEmployees})…`,
          progress: Math.min(95, Math.max(5, base)),
        },
      }).catch(() => undefined);
    }

    while (page <= 200) {
      let response;
      try {
        response = await fetchTransactionsPage(connector, page, pageSize, filters);
        errorsCount = 0;
      } catch (err) {
        errorsCount++;
        logger.warn({ err, page, empCode }, 'Employee transaction sync page failed');
        if (errorsCount >= 3) break;
        page++;
        continue;
      }

      const rows = response.data ?? [];
      if (!rows.length) break;

      for (const row of rows) {
        try {
          const result = await syncSingleTransaction(row, config);
          if (result !== 'skipped') syncedCount++;
        } catch (err) {
          logger.warn({ err, biotimeId: row.id }, 'sync single transaction failed');
        }
      }

      if (jobId && page % 2 === 0) {
        const empPct = (empIndex + Math.min(1, page / 20)) / Math.max(totalEmployees, 1);
        const progress = Math.min(95, Math.max(5, Math.round(empPct * 90) + 5));
        await prisma.syncJob.update({
          where: { id: jobId },
          data: {
            message: `سحب ${empCode} — صفحة ${page} (تم ${syncedCount} بصمة)`,
            progress,
          },
        }).catch(() => undefined);
      }

      const totalCount = response.count ?? 0;
      const isLastPage = rows.length < pageSize;
      const allFetched = totalCount > 0 && page * pageSize >= totalCount;
      if (!response.next || isLastPage || allFetched) break;
      page++;
    }
  }

  if (dateFrom || dateTo) {
    // The fetch loop above is done; this used to run silently over every
    // company punch in the range, leaving the UI stuck on "N/N". Scope it to
    // the employees we just pulled and report it as its own phase.
    if (jobId) {
      await prisma.syncJob.update({
        where: { id: jobId },
        data: {
          message: 'تمت مزامنة البصمات — جاري معالجة البيانات وتجهيز التقرير…',
          progress: 95,
        },
      }).catch(() => undefined);
    }
    await remarkDuplicatesInRange(dateFrom, dateTo, {
      empCodes: codes,
      onProgress: jobId
        ? async (done, total) => {
            await prisma.syncJob.update({
              where: { id: jobId },
              data: {
                message: `جاري معالجة البيانات وتجهيز التقرير… (${done}/${total})`,
                progress: Math.min(99, 95 + Math.round((done / Math.max(total, 1)) * 4)),
              },
            }).catch(() => undefined);
          }
        : undefined,
    });
  }

  logger.info({ syncedCount, empCodes: codes, dateFrom, dateTo }, 'Employee transaction sync complete');
  return syncedCount;
}

/** Incremental punch sync — mirrors Odoo cron_sync_transactions window */
export async function syncTransactionsIncremental(jobId?: string): Promise<number> {
  const config = await prisma.bioTimeConfig.findFirst();
  const now = new Date();
  const overlapMs = 5 * 60 * 1000;
  const totalInDb = await prisma.transaction.count();

  let dateFrom: Date;
  if (totalInDb < 100) {
    dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (config?.lastTransactionSync) {
    dateFrom = new Date(config.lastTransactionSync.getTime() - overlapMs);
  } else {
    dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  return syncTransactions(dateFrom, now, jobId);
}

export async function syncAll(): Promise<{
  employees: number;
  departments: number;
  devices: number;
  transactions: number;
}> {
  const departments = await syncDepartments();
  const employees = await syncEmployees();
  const devices = await syncDevices();
  const transactions = await syncTransactionsIncremental();
  return { employees, departments, devices, transactions };
}

export interface ScheduledSyncResult {
  skipped: boolean;
  reason?: string;
  jobId?: string;
  employees?: number;
  departments?: number;
  devices?: number;
  transactions?: number;
  push?: EmployeePushResult;
}

/**
 * Full BioTime pull cycle — departments → employees → devices → incremental transactions.
 * Used by cron (every 12h) and optional startup catch-up.
 */
/** Queue full BioTime sync (HTTP returns immediately with jobId). */
export async function queueBioTimeSync(
  trigger: 'manual' | 'cron' | 'startup' = 'manual',
): Promise<ScheduledSyncResult> {
  const config = await prisma.bioTimeConfig.findFirst();
  if (!config?.serverIp) {
    return { skipped: true, reason: 'BioTime server not configured' };
  }

  if (await isSyncLocked()) {
    return { skipped: true, reason: 'Another sync job is already running' };
  }

  const job = await createSyncJob(
    trigger === 'manual' ? 'biotime_manual' : 'biotime_scheduled',
    'Queued — starting BioTime sync',
  );

  setImmediate(() => {
    void runScheduledBioTimeSync(trigger, job.id).catch((err) => {
      logger.error({ err, jobId: job.id }, 'Background BioTime sync failed');
    });
  });

  return { skipped: false, jobId: job.id };
}

export async function runScheduledBioTimeSync(
  trigger: 'cron' | 'startup' | 'manual' = 'cron',
  existingJobId?: string,
): Promise<ScheduledSyncResult> {
  const config = await prisma.bioTimeConfig.findFirst();
  if (!config?.serverIp) {
    return { skipped: true, reason: 'BioTime server not configured' };
  }

  if (trigger !== 'manual' && !config.scheduledAutoSyncEnabled) {
    return { skipped: true, reason: 'Scheduled auto sync is disabled in settings' };
  }

  if (!existingJobId && (await isSyncLocked())) {
    return { skipped: true, reason: 'Another sync job is already running' };
  }

  const job = existingJobId
    ? await prisma.syncJob.update({
        where: { id: existingJobId },
        data: {
          status: SyncJobStatus.running,
          message: `BioTime sync (${trigger})`,
          startedAt: new Date(),
          progress: 0,
        },
      })
    : await createSyncJob(
        trigger === 'manual' ? 'biotime_manual' : 'biotime_scheduled',
        `BioTime sync (${trigger})`,
      );

  const result: ScheduledSyncResult = { skipped: false, jobId: job.id };

  try {
    const connector = await BioTimeConnector.fromDb();
    await connector.testConnection();

    let departments = 0;
    let employees = 0;
    let devices = 0;
    let transactions = 0;
    let push: EmployeePushResult | undefined;

    if (config.autoSyncDepartments) {
      await prisma.syncJob.update({
        where: { id: job.id },
        data: { message: 'Syncing departments', progress: 10 },
      });
      departments = await syncDepartments();
    }

    if (config.autoSyncEmployees) {
      if (config.autoPushToBiotime) {
        await prisma.syncJob.update({
          where: { id: job.id },
          data: {
            message: 'رفع التغييرات المحلية إلى BioTime (تزامن ذكي)…',
            progress: 25,
          },
        });
        push = await pushPendingEmployeesToBioTime();
        logger.info({ trigger, push }, 'BioTime smart employee push before pull');
      }

      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          message: config.autoPushToBiotime
            ? 'جلب الموظفين من BioTime…'
            : 'مزامنة الموظفين (جلب من BioTime)…',
          progress: 35,
        },
      });
      employees = await syncEmployees();
    }

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { message: 'Syncing devices', progress: 55 },
    });
    devices = await syncDevices();

    if (config.autoSyncTransactions) {
      await prisma.syncJob.update({
        where: { id: job.id },
        data: { message: 'Syncing transactions', progress: 75 },
      });
      transactions = await syncTransactionsIncremental(job.id);
    }

    const pushSummary = push
      ? `push ${push.pushed}↑ ${push.skipped}≡ ${push.failed}✗, `
      : '';
    const summary = `Done: ${pushSummary}${departments} depts, ${employees} employees, ${devices} devices, ${transactions} punches`;
    await finishSyncJob(job.id, SyncJobStatus.done, summary);
    logger.info(
      { trigger, push, departments, employees, devices, transactions },
      'BioTime scheduled sync complete',
    );

    return { ...result, push, departments, employees, devices, transactions };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed';
    await finishSyncJob(job.id, SyncJobStatus.failed, msg);
    logger.error({ err, trigger }, 'BioTime scheduled sync failed');
    throw err;
  }
}

/** Pull from BioTime only — no push of local employee edits to BioTime. */
export async function runBioTimePullOnly(existingJobId?: string): Promise<ScheduledSyncResult> {
  const config = await prisma.bioTimeConfig.findFirst();
  if (!config?.serverIp) {
    return { skipped: true, reason: 'BioTime server not configured' };
  }

  if (!existingJobId && (await isSyncLocked())) {
    return { skipped: true, reason: 'Another sync job is already running' };
  }

  const job = existingJobId
    ? await prisma.syncJob.update({
        where: { id: existingJobId },
        data: {
          status: SyncJobStatus.running,
          message: 'Pull from BioTime (pull only)',
          startedAt: new Date(),
          progress: 0,
        },
      })
    : await createSyncJob('biotime_pull', 'Pull from BioTime (pull only)');

  const result: ScheduledSyncResult = { skipped: false, jobId: job.id };

  try {
    const connector = await BioTimeConnector.fromDb();
    await connector.testConnection();

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { message: 'جلب الأقسام من BioTime…', progress: 10 },
    });
    const departments = await syncDepartments();

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { message: 'جلب الموظفين من BioTime…', progress: 35 },
    });
    const employees = await syncEmployees();

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { message: 'جلب الأجهزة…', progress: 55 },
    });
    const devices = await syncDevices();

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { message: 'جلب البصمات الجديدة…', progress: 75 },
    });
    const transactions = await syncTransactionsIncremental(job.id);

    const summary = `Pull only: ${departments} depts, ${employees} employees, ${devices} devices, ${transactions} punches`;
    await finishSyncJob(job.id, SyncJobStatus.done, summary);
    logger.info({ departments, employees, devices, transactions }, 'BioTime pull-only complete');
    return { ...result, departments, employees, devices, transactions };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Pull failed';
    await finishSyncJob(job.id, SyncJobStatus.failed, msg);
    logger.error({ err }, 'BioTime pull-only failed');
    throw err;
  }
}

export async function queueBioTimePullOnly(): Promise<ScheduledSyncResult> {
  const config = await prisma.bioTimeConfig.findFirst();
  if (!config?.serverIp) {
    return { skipped: true, reason: 'BioTime server not configured' };
  }

  if (await isSyncLocked()) {
    return { skipped: true, reason: 'Another sync job is already running' };
  }

  const job = await createSyncJob('biotime_pull', 'Queued — pull from BioTime (pull only)');

  setImmediate(() => {
    void runBioTimePullOnly(job.id).catch((err) => {
      logger.error({ err, jobId: job.id }, 'Background BioTime pull-only failed');
    });
  });

  return { skipped: false, jobId: job.id };
}

export async function getSyncStatus() {
  const config = await prisma.bioTimeConfig.findFirst();
  const recentJobs = await prisma.syncJob.findMany({
    where: { jobType: { in: [...BIOTIME_SYNC_JOB_TYPES] } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  const counts = {
    employees: await prisma.employeeProfile.count(),
    departments: await prisma.department.count(),
    devices: await prisma.device.count(),
    transactions: await prisma.transaction.count(),
  };

  return {
    config: config
      ? {
          isConnected: config.isConnected,
          serverIp: config.serverIp,
          autoSyncEmployees: config.autoSyncEmployees,
          autoSyncDepartments: config.autoSyncDepartments,
          autoSyncTransactions: config.autoSyncTransactions,
          scheduledAutoSyncEnabled: config.scheduledAutoSyncEnabled,
          autoPushToBiotime: config.autoPushToBiotime,
          employeeSyncIntervalHours: config.employeeSyncIntervalHours,
          transactionSyncIntervalMins: config.transactionSyncIntervalMins,
          lastEmployeeSync: config.lastEmployeeSync?.toISOString() ?? null,
          lastDepartmentSync: config.lastDepartmentSync?.toISOString() ?? null,
          lastTransactionSync: config.lastTransactionSync?.toISOString() ?? null,
        }
      : null,
    counts,
    recentJobs: recentJobs.map((j) => ({
      id: j.id,
      jobType: j.jobType,
      status: j.status,
      progress: j.progress,
      message: j.message,
      startedAt: j.startedAt?.toISOString() ?? null,
      finishedAt: j.finishedAt?.toISOString() ?? null,
      createdAt: j.createdAt.toISOString(),
    })),
  };
}
