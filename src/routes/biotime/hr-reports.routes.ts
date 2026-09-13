import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p, parseRpcBool } from './route-helpers';
import { AppError } from '../../utils/errors';
import type { EmployeeScopeFilters } from '../../services/hrReports.service';
import {
  buildNoPunchReport,
  exportNoPunchReportXlsx,
} from '../../services/reportNoPunches.service';
import {
  buildFawryReport,
  exportFawryReportXlsx,
  parseFawryFilter,
} from '../../services/reportFawry.service';
import {
  buildPunchSummaryReport,
  exportPunchSummaryReportXlsx,
} from '../../services/reportPunchSummary.service';
import {
  buildInsuranceReport,
  exportInsuranceReportXlsx,
  parseInsuranceFilter,
  parseInsuranceKind,
} from '../../services/reportInsurance.service';
import {
  buildDocumentsReport,
  DOCUMENT_LABELS,
  exportDocumentsReportXlsx,
  parseDocumentFilter,
  parseDocumentTypes,
  REPORT_DOCUMENT_TYPES,
} from '../../services/reportDocuments.service';
import {
  buildHealthCertReport,
  exportHealthCertReportXlsx,
  parseHealthCertMode,
} from '../../services/reportHealthCertificates.service';
import {
  buildLocationMismatchReport,
  exportLocationMismatchReportXlsx,
} from '../../services/reportLocationMismatch.service';
import {
  buildEmployeeMovementsReport,
  exportEmployeeMovementsReportXlsx,
  parseMovementMode,
} from '../../services/reportEmployeeMovements.service';
import {
  buildEmployeeEmailsReport,
  exportEmployeeEmailsReportXlsx,
} from '../../services/reportEmployeeEmails.service';
import { isTransactionRangeCoveredRecently } from '../../services/biotime/sync.service';
import { queuePunchReportSync } from '../../services/generateJob.service';
import { findReportEmployees } from '../../services/hrReports.service';
import { resolveEmployeesBiotimeCodes } from '../../services/employeePunchReport.service';

const router = Router();

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const raw = params[key];
  if (raw == null || raw === false || raw === '') return undefined;
  const value = String(raw).trim();
  return value || undefined;
}

/** Present-but-falsy has to stay distinguishable from absent for the toggles. */
function optionalBool(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  return key in params ? parseRpcBool(params[key]) : undefined;
}

function scopeFilters(params: Record<string, unknown>): EmployeeScopeFilters {
  const employeeIds = Array.isArray(params.employeeIds)
    ? (params.employeeIds as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
    : undefined;
  return {
    locationId: optionalString(params, 'locationId'),
    departmentId: optionalString(params, 'departmentId'),
    employeeIds: employeeIds?.length ? employeeIds : undefined,
    requireNationalId: optionalBool(params, 'requireNationalId'),
    includeArchived: optionalBool(params, 'includeArchived'),
    includeInactive: optionalBool(params, 'includeInactive'),
  };
}

function punchReportScope(params: Record<string, unknown>): EmployeeScopeFilters {
  const scope = scopeFilters(params);
  if (!scope.locationId) {
    throw new AppError('اختيار الفرع مطلوب لتقرير البصمات', 400, 'VALIDATION');
  }
  return scope;
}

/** Inclusive end-of-day, so a single-day range covers that whole day. */
function parseDateRange(params: Record<string, unknown>): { dateFrom: Date; dateTo: Date } {
  const rawFrom = optionalString(params, 'dateFrom');
  const rawTo = optionalString(params, 'dateTo');
  if (!rawFrom || !rawTo) {
    throw new AppError('لازم تحدد الفترة من تاريخ إلى تاريخ', 400, 'VALIDATION');
  }
  const dateFrom = new Date(rawFrom);
  let dateTo = new Date(rawTo);
  if (Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime())) {
    throw new AppError('تاريخ غير صالح', 400, 'VALIDATION');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawTo)) {
    dateTo = new Date(dateTo.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new AppError('تاريخ البداية بعد تاريخ النهاية', 400, 'VALIDATION');
  }
  return { dateFrom, dateTo };
}

// --- Report 1: employees with no punches ---

router.post('/reports/no-punches', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const rows = await buildNoPunchReport({
    ...scopeFilters(params),
    ...parseDateRange(params),
    includeNeverScheduled: optionalBool(params, 'includeNeverScheduled'),
  });
  jsonRpcSuccess(res, biotimeOk({ rows, count: rows.length }), req.rpcId);
}));

router.post('/reports/no-punches/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = await exportNoPunchReportXlsx({
    ...scopeFilters(params),
    ...parseDateRange(params),
    includeNeverScheduled: optionalBool(params, 'includeNeverScheduled'),
  });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

// --- Report 2: Fawry cards ---

router.post('/reports/fawry', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const rows = await buildFawryReport({
    ...scopeFilters(params),
    filter: parseFawryFilter(params.filter),
  });
  jsonRpcSuccess(res, biotimeOk({ rows, count: rows.length }), req.rpcId);
}));

router.post('/reports/fawry/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = await exportFawryReportXlsx({
    ...scopeFilters(params),
    filter: parseFawryFilter(params.filter),
  });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

// --- Report 3: insurance ---

