import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { loadShiftGridForAccess, shiftGridPayload } from './shift-grid-helpers';
import { confirmShiftGridAssignments, resyncShiftGridDates, closeShiftGrid, reopenShiftGrid, backShiftGridToSetup, } from '../../services/shiftGridLifecycle.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { generateDepartmentCode, generateInsuranceCompanyCode, generateLocationCode, generateCustodyTypeCode, } from '../../services/settingsCode.service';
import { prisma } from '../../prisma/client';
import { writeAudit } from '../../services/auditLog.service';

const router = Router();

router.post('/shift-grid/close', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const id = String(p(req).gridId ?? p(req).id ?? '');
  const grid = await loadShiftGridForAccess(req, id);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  await closeShiftGrid(id);
  const payload = await shiftGridPayload(id, { includeData: false, req });
  jsonRpcSuccess(res, biotimeOk(payload ?? {}), req.rpcId);
}));

router.post('/shift-grid/reopen', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const id = String(p(req).gridId ?? p(req).id ?? '');
  const grid = await loadShiftGridForAccess(req, id);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  await reopenShiftGrid(id);
  const payload = await shiftGridPayload(id, { includeData: false, req });
  jsonRpcSuccess(res, biotimeOk(payload ?? {}), req.rpcId);
}));

router.post('/shift-grid/confirm', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const id = String(p(req).gridId ?? p(req).id ?? '');
  const grid = await loadShiftGridForAccess(req, id);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const result = await confirmShiftGridAssignments(id);
    const payload = await shiftGridPayload(id, { includeData: false, req });
    await writeAudit({
      req,
      module: 'shift_grid',
      action: 'shift_grid.confirm',
      entityType: 'ShiftGrid',
      entityId: id,
      summary: `تأكيد جدول شيفت: ${grid.name || id}`,
      counts: { created: result.created, skipped: result.skipped ?? 0 },
      route: '/shift-grid/confirm',
    });
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...(payload ?? {}),
        message: `تم تعيين الشيفتات لـ ${result.created} موظف${result.skipped ? ` (تم تخطي ${result.skipped})` : ''}`,
        ...result,
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    jsonRpcSuccess(res, biotimeFail(e instanceof Error ? e.message : 'Confirm failed', 'ACTION_ERROR'), req.rpcId);
  }
}));

router.post('/shift-grid/confirm-assignments', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const id = String(p(req).gridId ?? p(req).id ?? '');
  const grid = await loadShiftGridForAccess(req, id);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const result = await confirmShiftGridAssignments(id);
    const payload = await shiftGridPayload(id, { includeData: false, req });
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...(payload ?? {}),
        message: `تم تعيين الشيفتات لـ ${result.created} موظف`,
        ...result,
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    jsonRpcSuccess(res, biotimeFail(e instanceof Error ? e.message : 'Confirm failed', 'ACTION_ERROR'), req.rpcId);
  }
}));

router.post('/departments/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const activeOnly = params.activeOnly !== false && params.activeOnly !== 'false';
  const departments = await prisma.department.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
  });
  jsonRpcSuccess(res, biotimeOk({ departments: departments.map(departmentJson), count: departments.length }), req.rpcId);
}));

router.post('/departments/create', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const name = String(params.name ?? params.nameAr ?? '').trim();
  const nameEn = params.nameEn != null ? String(params.nameEn).trim() : '';
  if (!name) {
    jsonRpcSuccess(res, biotimeFail('اسم القسم بالعربية مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  let code = params.code ? String(params.code).trim() : '';
  if (!code) code = await generateDepartmentCode();
  const dup = await prisma.department.findFirst({ where: { code } });
  if (dup) {
    jsonRpcSuccess(res, biotimeFail(`كود "${code}" موجود`, 'DUPLICATE'), req.rpcId);
    return;
  }
  const department = await prisma.department.create({
    data: {
      name,
      nameEn: nameEn || null,
      code,
      active: params.active !== false && params.active !== 'false',
      sequence: Number(params.sequence ?? 10),
    },
  });
  jsonRpcSuccess(res, biotimeOk({ department: departmentJson(department) }), req.rpcId);
}));

router.post('/departments/update', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.departmentId ?? '');
  const department = await prisma.department.update({
    where: { id },
    data: {
      name: params.name != null ? String(params.name ?? params.nameAr).trim() : undefined,
      nameEn: params.nameEn !== undefined ? (String(params.nameEn).trim() || null) : undefined,
      active: params.active !== undefined ? params.active === true || params.active === 'true' : undefined,
      sequence: params.sequence != null ? Number(params.sequence) : undefined,
    },
  });
  jsonRpcSuccess(res, biotimeOk({ department: departmentJson(department) }), req.rpcId);
}));

export default router;
