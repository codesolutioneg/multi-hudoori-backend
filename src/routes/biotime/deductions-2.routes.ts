import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { AppError } from '../../utils/errors';
import {
  importDeductionMultiXlsx,
  exportDeductionBranchTemplate,
  previewDeductionBranchXlsx,
  confirmDeductionBranchImport,
  employeesForDeductionScope,
  jobTitlesForDeductionScope,
  previewDeductionDistribute,
  recalcDeductionDistribute,
  confirmDeductionDistribute,
  normalizeDeductionLocationIds,
  normalizeDeductionJobTitles,
} from '../../services/deductionExcel.service';
import { exportFileResponse } from '../../services/payrollExport.service';
import { writeAudit } from '../../services/auditLog.service';

const router = Router();

function locationIdsFromParams(params: Record<string, unknown>): string[] {
  return normalizeDeductionLocationIds({
    locationId: params.locationId != null ? String(params.locationId) : null,
    locationIds: params.locationIds,
  });
}

function jobTitlesFromParams(params: Record<string, unknown>): string[] {
  return normalizeDeductionJobTitles({
    jobTitle: params.jobTitle != null ? String(params.jobTitle) : null,
    jobTitles: params.jobTitles,
  });
}

router.post('/deductions/import-multi-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = String(params.file ?? params.base64 ?? '');
  if (!file.trim()) throw new AppError('ارفع ملف Excel', 400, 'VALIDATION_ERROR');
  const result = await importDeductionMultiXlsx({
    base64: file,
    deviceId: params.deviceId ? String(params.deviceId) : null,
    date: params.date ? String(params.date) : undefined,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/deductions/export-branch-template', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const locationIds = locationIdsFromParams(params);
  if (!locationIds.length) throw new AppError('اختر فرعاً واحداً على الأقل', 400, 'VALIDATION_ERROR');
  const jobTitles = jobTitlesFromParams(params);
  const { base64, filename, count } = await exportDeductionBranchTemplate({
    locationIds,
    deductionType: params.deductionType || params.type
      ? String(params.deductionType ?? params.type)
      : undefined,
    dateFrom: params.dateFrom ? String(params.dateFrom) : null,
    dateTo: params.dateTo ? String(params.dateTo) : null,
    jobTitles: jobTitles.length ? jobTitles : null,
    date: params.date ? String(params.date) : undefined,
  });
  jsonRpcSuccess(res, biotimeOk({ ...exportFileResponse(base64, filename), count }), req.rpcId);
}));

router.post('/deductions/scope-count', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const locationIds = locationIdsFromParams(params);
  if (!locationIds.length) throw new AppError('اختر فرعاً واحداً على الأقل', 400, 'VALIDATION_ERROR');
  const jobTitles = jobTitlesFromParams(params);
  const employees = await employeesForDeductionScope({
    locationIds,
    dateFrom: params.dateFrom ? String(params.dateFrom) : null,
    dateTo: params.dateTo ? String(params.dateTo) : null,
    jobTitles: jobTitles.length ? jobTitles : null,
    includeInactive: true,
  });
  jsonRpcSuccess(res, biotimeOk({ count: employees.length }), req.rpcId);
}));

router.post('/deductions/job-titles', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const locationIds = locationIdsFromParams(params);
  if (!locationIds.length) throw new AppError('اختر فرعاً واحداً على الأقل', 400, 'VALIDATION_ERROR');
  const jobTitles = await jobTitlesForDeductionScope({
    locationIds,
    dateFrom: params.dateFrom ? String(params.dateFrom) : null,
    dateTo: params.dateTo ? String(params.dateTo) : null,
  });
  jsonRpcSuccess(res, biotimeOk({ jobTitles }), req.rpcId);
}));

