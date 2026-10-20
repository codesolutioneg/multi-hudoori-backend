import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { applyEmployeeLocation, employeesForLocation, resolveLocation, relocateEmployeesToGridLocation, } from '../../services/location.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { prisma } from '../../prisma/client';
import { writeAudit, shallowFieldDiffs } from '../../services/auditLog.service';

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

  const data = {
    ...(params.name != null ? { name: String(params.name).trim() } : {}),
    ...(params.alias != null ? { alias: String(params.alias).trim() || null } : {}),
    ...(locationId !== undefined ? { locationId } : {}),
  };

  const device = await prisma.device.update({
    where: { id },
    data,
    include: { location: true },
  });

  const label = device.alias || device.name || id;
  await writeAudit({
    req,
    module: 'settings',
    action: 'devices.update',
    entityType: 'Device',
    entityId: id,
    summary: `تعديل جهاز بصمة: ${label}`,
    diffPreview: shallowFieldDiffs(
      {
        name: existing.name,
        alias: existing.alias,
        locationId: existing.locationId,
      },
      {
        name: device.name,
        alias: device.alias,
        locationId: device.locationId,
      },
      { entityId: id, entityLabel: label, keys: Object.keys(data) },
    ),
    route: '/devices/update',
  });

  jsonRpcSuccess(res, biotimeOk({ device: deviceJson(device) }), req.rpcId);
}));

router.post('/devices/delete', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const id = String(p(req).deviceId ?? p(req).id ?? '');
  if (!id) {
    jsonRpcSuccess(res, biotimeFail('deviceId required', 'VALIDATION_ERROR'), req.rpcId);
    return;
  }
  const existing = await prisma.device.findUnique({ where: { id } });
  if (!existing) {
    jsonRpcSuccess(res, biotimeFail('Device not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  if (!existing.active) {
    jsonRpcSuccess(res, biotimeOk({ message: 'Already deleted', deviceId: id }), req.rpcId);
    return;
  }

  // Soft-delete so FKs (grids / imports) stay valid. Pull upsert does not reactivate.
  const device = await prisma.device.update({
    where: { id },
    data: { active: false },
  });
  const label = device.alias || device.name || id;
  await writeAudit({
    req,
    module: 'settings',
    action: 'devices.delete',
    entityType: 'Device',
    entityId: id,
    summary: `حذف جهاز بصمة: ${label}`,
    payload: {
      name: device.name,
      alias: device.alias,
      serialNumber: device.serialNumber,
      biotimeId: device.biotimeId,
      locationId: device.locationId,
    },
    route: '/devices/delete',
  });

  jsonRpcSuccess(res, biotimeOk({ message: 'Deleted', deviceId: id }), req.rpcId);
}));

// --- Payroll ---

export default router;
