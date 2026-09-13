import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p, parseRpcBool } from './route-helpers';
import * as advanceLoanImportService from '../../services/advanceLoanImport.service';
import * as advancesService from '../../services/advances.service';
import { AdvanceLoanImportState, AdvanceState, DeductionState, PayrollState, ShiftGridState, HiringAppointmentStatus, UserRole } from '@prisma/client';
import { advanceEligibilityJson, computeAdvanceEligibility, getAdvanceSettings, } from '../../services/advanceEligibility.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { linkLongAdvancesOnly, lockLongAdvanceAccounting } from '../../services/advances.service';
import { writeAudit } from '../../services/auditLog.service';
import * as odooLongAdvance from '../../services/odoo/odooLongAdvance.service';

const router = Router();

router.post('/advances/eligibility/preview', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const employeeId = String(params.employeeId ?? '');
  if (!employeeId) {
    jsonRpcSuccess(res, biotimeFail('employeeId مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  const result = await computeAdvanceEligibility({
    employeeId,
    percent: params.percent != null ? Number(params.percent) : undefined,
    shiftGridId: params.shiftGridId ? String(params.shiftGridId) : null,
    dateFrom: params.dateFrom ? new Date(String(params.dateFrom)) : undefined,
    dateTo: params.dateTo ? new Date(String(params.dateTo)) : undefined,
  });
  jsonRpcSuccess(res, biotimeOk({ eligibility: advanceEligibilityJson(result) }), req.rpcId);
}));

router.post('/advances/settings/get', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const settings = await getAdvanceSettings();
  jsonRpcSuccess(res, biotimeOk({
    advanceDefaultPercent: settings.defaultPercent,
    advanceMinimumWorkingDays: settings.minimumWorkingDays,
    advanceEnforceLimit: settings.enforceLimit,
    advanceEligibilitySource: settings.eligibilitySource,
  }), req.rpcId);
}));

router.post('/advances/short/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const state = params.state ? (String(params.state) as AdvanceState) : undefined;
  const items = await advancesService.listShortAdvances(state);
  jsonRpcSuccess(res, biotimeOk({ advances: items.map(advanceShortJson), count: items.length }), req.rpcId);
}));

router.post('/advances/short/create', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const a = await advancesService.createShortAdvance({
    employeeId: String(params.employeeId),
    amount: Number(params.amount ?? 0),
    date: params.date ? new Date(String(params.date)) : undefined,
    deductionStartDate: params.deductionStartDate
      ? new Date(String(params.deductionStartDate))
      : undefined,
    notes: params.notes ? String(params.notes) : null,
    sourceGridId: params.sourceGridId ? String(params.sourceGridId) : null,
    shiftGridId: params.shiftGridId ? String(params.shiftGridId) : null,
    eligibilityPercent: params.eligibilityPercent != null ? Number(params.eligibilityPercent) : undefined,
    eligibilityDateFrom: params.eligibilityDateFrom ? new Date(String(params.eligibilityDateFrom)) : undefined,
    eligibilityDateTo: params.eligibilityDateTo ? new Date(String(params.eligibilityDateTo)) : undefined,
    limitOverride: parseRpcBool(params.limitOverride),
    overrideReason: params.overrideReason ? String(params.overrideReason) : null,
  });
  await writeAudit({
    req,
    module: 'advances',
    action: 'advances.short.create',
    entityType: 'AdvanceShort',
    entityId: a.id,
    summary: `سلفة قصيرة: ${a.employeeId}`,
    payload: { employeeId: a.employeeId, amount: a.amount },
    route: '/advances/short/create',
  });
  jsonRpcSuccess(res, biotimeOk({ advance: advanceShortJson(a) }), req.rpcId);
}));

router.post('/advances/short/cancel', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.advanceId ?? '');
  const a = await advancesService.cancelShortAdvance(id);
  await writeAudit({
    req,
    module: 'advances',
    action: 'advances.short.cancel',
    entityType: 'AdvanceShort',
    entityId: id,
    summary: `إلغاء سلفة قصيرة: ${id}`,
    route: '/advances/short/cancel',
  });
  jsonRpcSuccess(res, biotimeOk({ advance: advanceShortJson(a) }), req.rpcId);
}));

