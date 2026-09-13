import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { loadShiftGridForAccess, shiftGridPayload } from './shift-grid-helpers';
import { Prisma } from '@prisma/client';
import { applyEmployeeLocation, employeesForLocation, resolveLocation, relocateEmployeesToGridLocation, } from '../../services/location.service';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { confirmShiftGridAssignments, resyncShiftGridDates, closeShiftGrid, reopenShiftGrid, backShiftGridToSetup, } from '../../services/shiftGridLifecycle.service';
import { countGridSummary, employeeCanRemoveFromGrid, flagsToLineData, formatGridCellLabel, getLatestSyncStatus, getShiftGridData, getShiftGridDataPaged, getShiftGridMeta, gridCellFromLine, parseCellFlags, transferEmployeeBetweenGrids, } from '../../services/shiftGridData.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { generateShiftGridLines } from '../../services/shiftGridGenerate.service';
import { prisma } from '../../prisma/client';
import { writeAudit } from '../../services/auditLog.service';
import {
  clearShiftGridAssignments,
  deleteShiftGrid,
  wipeShiftGridEmployees,
} from '../../services/shiftGridClear.service';

const router = Router();

router.post('/shift-grid/create', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const locationScope = await getHrLocationScope(req.user!.id, req.user!.role);
  let locationId = locationScope ?? (params.locationId ? String(params.locationId) : null);
  let gridLocation = params.gridLocation ? String(params.gridLocation).trim() : null;
  if (locationId) {
    const loc = await resolveLocation(locationId);
    gridLocation = loc.name;
  } else if (gridLocation) {
    const loc = await prisma.location.findFirst({
      where: { name: { equals: gridLocation, mode: 'insensitive' }, active: true },
    });
    if (loc) locationId = loc.id;
  }

  const employeeIds = Array.isArray(params.employeeIds) ? params.employeeIds.map(String) : [];
  const departmentIds = Array.isArray(params.departmentIds) ? params.departmentIds.map(String) : [];
  const selectionMethod = String(params.selectionMethod ?? (locationId ? 'location' : params.deviceId ? 'device' : 'manual'));

  const device = selectionMethod === 'device' && params.deviceId
    ? await prisma.device.findUnique({ where: { id: String(params.deviceId) } })
    : null;
  const location = selectionMethod === 'location' && locationId
    ? await prisma.location.findUnique({ where: { id: locationId } })
    : null;

  const grid = await prisma.shiftGrid.create({
    data: {
      name: String(params.name ?? location?.name ?? device?.name ?? device?.alias ?? gridLocation ?? 'Shift Grid'),
      dateFrom: new Date(String(params.dateFrom)),
      dateTo: new Date(String(params.dateTo)),
      selectionMethod,
      conflictAction: String(params.conflictAction ?? 'replace'),
      employeeIds,
      departmentIds,
      deviceId: selectionMethod === 'device' && params.deviceId ? String(params.deviceId) : null,
      gridLocation: selectionMethod === 'location' ? gridLocation : null,
      locationId: selectionMethod === 'location' ? locationId : null,
    } as Prisma.ShiftGridUncheckedCreateInput,
    include: { device: true, location: true },
  });

  if (locationId && employeeIds.length > 0) {
    await relocateEmployeesToGridLocation(employeeIds, locationId);
  }

  if (params.generate === true || params.generate === 'true') {
    try {
      await generateShiftGridLines(grid.id, { employeeIds, departmentIds });
    } catch (e: unknown) {
      jsonRpcSuccess(
        res,
        biotimeFail(e instanceof Error ? e.message : 'Generate failed', 'ACTION_ERROR'),
        req.rpcId,
      );
      return;
    }
  }

  const payload = await shiftGridPayload(grid.id, { includeData: false, req });
  await writeAudit({
    req,
    module: 'shift_grid',
    action: 'shift_grid.create',
    entityType: 'ShiftGrid',
    entityId: grid.id,
    summary: `إنشاء جدول شيفت: ${grid.name || grid.id}`,
    payload: {
      dateFrom: grid.dateFrom,
      dateTo: grid.dateTo,
      selectionMethod: grid.selectionMethod,
      employeeCount: employeeIds.length,
      generate: params.generate === true || params.generate === 'true',
    },
    route: '/shift-grid/create',
  });
  jsonRpcSuccess(res, biotimeOk(payload ?? { grid: shiftGridJson(grid, await countGridSummary(grid.id)) }), req.rpcId);
}));

