import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import * as generateJobService from '../../services/generateJob.service';
import { NotFoundError, AppError } from '../../utils/errors';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { exportEmployeePunchReportXlsx, exportUnlocatedEmployeesPunchesXlsx, fetchEmployeePunchReport, resolveEmployeeBiotimeCodes, resolveEmployeesBiotimeCodes, } from '../../services/employeePunchReport.service';
import { exportPunchReportFileResponse, exportSelectedGridPunchReportXlsx, exportShiftGridPunchReportXlsx, } from '../../services/punchReportExcel.service';
import { listAllBiotimeEmpCodes } from '../../services/biotimeEmpCodes.service';
import { prisma } from '../../prisma/client';
import { pushEmployeeToBioTime } from '../../services/biotime/employeePush.service';

const router = Router();

router.post('/employees/push-biotime', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).employeeId ?? '');
  const employee = await prisma.employeeProfile.findUnique({ where: { id }, include: { mapping: true } });
  if (!employee) {
    jsonRpcSuccess(res, biotimeFail('Employee not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  await pushEmployeeToBioTime(id);
  const updated = await prisma.employeeProfile.findUniqueOrThrow({
    where: { id },
    include: { department: true, mapping: true },
  });
  jsonRpcSuccess(res, biotimeOk({ employee: employeeJson(updated, true), message: 'Pushed to BioTime' }), req.rpcId);
}));

router.post('/employees/sync-device', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const employeeId = String(p(req).employeeId ?? '');
  const params = p(req);
  const syncParam = params.sync;
  const sync =
    syncParam === true || syncParam === 'true' || syncParam === 'full'
      ? 'full'
      : syncParam === 'incremental'
        ? 'incremental'
        : false;
  const report = await fetchEmployeePunchReport(employeeId, { sync });
  const employee = await prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    include: { department: true, mapping: true, workLocation: true },
  });
  jsonRpcSuccess(
    res,
    biotimeOk({
      ...report,
      employee: employee ? employeeJson(employee, true) : null,
      message: report.message,
    }),
    req.rpcId,
  );
}));

router.post('/employees/punch-report', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const employeeId = String(params.employeeId ?? '');
  const dateFrom = params.dateFrom ? new Date(String(params.dateFrom)) : undefined;
  const dateTo = params.dateTo ? new Date(String(params.dateTo)) : undefined;
  const sync =
    params.sync === true || params.sync === 'true' || params.sync === 'full'
      ? 'full'
      : params.sync === 'incremental'
        ? 'incremental'
        : false;
  const report = await fetchEmployeePunchReport(employeeId, { dateFrom, dateTo, sync });
  jsonRpcSuccess(res, biotimeOk(report), req.rpcId);
}));

router.post('/employees/punches/export-selected-xlsx', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  const employeeIds = Array.isArray(params.employeeIds)
    ? params.employeeIds.map((id: unknown) => String(id)).filter(Boolean)
    : [];
  const dateFrom = params.dateFrom ? new Date(String(params.dateFrom)) : undefined;
  let dateTo = params.dateTo ? new Date(String(params.dateTo)) : undefined;
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(String(params.dateTo))) {
    dateTo = new Date(dateTo.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  if (!employeeIds.length) {
    throw new AppError('لم يتم تحديد أي موظف', 400, 'VALIDATION_ERROR');
  }
  const file = await exportSelectedGridPunchReportXlsx(gridId, employeeIds, dateFrom, dateTo);
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

router.post('/employees/punches/export-unlocated-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = params.dateFrom ? new Date(String(params.dateFrom)) : undefined;
  let dateTo = params.dateTo ? new Date(String(params.dateTo)) : undefined;
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(String(params.dateTo))) {
    dateTo = new Date(dateTo.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  const file = await exportUnlocatedEmployeesPunchesXlsx({ dateFrom, dateTo });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

router.post('/employees/punch-report/sync-start', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = params.dateFrom ? new Date(String(params.dateFrom)) : undefined;
  let dateTo = params.dateTo ? new Date(String(params.dateTo)) : undefined;
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(String(params.dateTo))) {
    dateTo = new Date(dateTo.getTime() + 24 * 60 * 60 * 1000 - 1);
  }

  const includeAllBiotimeCodes =
    params.includeAllBiotimeCodes === true || params.includeAllBiotimeCodes === 'true';
  const employeeIds = Array.isArray(params.employeeIds)
    ? (params.employeeIds as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
    : [];
  const singleId = String(params.employeeId ?? '').trim();

  if (includeAllBiotimeCodes) {
    if (!dateFrom || !dateTo || Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime())) {
      throw new AppError('dateFrom و dateTo مطلوبان لمزامنة كل أكواد BioTime', 400, 'VALIDATION_ERROR');
    }
    const codes = await listAllBiotimeEmpCodes();
    if (!codes.length) {
      throw new AppError('لا توجد أكواد موظفين على خادم BioTime', 400, 'VALIDATION_ERROR');
    }
    // Period pull (week slices) — not one BioTime call per emp_code.
    const jobId = await generateJobService.queueCompanyPeriodPunchSync(dateFrom, dateTo);
    jsonRpcSuccess(
      res,
      biotimeOk({
        jobId,
        queued: true,
        message: `مزامنة بصمات الفترة لكل أكواد BioTime (${codes.length}) بدأت`,
        employeeCount: codes.length,
        codeCount: codes.length,
      }),
      req.rpcId,
    );
    return;
  }

  let codes: string[] = [];
  if (employeeIds.length) {
    const resolved = await resolveEmployeesBiotimeCodes(employeeIds);
    if (!resolved.codes.length) {
      throw new AppError('لا توجد أكواد BioTime للموظفين المحددين', 400, 'VALIDATION_ERROR');
    }
    codes = resolved.codes;
  } else if (singleId) {
    codes = await resolveEmployeeBiotimeCodes(singleId);
  } else {
    throw new AppError('حدّد موظفاً أو قائمة موظفين', 400, 'VALIDATION_ERROR');
  }

  const jobId = await generateJobService.queueEmployeePunchSync(codes, dateFrom, dateTo);
  jsonRpcSuccess(
    res,
    biotimeOk({
      jobId,
      queued: true,
      message: employeeIds.length
        ? `مزامنة بصمات ${employeeIds.length} موظف بدأت`
        : 'Employee punch sync started',
      employeeCount: employeeIds.length || 1,
      codeCount: codes.length,
    }),
    req.rpcId,
  );
}));

router.post('/employees/punch-report/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const employeeId = String(params.employeeId ?? '');
  const dateFrom = params.dateFrom ? new Date(String(params.dateFrom)) : undefined;
  let dateTo = params.dateTo ? new Date(String(params.dateTo)) : undefined;
  // If a bare date (no time) is provided, include the whole end day.
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(String(params.dateTo))) {
    dateTo = new Date(dateTo.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  const sync = params.sync === true || params.sync === 'true';
  const file = await exportEmployeePunchReportXlsx(employeeId, { dateFrom, dateTo, sync });
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

// --- Shifts ---

export default router;
