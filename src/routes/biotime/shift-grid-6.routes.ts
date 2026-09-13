import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { loadShiftGridForAccess } from './shift-grid-helpers';
import * as syncService from '../../services/biotime/sync.service';
import { countGridSummary, employeeCanRemoveFromGrid, flagsToLineData, formatGridCellLabel, getLatestSyncStatus, getShiftGridData, getShiftGridDataPaged, getShiftGridMeta, gridCellFromLine, parseCellFlags, transferEmployeeBetweenGrids, } from '../../services/shiftGridData.service';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/shift-grid/sync/start', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const gridId = String(p(req).gridId ?? '');
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }

  await prisma.syncJob.updateMany({
    where: { gridId, status: 'running' },
    data: { status: 'cancelled', message: 'Replaced by new sync', finishedAt: new Date() },
  });

  const job = await prisma.syncJob.create({
    data: {
      gridId,
      jobType: 'grid_transactions',
      status: 'running',
      startedAt: new Date(),
      progress: 0,
      message: 'جاري الاتصال بـ BioTime...',
    },
  });

  void (async () => {
    try {
      const count = await syncService.syncTransactions(grid.dateFrom, grid.dateTo, job.id);
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'done',
          progress: 100,
          message: `Synced ${count} transactions`,
          finishedAt: new Date(),
        },
      });
    } catch (err) {
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          progress: 0,
          message: err instanceof Error ? err.message : 'Sync failed',
          finishedAt: new Date(),
        },
      });
    }
  })();

  const sync = await getLatestSyncStatus(gridId);
  jsonRpcSuccess(res, biotimeOk({ sync, ...sync, jobId: job.id }), req.rpcId);
}));

router.post('/shift-grid/sync/status', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  if (gridId) {
    const grid = await loadShiftGridForAccess(req, gridId);
    if (!grid) {
      jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
      return;
    }
    const sync = await getLatestSyncStatus(gridId);
    jsonRpcSuccess(res, biotimeOk(sync), req.rpcId);
    return;
  }
  const jobId = String(params.jobId ?? '');
  const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
  if (!job) {
    jsonRpcSuccess(res, biotimeFail('Job not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  jsonRpcSuccess(res, biotimeOk({
    syncState: job.status === 'running' ? 'syncing' : job.status === 'done' ? 'done' : 'error',
    syncProgress: job.progress ?? 0,
    syncMessage: job.message ?? '',
    syncSyncedCount: 0,
    syncTotalCount: 0,
    syncErrorsCount: job.status === 'failed' ? 1 : 0,
  }), req.rpcId);
}));

router.post('/shift-grid/sync/reset', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const gridId = String(p(req).gridId ?? '');
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  await prisma.syncJob.updateMany({
    where: { gridId, status: 'running' },
    data: { status: 'cancelled', finishedAt: new Date() },
  });
  const sync = await getLatestSyncStatus(gridId);
  jsonRpcSuccess(res, biotimeOk({ sync, ...sync }), req.rpcId);
}));

router.post('/shift-grid/sync/cancel', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  if (gridId) {
    const grid = await loadShiftGridForAccess(req, gridId);
    if (!grid) {
      jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
      return;
    }
    await prisma.syncJob.updateMany({
      where: { gridId, status: 'running' },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    const sync = await getLatestSyncStatus(gridId);
    jsonRpcSuccess(res, biotimeOk({ sync, ...sync }), req.rpcId);
    return;
  }
  const jobId = String(params.jobId ?? '');
  await prisma.syncJob.update({
    where: { id: jobId },
    data: { status: 'cancelled', finishedAt: new Date() },
  });
  jsonRpcSuccess(res, biotimeOk({ message: 'Cancelled' }), req.rpcId);
}));

export default router;
