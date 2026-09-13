import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { NotFoundError, AppError } from '../../utils/errors';
import { archiveEmployee, restoreEmployee } from '../../services/employeeArchive.service';
import { syncEmployeeLoginFromWorkEmail } from '../../services/employeeLogin.service';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { deleteEmployee } from '../../services/employeeDelete.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { prisma } from '../../prisma/client';
import { writeAudit, assertCanDeleteEmployee } from '../../services/auditLog.service';

const router = Router();

router.post('/employees/delete', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  await assertCanDeleteEmployee(req);
  const id = String(p(req).id ?? p(req).employeeId ?? '');
  if (!id) {
    jsonRpcSuccess(res, biotimeFail('employeeId required', 'VALIDATION'), req.rpcId);
    return;
  }
  try {
    const result = await deleteEmployee(id);
    await writeAudit({
      req,
      module: 'employees',
      action: 'employees.delete',
      entityType: 'EmployeeProfile',
      entityId: id,
      summary: `حذف موظف: ${result.employeeName || id}`,
      payload: {
        name: result.employeeName,
        deletedAppUser: result.deletedAppUser,
      },
      diffPreview: [{
        field: 'name',
        before: result.employeeName,
        after: null,
        note: 'تم الحذف نهائياً',
        entityLabel: result.employeeName || id,
      }],
      route: '/employees/delete',
    });
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...result,
        message: result.deletedAppUser
          ? `تم حذف الموظف ${result.employeeName} وحساب التطبيق المرتبط`
          : `تم حذف الموظف ${result.employeeName}`,
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Delete failed';
    const code = e instanceof NotFoundError ? 'NOT_FOUND' : 'ACTION_ERROR';
    jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
  }
}));

router.post('/employees/archive', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const employeeId = String(params.employeeId ?? params.id ?? '');
  const reason = String(params.reason ?? '');
  const archivedAtRaw = params.archivedAt ?? params.departureAt ?? null;
  if (!employeeId) {
    jsonRpcSuccess(res, biotimeFail('employeeId required', 'VALIDATION'), req.rpcId);
    return;
  }
  const existing = await prisma.employeeProfile.findUnique({ where: { id: employeeId } });
  if (!existing) {
    jsonRpcSuccess(res, biotimeFail('Employee not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const hrScope = await getHrLocationScopeFromReq(req);
  assertEmployeeLocationAccess(hrScope, existing.locationId);
  try {
    const employee = await archiveEmployee(
      employeeId,
      reason,
      req.user!.id,
      archivedAtRaw ? String(archivedAtRaw) : null,
    );
    await syncEmployeeLoginFromWorkEmail(employeeId);
    await writeAudit({
      req,
      module: 'employees',
      action: 'employees.archive',
      entityType: 'EmployeeProfile',
      entityId: employeeId,
      summary: `أرشفة موظف: ${employee.name || employeeId}`,
      payload: {
        name: employee.name,
        code: employee.code,
        reason: reason || null,
      },
      diffPreview: [
        {
          field: 'active',
          before: true,
          after: false,
          note: reason || 'أرشفة',
          entityLabel: employee.name || employeeId,
        },
      ],
      route: '/employees/archive',
    });
    jsonRpcSuccess(res, biotimeOk({
      employee: employeeJson(employee, true),
      message: 'تمت أرشفة الموظف',
    }), req.rpcId);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Archive failed';
    const code = e instanceof AppError ? e.errorCode : 'ACTION_ERROR';
    jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
  }
}));

router.post('/employees/restore', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const employeeId = String(params.employeeId ?? params.id ?? '');
  if (!employeeId) {
    jsonRpcSuccess(res, biotimeFail('employeeId required', 'VALIDATION'), req.rpcId);
    return;
  }
  const existing = await prisma.employeeProfile.findUnique({ where: { id: employeeId } });
  if (!existing) {
    jsonRpcSuccess(res, biotimeFail('Employee not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const hrScope = await getHrLocationScopeFromReq(req);
  assertEmployeeLocationAccess(hrScope, existing.locationId);
  try {
    const employee = await restoreEmployee(employeeId);
    await syncEmployeeLoginFromWorkEmail(employeeId);
    await writeAudit({
      req,
      module: 'employees',
      action: 'employees.restore',
      entityType: 'EmployeeProfile',
      entityId: employeeId,
      summary: `استعادة موظف: ${employee.name || employeeId}`,
      route: '/employees/restore',
    });
    jsonRpcSuccess(res, biotimeOk({
      employee: employeeJson(employee, true),
      message: 'تمت استعادة الموظف',
    }), req.rpcId);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Restore failed';
    const code = e instanceof AppError ? e.errorCode : 'ACTION_ERROR';
    jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
  }
}));

export default router;
