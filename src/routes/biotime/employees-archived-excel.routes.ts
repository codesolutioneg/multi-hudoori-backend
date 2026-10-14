import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { getHrLocationScopeFromReq } from '../../services/userLocationScope.service';
import {
  exportArchivedEmployeesFullXlsx,
  exportArchiveStatusTemplateXlsx,
  importArchiveStatusXlsx,
} from '../../services/employeeArchivedExcel.service';
import { writeAudit } from '../../services/auditLog.service';
import { AppError } from '../../utils/errors';

const router = Router();

router.post(
  '/employees/archived/export-xlsx',
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const hrScope = await getHrLocationScopeFromReq(req);
    const file = await exportArchivedEmployeesFullXlsx(hrScope);
    await writeAudit({
      req,
      module: 'employees',
      action: 'employees.archived_export',
      summary: 'تصدير Excel لجميع الموظفين المؤرشفين (نفس سكيما بيانات الموظفين)',
      route: '/employees/archived/export-xlsx',
    });
    jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
  }),
);

router.post(
  '/employees/archived/template-xlsx',
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const file = await exportArchiveStatusTemplateXlsx();
    await writeAudit({
      req,
      module: 'employees',
      action: 'employees.archived_template_export',
      summary: 'تصدير قالب أرشفة/إلغاء أرشفة (empcode / التاريخ / السبب)',
      route: '/employees/archived/template-xlsx',
    });
    jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
  }),
);

router.post(
  '/employees/archived/import-xlsx',
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const base64 = String(p(req).base64 ?? '');
    if (!base64.trim()) {
      jsonRpcSuccess(res, biotimeFail('ملف Excel مطلوب', 'VALIDATION'), req.rpcId);
      return;
    }
    const hrScope = await getHrLocationScopeFromReq(req);
    const actor =
      (req as { user?: { email?: string; name?: string; id?: string } }).user?.email ||
      (req as { user?: { name?: string; id?: string } }).user?.name ||
      (req as { user?: { id?: string } }).user?.id ||
      null;
    try {
      const result = await importArchiveStatusXlsx(base64, hrScope, actor);
      await writeAudit({
        req,
        module: 'employees',
        action: 'employees.archived_import',
        summary: result.message,
        counts: {
          archived: result.archived,
          archiveUpdated: result.archiveUpdated,
          restored: result.restored,
          skipped: result.skipped,
        },
        diffPreview: result.details.slice(0, 100).map((d) => ({
          entityLabel: d.name ? `${d.name} (${d.code})` : d.code,
          field: d.action,
          before: null,
          after: null,
          note: d.detail,
        })),
        route: '/employees/archived/import-xlsx',
      });
      jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Import failed';
      const code = e instanceof AppError ? e.errorCode : 'ACTION_ERROR';
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

export default router;
