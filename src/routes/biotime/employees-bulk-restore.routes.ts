import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { getHrLocationScopeFromReq } from '../../services/userLocationScope.service';
import {
  exportArchivedEmployeesXlsx,
  importBulkRestoreXlsx,
} from '../../services/employeeBulkRestore.service';
import { writeAudit } from '../../services/auditLog.service';
import { AppError } from '../../utils/errors';

const router = Router();

router.post('/employees/bulk-restore/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const hrScope = await getHrLocationScopeFromReq(req);
  const file = await exportArchivedEmployeesXlsx(hrScope);
  await writeAudit({
    req,
    module: 'employees',
    action: 'employees.bulk_restore_export',
    summary: 'تصدير Excel للموظفين المؤرشفين (إلغاء أرشفة جماعي)',
    route: '/employees/bulk-restore/export-xlsx',
  });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

router.post('/employees/bulk-restore/import-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const base64 = String(p(req).base64 ?? '');
  if (!base64.trim()) {
    jsonRpcSuccess(res, biotimeFail('ملف Excel مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  const hrScope = await getHrLocationScopeFromReq(req);
  try {
    const result = await importBulkRestoreXlsx(base64, hrScope);
    await writeAudit({
      req,
      module: 'employees',
      action: 'employees.bulk_restore',
      summary: result.message,
      counts: {
        restored: result.restored.length,
        rejected: result.rejected.length,
        skippedEmpty: result.skippedEmpty,
      },
      diffPreview: [
        ...result.restored.map((r) => ({
          entityId: r.employeeId,
          entityLabel: `${r.name} (${r.code})`,
          field: 'active',
          before: false,
          after: true,
          note: 'إلغاء أرشفة',
        })),
        ...result.rejected.map((r) => ({
          entityLabel: r.name ? `${r.name} (${r.code})` : r.code,
          field: 'reject',
          before: null,
          after: null,
          note: r.reason,
        })),
      ],
      route: '/employees/bulk-restore/import-xlsx',
    });
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Import failed';
    const code = e instanceof AppError ? e.errorCode : 'ACTION_ERROR';
    jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
  }
}));

export default router;
