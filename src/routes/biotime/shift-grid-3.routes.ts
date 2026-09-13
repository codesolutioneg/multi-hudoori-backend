import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { enforceShiftGridAccess, shiftGridPayload } from './shift-grid-helpers';
import { Prisma } from '@prisma/client';
import { countGridSummary, employeeCanRemoveFromGrid, flagsToLineData, formatGridCellLabel, getLatestSyncStatus, getShiftGridData, getShiftGridDataPaged, getShiftGridMeta, gridCellFromLine, parseCellFlags, transferEmployeeBetweenGrids, } from '../../services/shiftGridData.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { prisma } from '../../prisma/client';
import { writeAudit, shallowFieldDiffs } from '../../services/auditLog.service';
import { utcDateOnly } from '../../utils/payrollPeriod';
import {
  applyMergedLifecycleAction,
  lifecycleActionFromFlags,
  syncEmployeeLifecycleFromCellFlags,
} from '../../services/shiftGridEmployeeLifecycle.service';

const router = Router();

router.post('/shift-grid/cell/update', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  const lineId = String(params.lineId ?? params.id ?? '').trim();
  const employeeId = String(params.employeeId ?? '').trim();
  const dateRaw = String(params.date ?? '').trim();
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid || grid.state === 'confirmed') {
    jsonRpcSuccess(res, biotimeFail('Cannot update cell (locked or invalid)', 'UPDATE_FAILED'), req.rpcId);
    return;
  }
  await enforceShiftGridAccess(req, grid.locationId);

  let existing = lineId
    ? await prisma.shiftGridLine.findUnique({ where: { id: lineId }, include: { shift: true } })
    : null;

  // Empty UI cells have no ShiftGridLine yet (common after merge when an
  // employee only appears on some weeks). Create on first edit.
  if (!existing) {
    if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      jsonRpcSuccess(res, biotimeFail('Line not found', 'NOT_FOUND'), req.rpcId);
      return;
    }
    const day = utcDateOnly(new Date(`${dateRaw}T00:00:00.000Z`));
    const from = utcDateOnly(grid.dateFrom);
    const to = utcDateOnly(grid.dateTo);
    if (day < from || day > to) {
      jsonRpcSuccess(res, biotimeFail('التاريخ خارج فترة الجدول', 'VALIDATION'), req.rpcId);
      return;
    }
    existing = await prisma.shiftGridLine.upsert({
      where: { gridId_employeeId_date: { gridId, employeeId, date: day } },
      create: { gridId, employeeId, date: day },
      update: {},
      include: { shift: true },
    });
    if (!grid.employeeIds.includes(employeeId)) {
      await prisma.shiftGrid.update({
        where: { id: gridId },
        data: { employeeIds: { push: employeeId } },
      });
    }
  } else if (existing.gridId !== gridId) {
    jsonRpcSuccess(res, biotimeFail('Line not found', 'NOT_FOUND'), req.rpcId);
    return;
  }

  const flags = parseCellFlags(params as Record<string, unknown>, existing.shiftId);
  const lineData = flagsToLineData(flags);
  const line = await prisma.shiftGridLine.update({
    where: { id: existing.id },
    data: lineData,
    include: { shift: true },
  });

  await syncEmployeeLifecycleFromCellFlags(existing.employeeId, flags, {
    actor: req.user?.id,
  });

  const beforeSnap: Record<string, unknown> = {};
  const afterSnap: Record<string, unknown> = {};
  for (const key of Object.keys(lineData) as (keyof typeof lineData)[]) {
    beforeSnap[key] = (existing as Record<string, unknown>)[key] ?? null;
    afterSnap[key] = (line as Record<string, unknown>)[key] ?? null;
  }
  await writeAudit({
    req,
    module: 'shift_grid',
    action: 'shift_grid.cell.update',
    entityType: 'ShiftGridLine',
    entityId: existing.id,
    summary: `تعديل خلية جدول: ${grid.name || gridId}`,
    diffPreview: shallowFieldDiffs(beforeSnap, afterSnap, {
      entityId: existing.id,
      entityLabel: existing.employeeId,
    }),
    payload: {
      gridId,
      employeeId: existing.employeeId,
      date: existing.date instanceof Date ? existing.date.toISOString().slice(0, 10) : existing.date,
      before: beforeSnap,
      after: afterSnap,
      created: !lineId,
    },
    route: '/shift-grid/cell/update',
  });

  jsonRpcSuccess(
    res,
    biotimeOk({
      display_label: formatGridCellLabel(line),
      line: shiftGridLineJson(line),
      cell: gridCellFromLine(line),
    }),
    req.rpcId,
  );
}));

