import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { applyEmployeeLocation, employeesForLocation, resolveLocation, relocateEmployeesToGridLocation, } from '../../services/location.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/departments/delete', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).departmentId ?? '');
  const inUse = await prisma.employeeProfile.count({ where: { departmentId: id } });
  if (inUse > 0) {
    jsonRpcSuccess(res, biotimeFail(`القسم مستخدم من ${inUse} موظف`, 'IN_USE'), req.rpcId);
    return;
  }
  await prisma.department.delete({ where: { id } });
  jsonRpcSuccess(res, biotimeOk({ message: 'Deleted' }), req.rpcId);
}));

router.post('/devices/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const devices = await prisma.device.findMany({
    where: { active: true },
    include: { location: true },
    orderBy: { name: 'asc' },
  });
  jsonRpcSuccess(res, biotimeOk({ devices: devices.map(deviceJson), count: devices.length }), req.rpcId);
}));

router.post('/devices/update', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.deviceId ?? params.id ?? '');
  if (!id) {
    jsonRpcSuccess(res, biotimeFail('deviceId required', 'VALIDATION_ERROR'), req.rpcId);
    return;
  }
  const existing = await prisma.device.findUnique({ where: { id } });
  if (!existing) {
    jsonRpcSuccess(res, biotimeFail('Device not found', 'NOT_FOUND'), req.rpcId);
    return;
  }

  let locationId: string | null | undefined;
  if ('locationId' in params) {
    locationId = params.locationId ? String(params.locationId) : null;
    if (locationId) await resolveLocation(locationId);
  }

  const device = await prisma.device.update({
    where: { id },
    data: {
      ...(params.name != null ? { name: String(params.name).trim() } : {}),
      ...(params.alias != null ? { alias: String(params.alias).trim() || null } : {}),
      ...(locationId !== undefined ? { locationId } : {}),
    },
    include: { location: true },
  });
  jsonRpcSuccess(res, biotimeOk({ device: deviceJson(device) }), req.rpcId);
}));

// --- Payroll ---

export default router;
