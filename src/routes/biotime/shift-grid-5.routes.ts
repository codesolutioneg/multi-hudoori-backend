import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { enforceShiftGridAccess, loadShiftGridForAccess, shiftGridPayload } from './shift-grid-helpers';
import { countGridSummary, employeeCanRemoveFromGrid, flagsToLineData, formatGridCellLabel, getLatestSyncStatus, getShiftGridData, getShiftGridDataPaged, getShiftGridMeta, gridCellFromLine, parseCellFlags, transferEmployeeBetweenGrids, } from '../../services/shiftGridData.service';
import {
  listManualOtLines,
  addManualOtLine,
  updateManualOtLine,
  deleteManualOtLine,
} from '../../services/shiftGridManualOt.service';
import { prisma } from '../../prisma/client';
import { utcDateOnly, utcEndOfDay } from '../../utils/payrollPeriod';

const router = Router();

router.post('/shift-grid/remove-employee', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  const employeeId = String(params.employeeId ?? '');
  if (!employeeId) {
    jsonRpcSuccess(res, biotimeFail('employeeId required', 'MISSING_PARAM'), req.rpcId);
    return;
  }

  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  if (grid.state === 'confirmed') {
    jsonRpcSuccess(res, biotimeFail('الجدول مؤكد — افتحه للتعديل أولاً', 'UPDATE_FAILED'), req.rpcId);
    return;
  }
  await enforceShiftGridAccess(req, grid.locationId);

  const lines = await prisma.shiftGridLine.findMany({ where: { gridId, employeeId } });
  if (!lines.length) {
    jsonRpcSuccess(res, biotimeFail('الموظف غير موجود في الجدول', 'NOT_FOUND'), req.rpcId);
    return;
  }
  if (!employeeCanRemoveFromGrid(lines)) {
    jsonRpcSuccess(
      res,
      biotimeFail('لا يمكن الحذف — يوجد شيفتات أو تعيينات على هذا الموظف', 'VALIDATION'),
      req.rpcId,
    );
    return;
  }

  await prisma.shiftGridLine.deleteMany({ where: { gridId, employeeId } });
  const payload = await shiftGridPayload(gridId, { includeData: false, req });
  jsonRpcSuccess(res, biotimeOk(payload ?? { message: 'تم حذف الموظف من الجدول' }), req.rpcId);
}));

router.post('/shift-grid/transfer-employee', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const fromGridId = String(params.gridId ?? params.fromGridId ?? '');
  const toGridId = String(params.targetGridId ?? params.toGridId ?? '');
  const employeeId = String(params.employeeId ?? '');
  if (!fromGridId || !toGridId || !employeeId) {
    jsonRpcSuccess(res, biotimeFail('gridId و targetGridId و employeeId مطلوبة', 'MISSING_PARAM'), req.rpcId);
    return;
  }

  const fromGrid = await prisma.shiftGrid.findUnique({ where: { id: fromGridId } });
  const toGrid = await prisma.shiftGrid.findUnique({ where: { id: toGridId } });
  if (!fromGrid || !toGrid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  await enforceShiftGridAccess(req, fromGrid.locationId);
  await enforceShiftGridAccess(req, toGrid.locationId);

  try {
    const result = await transferEmployeeBetweenGrids(fromGridId, toGridId, employeeId);
    const payload = await shiftGridPayload(fromGridId, { includeData: false, req });
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...(payload ?? {}),
        transfer: result,
        message: result.locationChanged
          ? 'تم نقل الموظف وتحديث الفرع'
          : 'تم نقل الموظف للجدول المحدد',
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Transfer failed';
    jsonRpcSuccess(res, biotimeFail(msg, 'ACTION_ERROR'), req.rpcId);
  }
}));

router.post('/shift-grid/punches', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const lineId = String(params.lineId ?? params.id ?? '');
  const line = await prisma.shiftGridLine.findUnique({
    where: { id: lineId },
    include: { employee: { include: { mapping: true } } },
  });
  if (!line) {
    jsonRpcSuccess(res, biotimeFail('Line not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const grid = await prisma.shiftGrid.findUnique({ where: { id: line.gridId } });
  await enforceShiftGridAccess(req, grid?.locationId);

  const dayStart = utcDateOnly(line.date);
  const dayEnd = utcEndOfDay(line.date);

  const empCode = line.employee.mapping?.biotimeEmpCode ?? line.employee.code ?? '';
  const punches = await prisma.transaction.findMany({
    where: {
      punchTime: { gte: dayStart, lte: dayEnd },
      ...(empCode ? { empCode } : { employeeId: line.employeeId }),
    },
    orderBy: { punchTime: 'asc' },
  });

  jsonRpcSuccess(res, biotimeOk({
    employeeName: line.employee.name,
    date: line.date.toISOString().slice(0, 10),
    items: punches.map((t) => ({
      id: t.id,
      punchTime: t.punchTime.toISOString(),
      empCode: t.empCode ?? '',
      punchState: t.punchState ?? '',
      terminalAlias: t.terminalAlias ?? '',
      verifyType: 0,
    })),
    count: punches.length,
  }), req.rpcId);
}));

router.post('/shift-grid/manual-ot/list', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const gridId = String(p(req).gridId ?? p(req).id ?? '');
  if (!gridId) {
    jsonRpcSuccess(res, biotimeFail('معرّف الجدول مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const result = await listManualOtLines(gridId);
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'فشل جلب الإضافي اليدوي', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

router.post('/shift-grid/manual-ot/add', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  const employeeId = String(params.employeeId ?? '');
  const date = String(params.date ?? '');
  if (!gridId || !employeeId || !date) {
    jsonRpcSuccess(res, biotimeFail('gridId و employeeId و date مطلوبين', 'VALIDATION'), req.rpcId);
    return;
  }
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const line = await addManualOtLine({
      gridId,
      employeeId,
      date,
      note: params.note != null ? String(params.note) : null,
    });
    jsonRpcSuccess(res, biotimeOk({ line }), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'فشل إضافة السطر', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

router.post('/shift-grid/manual-ot/update', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  const id = String(params.id ?? params.lineId ?? '');
  if (!gridId || !id) {
    jsonRpcSuccess(res, biotimeFail('gridId و id مطلوبين', 'VALIDATION'), req.rpcId);
    return;
  }
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const line = await updateManualOtLine({
      id,
      gridId,
      date: params.date != null ? String(params.date) : undefined,
      note: params.note !== undefined ? (params.note == null ? null : String(params.note)) : undefined,
    });
    jsonRpcSuccess(res, biotimeOk({ line }), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'فشل تحديث السطر', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

router.post('/shift-grid/manual-ot/delete', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  const id = String(params.id ?? params.lineId ?? '');
  if (!gridId || !id) {
    jsonRpcSuccess(res, biotimeFail('gridId و id مطلوبين', 'VALIDATION'), req.rpcId);
    return;
  }
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const result = await deleteManualOtLine({ id, gridId });
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'فشل حذف السطر', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

export default router;