router.post('/shift-grid/bulk/row', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const employeeId = String(params.employeeId ?? '');
  const gridId = String(params.gridId ?? '');
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid || grid.state === 'confirmed') {
    jsonRpcSuccess(res, biotimeFail('Cannot update row (locked)', 'UPDATE_FAILED'), req.rpcId);
    return;
  }
  await enforceShiftGridAccess(req, grid.locationId);

  const sample = await prisma.shiftGridLine.findFirst({ where: { gridId, employeeId } });
  const flags = parseCellFlags(params as Record<string, unknown>, sample?.shiftId ?? null);
  const afterFlags = flagsToLineData(flags);
  const lineWhere: Prisma.ShiftGridLineWhereInput = { gridId, employeeId };

  if (params.dateFrom && params.dateTo) {
    const dateFrom = new Date(String(params.dateFrom));
    const dateTo = new Date(String(params.dateTo));
    if (dateFrom < grid.dateFrom || dateTo > grid.dateTo || dateFrom > dateTo) {
      jsonRpcSuccess(res, biotimeFail('الفترة يجب أن تكون ضمن فترة الجدول', 'VALIDATION'), req.rpcId);
      return;
    }
    lineWhere.date = { gte: dateFrom, lte: dateTo };
  }

  await prisma.shiftGridLine.updateMany({
    where: lineWhere,
    data: afterFlags,
  });
  await syncEmployeeLifecycleFromCellFlags(employeeId, flags, {
    actor: req.user?.id,
  });
  const payload = await shiftGridPayload(gridId, { includeData: false, req });
  await writeAudit({
    req,
    module: 'shift_grid',
    action: 'shift_grid.bulk.row',
    entityType: 'ShiftGrid',
    entityId: gridId,
    summary: `تعديل صف جدول: ${grid.name || gridId}`,
    payload: {
      gridId,
      employeeId,
      dateFrom: params.dateFrom ? String(params.dateFrom) : null,
      dateTo: params.dateTo ? String(params.dateTo) : null,
      after: afterFlags,
    },
    route: '/shift-grid/bulk/row',
  });
  jsonRpcSuccess(res, biotimeOk(payload ?? { message: 'Row updated' }), req.rpcId);
}));

router.post('/shift-grid/bulk/column', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  const date = new Date(String(params.date));
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid || grid.state === 'confirmed') {
    jsonRpcSuccess(res, biotimeFail('Cannot update column (locked)', 'UPDATE_FAILED'), req.rpcId);
    return;
  }
  await enforceShiftGridAccess(req, grid.locationId);

  const sample = await prisma.shiftGridLine.findFirst({ where: { gridId, date } });
  const flags = parseCellFlags(params as Record<string, unknown>, sample?.shiftId ?? null);
  const afterFlags = flagsToLineData(flags);
  await prisma.shiftGridLine.updateMany({
    where: { gridId, date },
    data: afterFlags,
  });

  const action = lifecycleActionFromFlags(flags);
  if (action !== 'none') {
    const columnLines = await prisma.shiftGridLine.findMany({
      where: { gridId, date },
      select: { employeeId: true },
      distinct: ['employeeId'],
    });
    for (const row of columnLines) {
      await applyMergedLifecycleAction(row.employeeId, action, {
        actor: req.user?.id,
      });
    }
  }

  const payload = await shiftGridPayload(gridId, { includeData: false, req });
  await writeAudit({
    req,
    module: 'shift_grid',
    action: 'shift_grid.bulk.column',
    entityType: 'ShiftGrid',
    entityId: gridId,
    summary: `تعديل عمود جدول: ${grid.name || gridId}`,
    payload: {
      gridId,
      date: date.toISOString().slice(0, 10),
      before: sample
        ? {
            shiftId: sample.shiftId,
            isOff: sample.isOff,
            isSick: sample.isSick,
            isAnnualLeave: sample.isAnnualLeave,
            isExcluded: sample.isExcluded,
            isBusDelay: sample.isBusDelay,
            isPresent: sample.isPresent,
            isFinished: sample.isFinished,
            isResignation: sample.isResignation,
            isWorkAbsence: sample.isWorkAbsence,
            isWorkInjury: sample.isWorkInjury,
            isMarriageLeave: sample.isMarriageLeave,
          }
        : null,
      after: afterFlags,
    },
    route: '/shift-grid/bulk/column',
  });
  jsonRpcSuccess(res, biotimeOk(payload ?? { message: 'Column updated' }), req.rpcId);
}));

export default router;
