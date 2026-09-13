import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { enforceShiftGridAccess, shiftGridPayload } from './shift-grid-helpers';
import { AdvanceState, DeductionState, PayrollState, ShiftGridState, HiringAppointmentStatus, UserRole } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { applyEmployeeLocation, employeesForLocation, resolveLocation, relocateEmployeesToGridLocation, } from '../../services/location.service';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { parseGridGrouping } from '../../services/shiftGridGrouping.service';
import { countGridSummary, employeeCanRemoveFromGrid, flagsToLineData, formatGridCellLabel, getLatestSyncStatus, getShiftGridData, getShiftGridDataPaged, getShiftGridMeta, gridCellFromLine, parseCellFlags, transferEmployeeBetweenGrids, } from '../../services/shiftGridData.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { parsePagination, paginationMeta } from '../../utils/pagination';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/shift-grid/list', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const { limit, offset, page } = parsePagination(params, { limit: 30, maxLimit: 100 });
  const where: Prisma.ShiftGridWhereInput = {};
  if (params.state) where.state = String(params.state) as ShiftGridState;
  if (params.deviceId) where.deviceId = String(params.deviceId);

  const locationScope = await getHrLocationScope(req.user!.id, req.user!.role);
  if (locationScope) where.locationId = locationScope;

  const [total, grids] = await Promise.all([
    prisma.shiftGrid.count({ where }),
    prisma.shiftGrid.findMany({
      where,
      include: { device: true, location: true, _count: { select: { lines: true } } },
      // Secondary id keeps pages stable — dateFrom alone duplicates/skips rows.
      orderBy: [{ dateFrom: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset,
    }),
  ]);
  const items = await Promise.all(
    grids.map(async (g) => {
      const summary = await countGridSummary(g.id);
      return shiftGridJson(g, summary);
    }),
  );
  jsonRpcSuccess(
    res,
    biotimeOk({
      grids: items,
      items,
      ...paginationMeta(total, limit, offset, page),
    }),
    req.rpcId,
  );
}));

router.post('/shift-grid/get', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.gridId ?? '');
  const payload = await shiftGridPayload(id, {
    includeData: params.includeData !== false,
    metaOnly: params.metaOnly === true,
    employeeLimit: params.employeeLimit != null ? Number(params.employeeLimit) : undefined,
    employeeOffset: params.employeeOffset != null ? Number(params.employeeOffset) : undefined,
    grouping: parseGridGrouping(params.grouping),
    req,
  });
  if (!payload) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  jsonRpcSuccess(res, biotimeOk(payload), req.rpcId);
}));

router.post('/shift-grid/update', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.gridId ?? params.id ?? '');
  const existing = await prisma.shiftGrid.findUnique({ where: { id } });
  if (!existing) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  await enforceShiftGridAccess(req, existing.locationId);
  if (existing.state === 'confirmed') {
    jsonRpcSuccess(res, biotimeFail('الجدول مؤكد — لا يمكن التعديل', 'VALIDATION'), req.rpcId);
    return;
  }

  let locationId = params.locationId ? String(params.locationId) : existing.locationId;
  let gridLocation = params.gridLocation ? String(params.gridLocation).trim() : existing.gridLocation;
  const selectionMethod = params.selectionMethod ? String(params.selectionMethod) : existing.selectionMethod;

  const locationScope = await getHrLocationScope(req.user!.id, req.user!.role);
  if (locationScope) {
    locationId = locationScope;
    const scopedLoc = await resolveLocation(locationScope);
    gridLocation = scopedLoc.name;
  } else if (locationId && params.locationId) {
    const loc = await resolveLocation(locationId);
    gridLocation = loc.name;
  }

  const employeeIds = Array.isArray(params.employeeIds)
    ? params.employeeIds.map(String)
    : undefined;
  const departmentIds = Array.isArray(params.departmentIds)
    ? params.departmentIds.map(String)
    : undefined;

  const grid = await prisma.shiftGrid.update({
    where: { id },
    data: {
      ...(params.dateFrom ? { dateFrom: new Date(String(params.dateFrom)) } : {}),
      ...(params.dateTo ? { dateTo: new Date(String(params.dateTo)) } : {}),
      ...(params.name ? { name: String(params.name) } : {}),
      selectionMethod,
      conflictAction: params.conflictAction ? String(params.conflictAction) : undefined,
      ...(employeeIds !== undefined ? { employeeIds } : {}),
      ...(departmentIds !== undefined ? { departmentIds } : {}),
      deviceId:
        selectionMethod === 'device' && params.deviceId
          ? String(params.deviceId)
          : selectionMethod === 'device'
            ? existing.deviceId
            : null,
      locationId: selectionMethod === 'location' ? locationId : null,
      gridLocation: selectionMethod === 'location' ? gridLocation : null,
    } as Prisma.ShiftGridUncheckedUpdateInput,
    include: { device: true, location: true },
  });

  const payload = await shiftGridPayload(grid.id, { includeData: false, req });
  jsonRpcSuccess(res, biotimeOk(payload ?? { grid: shiftGridJson(grid, await countGridSummary(grid.id)) }), req.rpcId);
}));

export default router;
