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

router.post('/shift-grid/search-employee', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const query = String(params.query ?? params.q ?? '').trim();
  if (query.length < 2) {
    jsonRpcSuccess(res, biotimeFail('اكتب كود الموظف أو حرفين على الأقل من الاسم', 'VALIDATION'), req.rpcId);
    return;
  }

  const employees = await prisma.employeeProfile.findMany({
    where: {
      OR: [
        { code: { equals: query, mode: 'insensitive' } },
        { identificationId: { equals: query, mode: 'insensitive' } },
        { barcode: { equals: query, mode: 'insensitive' } },
        { mapping: { biotimeEmpCode: { equals: query, mode: 'insensitive' } } },
        { name: { contains: query, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      code: true,
      name: true,
      active: true,
      archivedAt: true,
      workLocation: { select: { name: true, actualName: true } },
    },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    take: 20,
  });
  if (!employees.length) {
    jsonRpcSuccess(res, biotimeOk({ employees: [] }), req.rpcId);
    return;
  }

  const employeeIds = employees.map((e) => e.id);
  const locationScope = await getHrLocationScope(req.user!.id, req.user!.role);
  const lineGroups = await prisma.shiftGridLine.groupBy({
    by: ['gridId', 'employeeId'],
    where: { employeeId: { in: employeeIds } },
    _count: { _all: true },
  });
  const gridsWithIds = await prisma.shiftGrid.findMany({
    where: { employeeIds: { hasSome: employeeIds } },
    select: { id: true, employeeIds: true },
  });

  const gridIdsByEmp = new Map<string, Map<string, number>>();
  const addGrid = (employeeId: string, gridId: string, lines: number) => {
    const perEmp = gridIdsByEmp.get(employeeId) ?? new Map<string, number>();
    perEmp.set(gridId, Math.max(perEmp.get(gridId) ?? 0, lines));
    gridIdsByEmp.set(employeeId, perEmp);
  };
  for (const row of lineGroups) addGrid(row.employeeId, row.gridId, row._count._all);
  for (const g of gridsWithIds) {
    for (const employeeId of g.employeeIds) {
      if (employeeIds.includes(employeeId)) addGrid(employeeId, g.id, 0);
    }
  }

  const allGridIds = [...new Set([...gridIdsByEmp.values()].flatMap((m) => [...m.keys()]))];
  const grids = await prisma.shiftGrid.findMany({
    where: {
      id: { in: allGridIds },
      ...(locationScope ? { locationId: locationScope } : {}),
    },
    select: {
      id: true,
      name: true,
      dateFrom: true,
      dateTo: true,
      state: true,
      mergedFromGridIds: true,
      mergedIntoGridId: true,
      location: { select: { name: true, actualName: true } },
    },
  });
  const gridById = new Map(grids.map((g) => [g.id, g]));
  const parentIds = [...new Set(grids.map((g) => g.mergedIntoGridId).filter((id): id is string => !!id))];
  const parents = parentIds.length
    ? await prisma.shiftGrid.findMany({
        where: { id: { in: parentIds } },
        select: { id: true, name: true, location: { select: { name: true } } },
      })
    : [];
  const parentById = new Map(parents.map((g) => [g.id, g]));
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);

  const result = employees.map((e) => {
    const perEmp = gridIdsByEmp.get(e.id) ?? new Map<string, number>();
    const items = [...perEmp.entries()]
      .map(([gridId, lineCount]) => {
        const g = gridById.get(gridId);
        if (!g) return null;
        const parent = g.mergedIntoGridId ? parentById.get(g.mergedIntoGridId) : null;
        return {
          id: g.id,
          name: g.name,
          locationName: g.location?.name ?? '',
          dateFrom: dayKey(g.dateFrom),
          dateTo: dayKey(g.dateTo),
          state: g.state,
          isMerged: g.mergedFromGridIds.length > 0,
          mergedIntoGridId: g.mergedIntoGridId,
          mergedIntoName: parent
            ? `${parent.name}${parent.location?.name ? ` — ${parent.location.name}` : ''}`
            : null,
          lineCount,
        };
      })
      .filter((g): g is NonNullable<typeof g> => g != null)
      .sort((a, b) => (a.dateFrom === b.dateFrom ? a.name.localeCompare(b.name) : b.dateFrom.localeCompare(a.dateFrom)));
    return {
      id: e.id,
      code: e.code ?? '',
      name: e.name ?? '',
      active: e.active && !e.archivedAt,
      locationName: e.workLocation?.name ?? '',
      grids: items,
    };
  });

  jsonRpcSuccess(res, biotimeOk({ employees: result }), req.rpcId);
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