router.post('/deductions/preview-branch-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = String(params.file ?? params.base64 ?? '');
  if (!file.trim()) throw new AppError('ارفع ملف Excel', 400, 'VALIDATION_ERROR');
  const locationIds = locationIdsFromParams(params);
  const result = await previewDeductionBranchXlsx({
    base64: file,
    locationIds: locationIds.length ? locationIds : null,
    dateFrom: params.dateFrom ? String(params.dateFrom) : null,
    dateTo: params.dateTo ? String(params.dateTo) : null,
    deductionType: params.deductionType || params.type
      ? String(params.deductionType ?? params.type)
      : null,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/deductions/confirm-branch-import', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const rawLines = Array.isArray(params.lines) ? params.lines : [];
  const lines = rawLines.map((l: Record<string, unknown>) => ({
    employeeId: String(l.employeeId ?? ''),
    type: String(l.type ?? ''),
    amount: Number(l.amount ?? 0),
    note: l.note != null ? String(l.note) : '',
  })).filter((l: { employeeId: string; type: string; amount: number }) => l.employeeId && l.type && l.amount > 0);

  if (!lines.length) throw new AppError('لا توجد سطور صالحه للاعتماد', 400, 'VALIDATION_ERROR');

  const result = await confirmDeductionBranchImport({
    lines,
    date: params.date ? String(params.date) : undefined,
    deviceId: params.deviceId ? String(params.deviceId) : null,
  });
  await writeAudit({
    req,
    module: 'deductions',
    action: 'deductions.import',
    entityType: 'Deduction',
    summary: `استيراد استقطاعات Excel: ${result.created} سجل`,
    counts: { created: result.created },
    diffPreview: lines.slice(0, 100).map((l) => ({
      field: 'amount',
      after: l.amount,
      note: l.type,
      entityId: l.employeeId,
      entityLabel: l.employeeId,
    })),
    payload: {
      created: result.created,
      lineCount: lines.length,
      date: params.date ? String(params.date) : null,
    },
    route: '/deductions/confirm-branch-import',
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/deductions/distribute/preview', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const locationIds = locationIdsFromParams(params);
  const jobTitles = jobTitlesFromParams(params);
  const result = await previewDeductionDistribute({
    locationIds,
    dateFrom: String(params.dateFrom ?? ''),
    dateTo: String(params.dateTo ?? ''),
    deductionType: String(params.deductionType ?? params.type ?? ''),
    date: params.date ? String(params.date) : undefined,
    totalAmount: Number(params.totalAmount ?? 0),
    jobTitles: jobTitles.length ? jobTitles : null,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/deductions/distribute/recalc', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const rawIds = Array.isArray(params.employeeIds) ? params.employeeIds : [];
  const result = await recalcDeductionDistribute({
    employeeIds: rawIds.map((id: unknown) => String(id ?? '')),
    totalAmount: Number(params.totalAmount ?? 0),
    note: params.note != null ? String(params.note) : undefined,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/deductions/distribute/confirm', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const locationIds = locationIdsFromParams(params);
  const rawLines = Array.isArray(params.lines) ? params.lines : [];
  const lines = rawLines.map((l: Record<string, unknown>) => ({
    employeeId: String(l.employeeId ?? ''),
    amount: Number(l.amount ?? 0),
    note: l.note != null ? String(l.note) : '',
  }));
  const jobTitles = jobTitlesFromParams(params);
  const result = await confirmDeductionDistribute({
    locationIds,
    dateFrom: String(params.dateFrom ?? ''),
    dateTo: String(params.dateTo ?? ''),
    deductionType: String(params.deductionType ?? params.type ?? ''),
    date: params.date ? String(params.date) : undefined,
    totalAmount: Number(params.totalAmount ?? 0),
    jobTitles: jobTitles.length ? jobTitles : null,
    lines,
    deviceId: params.deviceId ? String(params.deviceId) : null,
  });
  await writeAudit({
    req,
    module: 'deductions',
    action: 'deductions.distribute',
    entityType: 'Deduction',
    summary: `توزيع استقطاعات: ${result.created} موظف — إجمالي ${params.totalAmount}`,
    counts: { created: result.created },
    diffPreview: lines.slice(0, 100).map((l) => ({
      field: 'amount',
      after: l.amount,
      note: String(params.deductionType ?? params.type ?? ''),
      entityId: l.employeeId,
      entityLabel: l.employeeId,
    })),
    payload: {
      locationIds,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      deductionType: params.deductionType ?? params.type,
      totalAmount: params.totalAmount,
      jobTitle: params.jobTitle ?? null,
      created: result.created,
    },
    route: '/deductions/distribute/confirm',
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

export default router;