router.post('/advances/long/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const state = params.state ? (String(params.state) as AdvanceState) : undefined;
  const items = await advancesService.listLongAdvances(state);
  jsonRpcSuccess(res, biotimeOk({ advances: items.map(advanceLongJson), count: items.length }), req.rpcId);
}));

router.post('/advances/long/create', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const startRaw = params.deductionStartDate ?? params.startDate;
  const a = await advancesService.createLongAdvance({
    employeeId: String(params.employeeId),
    totalAmount: Number(params.totalAmount ?? params.amount ?? 0),
    installments: Number(params.installments ?? 1),
    startDate: startRaw ? new Date(String(startRaw)) : undefined,
    notes: params.notes ? String(params.notes) : null,
  });
  await writeAudit({
    req,
    module: 'advances',
    action: 'advances.long.create',
    entityType: 'AdvanceLong',
    entityId: a.id,
    summary: `سلفة طويلة: ${a.employeeId}`,
    payload: { employeeId: a.employeeId, totalAmount: a.totalAmount, installments: a.installments },
    route: '/advances/long/create',
  });
  jsonRpcSuccess(res, biotimeOk({ advance: advanceLongJson(a) }), req.rpcId);
}));

router.post('/advances/long/update', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.advanceId ?? '');
  const startRaw = params.deductionStartDate ?? params.startDate;
  const a = await advancesService.updateLongAdvance(id, {
    totalAmount: params.totalAmount != null ? Number(params.totalAmount) : undefined,
    installments: params.installments != null ? Number(params.installments) : undefined,
    startDate: startRaw ? new Date(String(startRaw)) : undefined,
    notes: params.notes !== undefined ? (params.notes ? String(params.notes) : null) : undefined,
  });
  await writeAudit({
    req,
    module: 'advances',
    action: 'advances.long.update',
    entityType: 'AdvanceLong',
    entityId: id,
    summary: `تعديل سلفة طويلة: ${id}`,
    payload: { totalAmount: a.totalAmount, installments: a.installments },
    route: '/advances/long/update',
  });
  jsonRpcSuccess(res, biotimeOk({ advance: advanceLongJson(a) }), req.rpcId);
}));

router.post('/advances/long/confirm', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.advanceId ?? '');
  await advancesService.confirmLongAdvance(id);
  let odooSync:
    | ({ ok: true } & odooLongAdvance.OdooLongAdvanceResult)
    | { ok: false; error: string };
  try {
    const result = await odooLongAdvance.sendLongAdvanceToOdoo(id);
    odooSync = { ok: true, ...result };
  } catch (error) {
    // The user's chosen policy is local activation + visible retry if Odoo fails.
    odooSync = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const a = await advancesService.getLongAdvance(id);
  await writeAudit({
    req,
    module: 'advances',
    action: 'advances.long.confirm',
    entityType: 'AdvanceLong',
    entityId: id,
    summary: `تأكيد سلفة طويلة: ${id}`,
    payload: { odooSync },
    route: '/advances/long/confirm',
  });
  jsonRpcSuccess(
    res,
    biotimeOk({ advance: advanceLongJson(a), odooSync }),
    req.rpcId,
  );
}));

router.post('/advances/long/send-to-odoo', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.advanceId ?? '');
  const result = await odooLongAdvance.sendLongAdvanceToOdoo(id);
  const a = await advancesService.getLongAdvance(id);
  await writeAudit({
    req,
    module: 'advances',
    action: 'advances.long.send_odoo',
    entityType: 'AdvanceLong',
    entityId: id,
    summary: `إرسال السلفة الطويلة إلى Odoo: ${result.sendReference}`,
    payload: result,
    route: '/advances/long/send-to-odoo',
  });
  jsonRpcSuccess(
    res,
    biotimeOk({ advance: advanceLongJson(a), odooSync: { ok: true, ...result } }),
    req.rpcId,
  );
}));

