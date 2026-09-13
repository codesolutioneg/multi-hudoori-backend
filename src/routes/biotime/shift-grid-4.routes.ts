import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { enforceShiftGridAccess, shiftGridPayload } from './shift-grid-helpers';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/shift-grid/add-employee', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  let employeeId = params.employeeId ? String(params.employeeId) : '';
  const employeeCode = (params.employeeCode ?? '').toString().trim();

  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  await enforceShiftGridAccess(req, grid.locationId);

  if (!employeeId && employeeCode) {
    const emp = await prisma.employeeProfile.findFirst({
      where: {
        active: true,
        OR: [
          { code: employeeCode },
          { identificationId: employeeCode },
          { barcode: employeeCode },
          { mapping: { biotimeEmpCode: employeeCode } },
          { name: { contains: employeeCode, mode: 'insensitive' } },
        ],
      },
    });
    if (!emp) {
      jsonRpcSuccess(res, biotimeFail(`لم يتم العثور على موظف بالكود "${employeeCode}"`, 'EMPLOYEE_NOT_FOUND'), req.rpcId);
      return;
    }
    employeeId = emp.id;
  }

  if (!employeeId) {
    jsonRpcSuccess(res, biotimeFail('employeeCode or employeeId is required', 'MISSING_PARAM'), req.rpcId);
    return;
  }

  const activeEmp = await prisma.employeeProfile.findFirst({
    where: {
      id: employeeId,
      active: true,
      ...(grid.locationId ? { locationId: grid.locationId } : {}),
      shiftGridLines: { none: { gridId } },
    },
    select: { id: true },
  });
  if (!activeEmp) {
    jsonRpcSuccess(
      res,
      biotimeFail(
        'الموظف موجود بالفعل في الجدول أو مؤرشف أو غير مرتبط بموقعه',
        'EMPLOYEE_NOT_AVAILABLE',
      ),
      req.rpcId,
    );
    return;
  }

  let d = new Date(grid.dateFrom);
  while (d <= grid.dateTo) {
    await prisma.shiftGridLine.upsert({
      where: { gridId_employeeId_date: { gridId, employeeId, date: new Date(d) } },
      create: { gridId, employeeId, date: new Date(d) },
      update: {},
    });
    d = new Date(d.getTime() + 86400000);
  }
  const payload = await shiftGridPayload(gridId, { includeData: false, req });
  jsonRpcSuccess(res, biotimeOk(payload ?? { message: 'Employee added to grid' }), req.rpcId);
}));

router.post('/shift-grid/add-employees', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  const employeeIds = Array.isArray(params.employeeIds)
    ? params.employeeIds.map(String).filter(Boolean)
    : [];

  if (!employeeIds.length) {
    jsonRpcSuccess(res, biotimeFail('employeeIds required', 'MISSING_PARAM'), req.rpcId);
    return;
  }

  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  await enforceShiftGridAccess(req, grid.locationId);

  const activeEmps = await prisma.employeeProfile.findMany({
    where: {
      id: { in: employeeIds },
      active: true,
      ...(grid.locationId ? { locationId: grid.locationId } : {}),
      shiftGridLines: { none: { gridId } },
    },
    select: { id: true },
  });
  const activeIds = activeEmps.map((e) => e.id);
  if (!activeIds.length) {
    jsonRpcSuccess(res, biotimeFail('لا يوجد موظفون نشطون للإضافة', 'EMPLOYEE_ARCHIVED'), req.rpcId);
    return;
  }

  for (const employeeId of activeIds) {
    let d = new Date(grid.dateFrom);
    while (d <= grid.dateTo) {
      await prisma.shiftGridLine.upsert({
        where: { gridId_employeeId_date: { gridId, employeeId, date: new Date(d) } },
        create: { gridId, employeeId, date: new Date(d) },
        update: {},
      });
      d = new Date(d.getTime() + 86400000);
    }
  }

  const payload = await shiftGridPayload(gridId, { includeData: false, req });
  jsonRpcSuccess(
    res,
    biotimeOk({
      ...(payload ?? {}),
      message: `تمت إضافة ${employeeIds.length} موظف`,
      count: employeeIds.length,
    }),
    req.rpcId,
  );
}));

export default router;