router.post('/shift-grid/create-all-locations', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = String(params.dateFrom ?? '');
  const dateTo = String(params.dateTo ?? '');
  if (!dateFrom || !dateTo) {
    jsonRpcSuccess(res, biotimeFail('dateFrom و dateTo مطلوبان', 'VALIDATION'), req.rpcId);
    return;
  }
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  const locationScope = await getHrLocationScope(req.user!.id, req.user!.role);
  const locations = await prisma.location.findMany({
    where: {
      active: true,
      ...(locationScope ? { id: locationScope } : {}),
    },
    orderBy: { name: 'asc' },
  });

  const created: Array<{ locationId: string; name: string; gridId: string; employeeCount: number }> = [];
  const skipped: Array<{ locationId: string; name: string; gridId: string; reason: string }> = [];
  const errors: Array<{ locationId: string; name: string; error: string }> = [];

  for (const loc of locations) {
    const existing = await prisma.shiftGrid.findFirst({
      where: { locationId: loc.id, dateFrom: from, dateTo: to },
      select: { id: true },
    });
    if (existing) {
      skipped.push({ locationId: loc.id, name: loc.name, gridId: existing.id, reason: 'exists' });
      continue;
    }
    const employees = await employeesForLocation(loc.id, true);
    const employeeIds = employees.map((e) => e.id);
    try {
      const grid = await prisma.shiftGrid.create({
        data: {
          name: loc.name,
          dateFrom: from,
          dateTo: to,
          selectionMethod: 'location',
          conflictAction: 'replace',
          employeeIds,
          departmentIds: [],
          gridLocation: loc.name,
          locationId: loc.id,
        } as Prisma.ShiftGridUncheckedCreateInput,
      });
      if (employeeIds.length > 0) {
        await relocateEmployeesToGridLocation(employeeIds, loc.id);
        await generateShiftGridLines(grid.id, { employeeIds });
      }
      created.push({
        locationId: loc.id,
        name: loc.name,
        gridId: grid.id,
        employeeCount: employeeIds.length,
      });
    } catch (e: unknown) {
      errors.push({
        locationId: loc.id,
        name: loc.name,
        error: e instanceof Error ? e.message : 'فشل إنشاء الجدول',
      });
    }
  }

  await writeAudit({
    req,
    module: 'shift_grid',
    action: 'shift_grid.create_all_locations',
    entityType: 'ShiftGrid',
    entityId: created[0]?.gridId ?? '',
    summary: `إنشاء جداول لكل الفروع: ${created.length} جدول (${dateFrom} → ${dateTo})`,
    payload: { dateFrom, dateTo, createdCount: created.length, skippedCount: skipped.length, errorCount: errors.length },
    route: '/shift-grid/create-all-locations',
  });

  jsonRpcSuccess(
    res,
    biotimeOk({
      created,
      skipped,
      errors,
      createdCount: created.length,
      skippedCount: skipped.length,
      errorCount: errors.length,
    }),
    req.rpcId,
  );
}));

