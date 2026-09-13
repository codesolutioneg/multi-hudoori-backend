import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { loadShiftGridForAccess } from './shift-grid-helpers';
import * as generateJobService from '../../services/generateJob.service';
import * as overtimeService from '../../services/overtime.service';
import * as payrollService from '../../services/payroll.service';
import { exportShiftGridXlsx, importShiftGridXlsx, resolveGridExcelDateRange } from '../../services/shiftGridExcel.service';
import { prisma } from '../../prisma/client';
import { writeAudit } from '../../services/auditLog.service';

const router = Router();

router.post('/shift-grid/import-xlsx', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const file = String(params.file ?? params.base64 ?? '');
  const dateFrom = params.dateFrom != null ? String(params.dateFrom) : undefined;
  const dateTo = params.dateTo != null ? String(params.dateTo) : undefined;
  const createEmployeeCodes = Array.isArray(params.createEmployeeCodes)
    ? params.createEmployeeCodes.map(String)
    : undefined;
  try {
    const result = await importShiftGridXlsx(gridId, file, {
      dateFrom,
      dateTo,
      createEmployeeCodes,
    });
    const parts = [`تم تحديث ${result.updated} خلية`];
    if (result.cleared > 0) parts.push(`مسح ${result.cleared}`);
    if (result.createdEmployees > 0) parts.push(`إنشاء ${result.createdEmployees} موظف جديد`);
    if (result.added > 0) parts.push(`إضافة ${result.added} موظف للجدول`);
    if (result.relocated > 0) parts.push(`نقل ${result.relocated} موظف للموقع`);
    if (result.untrackedUsers.length > 0) {
      parts.push(`${result.untrackedUsers.length} موظف غير مسجل في النظام`);
    }
    if (dateFrom && dateTo) {
      parts.push(`النطاق ${String(dateFrom).slice(0, 10)} → ${String(dateTo).slice(0, 10)}`);
    }
    await writeAudit({
      req,
      module: 'shift_grid',
      action: 'shift_grid.import',
      entityType: 'ShiftGrid',
      entityId: gridId,
      summary: `استيراد جدول شيفت: ${grid.name || gridId}`,
      counts: {
        updated: result.updated,
        cleared: result.cleared,
        added: result.added,
        relocated: result.relocated,
        createdEmployees: result.createdEmployees,
        untracked: result.untrackedUsers.length,
        archived: result.archivedCodes?.length ?? 0,
      },
      diffPreview: [
        ...result.createdCodes.map((code) => ({
          field: 'code',
          after: code,
          note: 'موظف جديد من استيراد الجدول',
          entityLabel: code,
        })),
        ...(result.archivedCodes ?? []).map((code) => ({
          field: 'active',
          before: true as unknown,
          after: false as unknown,
          note: 'أرشفة تلقائية (خروج)',
          entityLabel: code,
        })),
        ...result.untrackedUsers.slice(0, 100).map((u) => ({
          field: 'code',
          before: u.code,
          after: null as unknown,
          note: u.reason,
          entityLabel: u.excelName || u.code,
          entityId: u.code,
        })),
        ...(dateFrom || dateTo
          ? [{
              field: 'dateFrom',
              after: `${dateFrom ?? '—'} → ${dateTo ?? '—'}`,
              note: 'نطاق الاستيراد',
            }]
          : []),
      ],
      payload: {
        dateFrom: dateFrom ?? null,
        dateTo: dateTo ?? null,
        createdCodes: result.createdCodes,
        archivedCodes: result.archivedCodes ?? [],
        skippedCodes: result.skippedCodes,
        untrackedUsers: result.untrackedUsers.slice(0, 100),
        errors: result.errors.slice(0, 30),
      },
      route: '/shift-grid/import-xlsx',
    });
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...result,
        message: parts.join(' — '),
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
}));

router.post('/overtime/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const state = p(req).state ? String(p(req).state) : undefined;
  const items = await overtimeService.listOvertime(state as import('@prisma/client').RequestState | undefined);
  jsonRpcSuccess(res, biotimeOk({ items: items.map(overtimeService.overtimeJson), count: items.length }), req.rpcId);
}));

router.post('/overtime/generate', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const jobId = await generateJobService.queueOvertimeGenerate(
    new Date(String(params.dateFrom)),
    new Date(String(params.dateTo)),
    params.employeeIds as string[] | undefined,
  );
  jsonRpcSuccess(res, biotimeOk({ jobId, queued: true, message: 'Overtime generation started' }), req.rpcId);
}));

router.post('/overtime/approve', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? '');
  const row = await overtimeService.approveOvertime(id, req.user!.id);
  jsonRpcSuccess(res, biotimeOk({ item: overtimeService.overtimeJson(row) }), req.rpcId);
}));

router.post('/overtime/reject', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const row = await overtimeService.rejectOvertime(String(params.id), req.user!.id, String(params.reason ?? ''));
  jsonRpcSuccess(res, biotimeOk({ item: overtimeService.overtimeJson(row) }), req.rpcId);
}));

router.post('/payroll/my', requireAuth, asyncHandler(async (req, res) => {
  if (req.user!.role === UserRole.EMPLOYEE) {
    jsonRpcSuccess(
      res,
      biotimeFail('حساب الموظف يعرض الحضور والجدول فقط', 'READ_ONLY'),
      req.rpcId,
    );
    return;
  }
  const records = await payrollService.myPayroll(req.user!.id);
  jsonRpcSuccess(res, biotimeOk({ records, count: records.length }), req.rpcId);
}));

// --- Deductions ---

export default router;
