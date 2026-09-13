import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { prisma } from '../../prisma/client';
import { weeklyPatternToAssignmentFields, type WeeklyPatternInput } from '../../services/shiftGridAssignment.service';

const router = Router();

router.post('/shift-assignments/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const items = await prisma.shiftAssignment.findMany({
    include: { shift: true, employee: true },
    orderBy: { dateFrom: 'desc' },
  });
  jsonRpcSuccess(res, biotimeOk({ assignments: items.map(shiftAssignmentJson), count: items.length }), req.rpcId);
}));

router.post('/shift-assignments/get', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? '');
  const item = await prisma.shiftAssignment.findUnique({
    where: { id },
    include: { shift: true, employee: true },
  });
  if (!item) {
    jsonRpcSuccess(res, biotimeFail('Not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  jsonRpcSuccess(res, biotimeOk({ assignment: shiftAssignmentJson(item) }), req.rpcId);
}));

router.post('/shift-assignments/create', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const employeeId = String(params.employeeId ?? '').trim();
  const shiftId = String(params.shiftId ?? '').trim();
  const assignmentType = String(params.assignmentType ?? 'date_range');
  if (!employeeId) {
    jsonRpcSuccess(res, biotimeFail('اختر موظفاً', 'VALIDATION'), req.rpcId);
    return;
  }
  if (!shiftId && (assignmentType === 'permanent' || assignmentType === 'date_range')) {
    jsonRpcSuccess(res, biotimeFail('اختر شيفتاً', 'VALIDATION'), req.rpcId);
    return;
  }
  const employee = await prisma.employeeProfile.findUnique({ where: { id: employeeId } });
  if (!employee) {
    jsonRpcSuccess(res, biotimeFail('Employee not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  if (!employee.active) {
    jsonRpcSuccess(res, biotimeFail('لا يمكن تعيين شيفت لموظف مؤرشف', 'EMPLOYEE_ARCHIVED'), req.rpcId);
    return;
  }
  const reqLocationId = params.locationId ? String(params.locationId) : null;
  if (reqLocationId && employee.locationId !== reqLocationId) {
    jsonRpcSuccess(res, biotimeFail('الموظف لا ينتمي لهذا الموقع', 'VALIDATION'), req.rpcId);
    return;
  }
  const weekly = params.weekly as WeeklyPatternInput | undefined;
  const weeklyFields = weeklyPatternToAssignmentFields(weekly);
  const item = await prisma.shiftAssignment.create({
    data: {
      employeeId,
      shiftId: shiftId || null,
      dateFrom: new Date(String(params.dateFrom ?? new Date().toISOString().slice(0, 10))),
      dateTo: params.dateTo ? new Date(String(params.dateTo)) : null,
      weekDays: params.weekDays ? String(params.weekDays) : null,
      assignmentType,
      notes: params.notes ? String(params.notes) : null,
      ...weeklyFields,
    },
    include: { shift: true, employee: true },
  });
  jsonRpcSuccess(res, biotimeOk({ assignment: shiftAssignmentJson(item) }), req.rpcId);
}));

router.post('/shift-assignments/update', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? '');
  const weekly = params.weekly as WeeklyPatternInput | undefined;
  const weeklyFields = weekly ? weeklyPatternToAssignmentFields(weekly) : {};
  const item = await prisma.shiftAssignment.update({
    where: { id },
    data: {
      shiftId: params.shiftId !== undefined ? (params.shiftId ? String(params.shiftId) : null) : undefined,
      dateFrom: params.dateFrom ? new Date(String(params.dateFrom)) : undefined,
      dateTo: params.dateTo ? new Date(String(params.dateTo)) : undefined,
      assignmentType: params.assignmentType ? String(params.assignmentType) : undefined,
      notes: params.notes !== undefined ? String(params.notes) : undefined,
      weekDays: params.weekDays !== undefined ? String(params.weekDays) : undefined,
      active: params.active !== undefined ? Boolean(params.active) : undefined,
      ...weeklyFields,
    },
    include: { shift: true, employee: true },
  });
  jsonRpcSuccess(res, biotimeOk({ assignment: shiftAssignmentJson(item) }), req.rpcId);
}));

export default router;