router.post('/shift-grid/generate', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? params.id ?? '');
  const gridForAccess = await loadShiftGridForAccess(req, gridId);
  if (!gridForAccess) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const employeeIds = Array.isArray(params.employeeIds) ? params.employeeIds.map(String) : undefined;
  const departmentIds = Array.isArray(params.departmentIds) ? params.departmentIds.map(String) : undefined;
  try {
    if (employeeIds || departmentIds || params.dateFrom || params.dateTo || params.conflictAction) {
      await prisma.shiftGrid.update({
        where: { id: gridId },
        data: {
          ...(params.dateFrom ? { dateFrom: new Date(String(params.dateFrom)) } : {}),
          ...(params.dateTo ? { dateTo: new Date(String(params.dateTo)) } : {}),
          ...(params.conflictAction ? { conflictAction: String(params.conflictAction) } : {}),
          ...(employeeIds ? { employeeIds } : {}),
          ...(departmentIds ? { departmentIds } : {}),
        } as Prisma.ShiftGridUncheckedUpdateInput,
      });
    }
    const count = await generateShiftGridLines(gridId, { employeeIds, departmentIds });
    const payload = await shiftGridPayload(gridId, { includeData: false, req });
    jsonRpcSuccess(res, biotimeOk({ ...(payload ?? {}), message: `Generated ${count} cells`, count }), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(res, biotimeFail(e instanceof Error ? e.message : 'Generate failed', 'ACTION_ERROR'), req.rpcId);
  }
}));

router.post('/shift-grid/back-to-setup', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const id = String(p(req).gridId ?? p(req).id ?? '');
  const grid = await loadShiftGridForAccess(req, id);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  await backShiftGridToSetup(id);
  const payload = await shiftGridPayload(id, { includeData: false, req });
  jsonRpcSuccess(res, biotimeOk(payload ?? {}), req.rpcId);
}));

router.post('/shift-grid/resync-dates', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const id = String(p(req).gridId ?? p(req).id ?? '');
  const grid = await loadShiftGridForAccess(req, id);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const result = await resyncShiftGridDates(id);
    const payload = await shiftGridPayload(id, { includeData: false, req });
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...(payload ?? {}),
        message: `تمت إضافة ${result.added} سطر، وحذف ${result.removed} سطر خارج الفترة.`,
        ...result,
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    jsonRpcSuccess(res, biotimeFail(e instanceof Error ? e.message : 'Resync failed', 'ACTION_ERROR'), req.rpcId);
  }
}));

router.post('/shift-grid/clear-assignments', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const gridId = String(p(req).gridId ?? p(req).id ?? '');
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const result = await clearShiftGridAssignments(gridId);
    await writeAudit({
      req,
      module: 'shift_grid',
      action: 'shift_grid.clear_assignments',
      entityType: 'ShiftGrid',
      entityId: gridId,
      summary: `تفريغ تعيينات جدول: ${grid.name || gridId}`,
      counts: { clearedCells: result.clearedCells },
      route: '/shift-grid/clear-assignments',
    });
    const payload = await shiftGridPayload(gridId, { includeData: false, req });
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...(payload ?? {}),
        ...result,
        message: `تم تفريغ ${result.clearedCells} خلية (الموظفون ما زالوا في الجدول)`,
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'Clear failed', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

router.post('/shift-grid/wipe-employees', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const gridId = String(p(req).gridId ?? p(req).id ?? '');
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const result = await wipeShiftGridEmployees(gridId);
    await writeAudit({
      req,
      module: 'shift_grid',
      action: 'shift_grid.wipe_employees',
      entityType: 'ShiftGrid',
      entityId: gridId,
      summary: `إزالة موظفي جدول: ${grid.name || gridId}`,
      counts: {
        removedLines: result.removedLines,
        removedManualOt: result.removedManualOt,
      },
      route: '/shift-grid/wipe-employees',
    });
    const payload = await shiftGridPayload(gridId, { includeData: false, req });
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...(payload ?? {}),
        ...result,
        message: `تمت إزالة ${result.removedLines} سطر من الجدول`,
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'Wipe failed', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

router.post('/shift-grid/delete', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const gridId = String(p(req).gridId ?? p(req).id ?? '');
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const result = await deleteShiftGrid(gridId);
    await writeAudit({
      req,
      module: 'shift_grid',
      action: 'shift_grid.delete',
      entityType: 'ShiftGrid',
      entityId: gridId,
      summary: `حذف جدول شيفت: ${result.name || gridId}`,
      payload: { name: result.name },
      route: '/shift-grid/delete',
    });
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...result,
        message: `تم حذف الجدول «${result.name}»`,
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'Delete failed', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

export default router;
