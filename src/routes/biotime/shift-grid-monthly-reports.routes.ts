import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { writeAudit } from '../../services/auditLog.service';
import {
  exportMonthlyReportsTemplate,
  importMonthlyReports,
  listMonthlyReportPeriods,
} from '../../services/shiftGridMonthlyReports.service';

const router = Router();

router.post(
  '/shift-grid/monthly-reports/periods',
  requireAuth,
  requireHrOrBranchManager,
  asyncHandler(async (req, res) => {
    const periods = await listMonthlyReportPeriods();
    jsonRpcSuccess(res, biotimeOk({ periods, count: periods.length }), req.rpcId);
  }),
);

router.post(
  '/shift-grid/monthly-reports/export-template',
  requireAuth,
  requireHrOrBranchManager,
  asyncHandler(async (req, res) => {
    const params = p(req);
    try {
      const file = await exportMonthlyReportsTemplate({
        dateFrom: String(params.dateFrom ?? ''),
        dateTo: String(params.dateTo ?? ''),
      });
      await writeAudit({
        req,
        module: 'shift_grid',
        action: 'shift_grid.monthly_reports.export',
        entityType: 'ShiftGrid',
        entityId: '',
        summary: `تصدير قالب التقارير الشهرية: ${params.dateFrom} → ${params.dateTo}`,
        payload: { dateFrom: params.dateFrom, dateTo: params.dateTo },
        route: '/shift-grid/monthly-reports/export-template',
      });
      jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
    } catch (e: unknown) {
      jsonRpcSuccess(
        res,
        biotimeFail(e instanceof Error ? e.message : 'Export failed', 'ACTION_ERROR'),
        req.rpcId,
      );
    }
  }),
);

router.post(
  '/shift-grid/monthly-reports/import',
  requireAuth,
  requireHrOrBranchManager,
  asyncHandler(async (req, res) => {
    const params = p(req);
    try {
      const result = await importMonthlyReports({
        base64: String(params.file ?? params.base64 ?? ''),
        dateFrom: String(params.dateFrom ?? ''),
        dateTo: String(params.dateTo ?? ''),
      });
      await writeAudit({
        req,
        module: 'shift_grid',
        action: 'shift_grid.monthly_reports.import',
        entityType: 'ShiftGrid',
        entityId: '',
        summary: result.message,
        counts: {
          applied: result.applied,
          rejected: result.rejected.length,
          shiftUpdates: result.shiftUpdates,
          overtimeAdded: result.overtimeAdded,
          overtimeRemoved: result.overtimeRemoved,
          changeRows: result.changes.length,
        },
        // Applied + rejected (capped in writeAudit); full list also in payload.changes.
        diffPreview: result.changes.map((c) => ({
          entityId: c.entityId,
          entityLabel: c.entityLabel,
          field: c.field,
          before: c.before,
          after: c.after,
          note: c.note,
        })),
        payload: {
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
          changes: result.changes,
          rejected: result.rejected,
        },
        route: '/shift-grid/monthly-reports/import',
      });
      jsonRpcSuccess(
        res,
        biotimeOk({
          applied: result.applied,
          rejected: result.rejected,
          rejectedCount: result.rejected.length,
          shiftUpdates: result.shiftUpdates,
          overtimeAdded: result.overtimeAdded,
          overtimeRemoved: result.overtimeRemoved,
          skippedEmpty: result.skippedEmpty,
          changeCount: result.changes.length,
          message: result.message,
          failuresFile: result.failuresFile ?? null,
        }),
        req.rpcId,
      );
    } catch (e: unknown) {
      jsonRpcSuccess(
        res,
        biotimeFail(e instanceof Error ? e.message : 'Import failed', 'ACTION_ERROR'),
        req.rpcId,
      );
    }
  }),
);

export default router;
