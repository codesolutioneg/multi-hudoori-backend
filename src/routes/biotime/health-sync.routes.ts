import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p, getConfig } from './route-helpers';
import * as syncService from '../../services/biotime/sync.service';
import { config } from '../../config';
import { countHealthCertificateAlerts, listHealthCertificateAlerts } from '../../services/healthCertificate.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/health-certificates/alerts', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const alerts = await listHealthCertificateAlerts();
  jsonRpcSuccess(res, biotimeOk({ alerts, count: alerts.length }), req.rpcId);
}));

router.post('/config/sync-employees', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  try {
    const count = await syncService.syncEmployees();
    const config = await getConfig();
    jsonRpcSuccess(res, biotimeOk({ config: await configSettingsWithCounts(config), message: `تمت المزامنة: ${count} سجل`, count }), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(res, biotimeFail(e instanceof Error ? e.message : 'Sync failed', 'ACTION_ERROR'), req.rpcId);
  }
}));

router.post('/config/sync-departments', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const count = await syncService.syncDepartments();
  const config = await getConfig();
  jsonRpcSuccess(res, biotimeOk({ config: await configSettingsWithCounts(config), message: `تمت المزامنة: ${count} سجل`, count }), req.rpcId);
}));

router.post('/config/sync-devices', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const count = await syncService.syncDevices();
  const config = await getConfig();
  jsonRpcSuccess(res, biotimeOk({ config: await configSettingsWithCounts(config), message: `تمت المزامنة: ${count} سجل`, count }), req.rpcId);
}));

router.post('/config/sync-transactions', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = params.dateFrom ? new Date(String(params.dateFrom)) : undefined;
  const dateTo = params.dateTo ? new Date(String(params.dateTo)) : undefined;
  const count = dateFrom || dateTo
    ? await syncService.syncTransactions(dateFrom, dateTo)
    : await syncService.syncTransactionsIncremental();
  const config = await getConfig();
  jsonRpcSuccess(res, biotimeOk({ config: await configSettingsWithCounts(config), message: `تمت المزامنة: ${count} سجل`, count }), req.rpcId);
}));

router.post('/config/sync-all', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const result = await syncService.queueBioTimeSync('manual');
  if (result.skipped) {
    jsonRpcSuccess(res, biotimeFail(result.reason ?? 'Sync skipped', 'SYNC_SKIPPED'), req.rpcId);
    return;
  }
  jsonRpcSuccess(
    res,
    biotimeOk({
      message: 'بدأت المزامنة في الخلفية — تابع الحالة من إعدادات البصمة',
      jobId: result.jobId,
      queued: true,
    }),
    req.rpcId,
  );
}));

router.post('/config/sync-pull', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const result = await syncService.queueBioTimePullOnly();
  if (result.skipped) {
    jsonRpcSuccess(res, biotimeFail(result.reason ?? 'Pull skipped', 'SYNC_SKIPPED'), req.rpcId);
    return;
  }
  jsonRpcSuccess(
    res,
    biotimeOk({
      message: 'بدأ الجلب من BioTime (pull only) — بدون رفع تعديلات محلية',
      jobId: result.jobId,
      queued: true,
    }),
    req.rpcId,
  );
}));

router.post('/config/sync-status', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const status = await syncService.getSyncStatus();
  jsonRpcSuccess(res, biotimeOk(status), req.rpcId);
}));

router.post('/config/sync-jobs/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const jobs = await prisma.syncJob.findMany({
    where: { jobType: { in: ['biotime_scheduled', 'biotime_manual', 'biotime_pull'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  jsonRpcSuccess(
    res,
    biotimeOk({
      jobs: jobs.map((j) => ({
        id: j.id,
        jobType: j.jobType,
        status: j.status,
        progress: j.progress,
        message: j.message,
        startedAt: j.startedAt?.toISOString() ?? null,
        finishedAt: j.finishedAt?.toISOString() ?? null,
        createdAt: j.createdAt.toISOString(),
      })),
      count: jobs.length,
    }),
    req.rpcId,
  );
}));

// --- Employees ---

export default router;