router.post('/advances/long/lock-accounting', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.advanceId ?? '');
  const journalMoveId = params.journalMoveId ? String(params.journalMoveId) : undefined;
  const a = await lockLongAdvanceAccounting(id, journalMoveId);
  jsonRpcSuccess(res, biotimeOk({ advance: advanceLongJson(a) }), req.rpcId);
}));

router.post('/advances/long/cancel', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.advanceId ?? '');
  const a = await advancesService.cancelLongAdvance(id);
  await writeAudit({
    req,
    module: 'advances',
    action: 'advances.long.cancel',
    entityType: 'AdvanceLong',
    entityId: id,
    summary: `إلغاء سلفة طويلة: ${id}`,
    route: '/advances/long/cancel',
  });
  jsonRpcSuccess(res, biotimeOk({ advance: advanceLongJson(a) }), req.rpcId);
}));

router.post('/advances/long/stop', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.advanceId ?? '');
  const a = await advancesService.stopLongAdvance(id);
  await writeAudit({
    req,
    module: 'advances',
    action: 'advances.long.stop',
    entityType: 'AdvanceLong',
    entityId: id,
    summary: `إيقاف سلفة طويلة: ${id}`,
    route: '/advances/long/stop',
  });
  jsonRpcSuccess(res, biotimeOk({ advance: advanceLongJson(a) }), req.rpcId);
}));

router.post('/advances/long/adjust-remaining', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.advanceId ?? '');
  const a = await advancesService.adjustLongAdvanceRemaining(id, {
    remainingAmount: Number(params.remainingAmount ?? 0),
    remainingInstallments: Number(params.remainingInstallments ?? 0),
  });
  await writeAudit({
    req,
    module: 'advances',
    action: 'advances.long.adjust_remaining',
    entityType: 'AdvanceLong',
    entityId: id,
    summary: `تعديل متبقي سلفة طويلة: ${id}`,
    payload: {
      remainingAmount: Number(params.remainingAmount ?? 0),
      remainingInstallments: Number(params.remainingInstallments ?? 0),
      totalAmount: a.totalAmount,
      installments: a.installments,
    },
    route: '/advances/long/adjust-remaining',
  });
  jsonRpcSuccess(res, biotimeOk({ advance: advanceLongJson(a) }), req.rpcId);
}));

router.post('/advances/loan-import/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const requestedState = String(p(req).state ?? 'draft');
  const state = requestedState === 'locked'
    ? AdvanceLoanImportState.locked
    : AdvanceLoanImportState.draft;
  const result = await advanceLoanImportService.listAdvanceLoanImports(
    state,
    String(p(req).kind ?? 'loan') === 'tip' ? 'tip' : 'loan',
  );
  jsonRpcSuccess(res, biotimeOk({ ...result, count: result.items.length }), req.rpcId);
}));

router.post('/advances/loan-import/create', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const batch = await advanceLoanImportService.createAdvanceLoanImport({
    deviceId: params.deviceId ? String(params.deviceId) : null,
    sourceGridId: params.sourceGridId ? String(params.sourceGridId) : null,
    date: params.date ? String(params.date) : undefined,
    defaultRepaymentMonths: params.defaultRepaymentMonths != null
      ? Number(params.defaultRepaymentMonths)
      : undefined,
    defaultReason: params.defaultReason ? String(params.defaultReason) : undefined,
    kind: String(params.kind ?? 'loan') === 'tip' ? 'tip' : 'loan',
  });
  await writeAudit({
    req,
    module: 'advances',
    action: 'advances.loan_import.create',
    entityType: 'AdvanceLoanImport',
    entityId: batch.id,
    summary: `استيراد سلف: ${batch.id}`,
    route: '/advances/loan-import/create',
  });
  jsonRpcSuccess(res, biotimeOk({ import: batch }), req.rpcId);
}));

export default router;