router.post('/reports/insurance', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const result = await buildInsuranceReport({
    ...scopeFilters(params),
    kind: parseInsuranceKind(params.kind),
    filter: parseInsuranceFilter(params.filter),
  });
  jsonRpcSuccess(
    res,
    biotimeOk({
      social: result.social,
      medical: result.medical,
      count: result.social.length + result.medical.length,
    }),
    req.rpcId,
  );
}));

router.post('/reports/insurance/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = await exportInsuranceReportXlsx({
    ...scopeFilters(params),
    kind: parseInsuranceKind(params.kind),
    filter: parseInsuranceFilter(params.filter),
  });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

// --- Report 4: missing documents ---

router.post('/reports/documents/types', requireAuth, requireHr, asyncHandler(async (req, res) => {
  jsonRpcSuccess(
    res,
    biotimeOk({
      types: REPORT_DOCUMENT_TYPES.map((type) => ({ value: type, label: DOCUMENT_LABELS[type] })),
    }),
    req.rpcId,
  );
}));

router.post('/reports/documents', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const { rows, required } = await buildDocumentsReport({
    ...scopeFilters(params),
    requiredDocuments: parseDocumentTypes(params.requiredDocuments),
    filter: parseDocumentFilter(params.filter),
    // Always OR for incomplete — ignore client matchMode.
    matchMode: 'any',
    acceptCopies: optionalBool(params, 'acceptCopies'),
  });
  jsonRpcSuccess(res, biotimeOk({ rows, required, count: rows.length }), req.rpcId);
}));

router.post('/reports/documents/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = await exportDocumentsReportXlsx({
    ...scopeFilters(params),
    requiredDocuments: parseDocumentTypes(params.requiredDocuments),
    filter: parseDocumentFilter(params.filter),
    matchMode: 'any',
    acceptCopies: optionalBool(params, 'acceptCopies'),
  });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

// --- Report: hiring additions / exits ---

router.post('/reports/employee-movements', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const rows = await buildEmployeeMovementsReport({
    ...scopeFilters(params),
    ...parseDateRange(params),
    mode: parseMovementMode(params.mode),
  });
  jsonRpcSuccess(res, biotimeOk({ rows, count: rows.length }), req.rpcId);
}));

router.post('/reports/employee-movements/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = await exportEmployeeMovementsReportXlsx({
    ...scopeFilters(params),
    ...parseDateRange(params),
    mode: parseMovementMode(params.mode),
  });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

// --- Report: employee work emails + passwords ---

router.post('/reports/employee-emails', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const rows = await buildEmployeeEmailsReport(scopeFilters(params));
  jsonRpcSuccess(res, biotimeOk({ rows, count: rows.length }), req.rpcId);
}));

router.post('/reports/employee-emails/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = await exportEmployeeEmailsReportXlsx(scopeFilters(params));
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

// --- Report 5: health certificates ---

router.post('/reports/health-certificates', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const rows = await buildHealthCertReport({
    ...scopeFilters(params),
    mode: parseHealthCertMode(params.mode),
    warningDays: params.warningDays == null ? undefined : Number(params.warningDays),
  });
  jsonRpcSuccess(res, biotimeOk({ rows, count: rows.length }), req.rpcId);
}));

router.post('/reports/health-certificates/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = await exportHealthCertReportXlsx({
    ...scopeFilters(params),
    mode: parseHealthCertMode(params.mode),
    warningDays: params.warningDays == null ? undefined : Number(params.warningDays),
  });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

// --- Report 6: punches at a different location than the employee's assigned branch ---

router.post('/reports/location-mismatch', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const rows = await buildLocationMismatchReport({
    ...scopeFilters(params),
    ...parseDateRange(params),
    includeUnmappedDevices: optionalBool(params, 'includeUnmappedDevices'),
  });
  jsonRpcSuccess(res, biotimeOk({ rows, count: rows.length }), req.rpcId);
}));

router.post('/reports/location-mismatch/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = await exportLocationMismatchReportXlsx({
    ...scopeFilters(params),
    ...parseDateRange(params),
    includeUnmappedDevices: optionalBool(params, 'includeUnmappedDevices'),
  });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

// --- Report 7: branch punch report; on-screen summary + full punch-report Excel ---

/**
 * Pulling a report period from BioTime takes minutes company-wide, so it runs
 * as a job for the selected branch's employees only. The report endpoints below
 * only read what is already stored.
 */
router.post('/reports/punch-report/sync-start', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const scope = punchReportScope(params);
  const { dateFrom, dateTo } = parseDateRange(params);
  const locationId = scope.locationId!;

  if (await isTransactionRangeCoveredRecently(dateFrom, dateTo, locationId)) {
    jsonRpcSuccess(res, biotimeOk({ queued: false, fresh: true }), req.rpcId);
    return;
  }

  const employees = await findReportEmployees(scope);
  const { codes } = await resolveEmployeesBiotimeCodes(employees.map((e) => e.id));
  const jobId = await queuePunchReportSync({
    dateFrom,
    dateTo,
    locationId,
    empCodes: codes,
  });
  jsonRpcSuccess(res, biotimeOk({ queued: true, jobId }), req.rpcId);
}));

router.post('/reports/punch-summary', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const rows = await buildPunchSummaryReport({
    ...punchReportScope(params),
    ...parseDateRange(params),
  });
  jsonRpcSuccess(res, biotimeOk({ rows, count: rows.length }), req.rpcId);
}));

router.post('/reports/punch-summary/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = await exportPunchSummaryReportXlsx({
    ...punchReportScope(params),
    ...parseDateRange(params),
  });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

export default router;
