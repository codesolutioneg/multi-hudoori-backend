import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrOrBranchManager, isBranchManagerUser } from '../../middlewares/auth';
import { p } from './route-helpers';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { assertShiftLocationAccess, listShiftsForLocationScope } from '../../services/shiftsScope.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { prisma } from '../../prisma/client';
import { shiftJsonExtras, shiftTimesFromParams, sortShiftsForDisplay, validateShiftTimes } from '../../services/shiftCalculations.service';

const router = Router();

router.post('/shifts/list', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const shifts = isBranchManagerUser(req)
    ? sortShiftsForDisplay(await prisma.shift.findMany())
    : await listShiftsForLocationScope(await getHrLocationScopeFromReq(req));
  jsonRpcSuccess(res, biotimeOk({ shifts: shifts.map(shiftJson), count: shifts.length }), req.rpcId);
}));

router.post('/shifts/get', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).shiftId ?? '').trim();
  if (!id) {
    jsonRpcSuccess(res, biotimeFail('معرّف الشيفت مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  const shift = await prisma.shift.findUnique({ where: { id } });
  if (!shift) {
    jsonRpcSuccess(res, biotimeFail('الشيفت غير موجود', 'NOT_FOUND'), req.rpcId);
    return;
  }
  if (!isBranchManagerUser(req)) {
    const locationScope = await getHrLocationScopeFromReq(req);
    await assertShiftLocationAccess(locationScope, id);
  }
  jsonRpcSuccess(res, biotimeOk({ shift: shiftJson(shift) }), req.rpcId);
}));

router.post('/shifts/create', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const name = String(params.name ?? '').trim();
  const code = String(params.code ?? '').trim();
  if (!name) {
    jsonRpcSuccess(res, biotimeFail('اسم الشيفت مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  if (!code) {
    jsonRpcSuccess(res, biotimeFail('كود الشيفت مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }

  const times = shiftTimesFromParams(params);
  const timeError = validateShiftTimes(times.startFloat, times.endFloat);
  if (timeError) {
    jsonRpcSuccess(res, biotimeFail(timeError, 'VALIDATION'), req.rpcId);
    return;
  }

  const duplicate = await prisma.shift.findFirst({ where: { code } });
  if (duplicate) {
    jsonRpcSuccess(res, biotimeFail(`كود الشيفت "${code}" موجود بالفعل`, 'DUPLICATE'), req.rpcId);
    return;
  }

  const shift = await prisma.shift.create({
    data: {
      name,
      code,
      startTime: times.startTime,
      endTime: times.endTime,
      isOvernight: times.isOvernight,
      gracePeriodIn: times.gracePeriodIn,
      gracePeriodOut: times.gracePeriodOut,
      breakDuration: times.breakDuration,
      workDateReference: times.workDateReference,
      earlyCheckinThreshold: times.earlyCheckinThreshold,
      lateCheckoutThreshold: times.lateCheckoutThreshold,
      restDays: times.restDays,
      active: params.active !== false && params.active !== 'false',
    },
  });
  jsonRpcSuccess(res, biotimeOk({ shift: shiftJson(shift) }), req.rpcId);
}));

router.post('/shifts/update', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.shiftId ?? '');
  const existing = await prisma.shift.findUnique({ where: { id } });
  if (!existing) {
    jsonRpcSuccess(res, biotimeFail('Shift not found', 'NOT_FOUND'), req.rpcId);
    return;
  }

  const merged = {
    startTime: params.startTime ?? existing.startTime,
    endTime: params.endTime ?? existing.endTime,
    isOvernight: params.isOvernight,
    gracePeriodIn: params.gracePeriodIn ?? params.checkInGrace ?? existing.gracePeriodIn,
    gracePeriodOut: params.gracePeriodOut ?? params.checkOutGrace ?? existing.gracePeriodOut,
    breakDuration: params.breakDuration ?? existing.breakDuration,
    workDateReference: params.workDateReference ?? existing.workDateReference,
    earlyCheckinThreshold: params.earlyCheckinThreshold ?? existing.earlyCheckinThreshold,
    lateCheckoutThreshold: params.lateCheckoutThreshold ?? existing.lateCheckoutThreshold,
    restDays: params.restDays ?? existing.restDays,
  };
  const times = shiftTimesFromParams(merged);
  const timeError = validateShiftTimes(times.startFloat, times.endFloat);
  if (timeError) {
    jsonRpcSuccess(res, biotimeFail(timeError, 'VALIDATION'), req.rpcId);
    return;
  }

  if (params.code != null) {
    const code = String(params.code).trim();
    const duplicate = await prisma.shift.findFirst({ where: { code, NOT: { id } } });
    if (duplicate) {
      jsonRpcSuccess(res, biotimeFail(`كود الشيفت "${code}" موجود بالفعل`, 'DUPLICATE'), req.rpcId);
      return;
    }
  }

  const shift = await prisma.shift.update({
    where: { id },
    data: {
      name: params.name ? String(params.name) : undefined,
      code: params.code != null ? String(params.code) : undefined,
      startTime: params.startTime != null || params.endTime != null ? times.startTime : undefined,
      endTime: params.startTime != null || params.endTime != null ? times.endTime : undefined,
      isOvernight: params.startTime != null || params.endTime != null ? times.isOvernight : undefined,
      gracePeriodIn: params.gracePeriodIn != null || params.checkInGrace != null ? times.gracePeriodIn : undefined,
      gracePeriodOut: params.gracePeriodOut != null || params.checkOutGrace != null ? times.gracePeriodOut : undefined,
      breakDuration: params.breakDuration != null ? times.breakDuration : undefined,
      workDateReference: params.workDateReference != null ? times.workDateReference : undefined,
      earlyCheckinThreshold: params.earlyCheckinThreshold != null ? times.earlyCheckinThreshold : undefined,
      lateCheckoutThreshold: params.lateCheckoutThreshold != null ? times.lateCheckoutThreshold : undefined,
      restDays: params.restDays !== undefined ? times.restDays : undefined,
      active: params.active !== undefined ? params.active === true || params.active === 'true' : undefined,
    },
  });
  jsonRpcSuccess(res, biotimeOk({ shift: shiftJson(shift) }), req.rpcId);
}));

export default router;
