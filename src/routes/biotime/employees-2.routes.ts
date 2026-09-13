import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { Prisma } from '@prisma/client';
import { SyncJobStatus } from '@prisma/client';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { ensureDefaultCustodyTypes, listEmployeeCustodies, syncEmployeeCustodies, } from '../../services/employeeCustody.service';
import { exportPunchReportFileResponse, exportSelectedGridPunchReportXlsx, exportShiftGridPunchReportXlsx, } from '../../services/punchReportExcel.service';
import { getEmployeeLeaveSummary } from '../../services/employeeLeave.service';
import { parseEmployeeDocumentType, readEmployeeDocument, readInsurancePrint, saveEmployeeDocument, saveInsurancePrint, } from '../../services/employeeDocuments.service';
import { listAllBiotimeEmpCodes } from '../../services/biotimeEmpCodes.service';
import * as generateJobService from '../../services/generateJob.service';
import { exportFileResponse } from '../../services/payrollExport.service';
import { prisma } from '../../prisma/client';
import fs from 'fs';
import path from 'path';

const router = Router();

/** Queue sync+Excel in background; poll /jobs/status then call download. */
router.post('/employees/punch-report-export/start', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = params.dateFrom ? new Date(String(params.dateFrom)) : undefined;
  let dateTo = params.dateTo ? new Date(String(params.dateTo)) : undefined;
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(String(params.dateTo))) {
    dateTo = new Date(dateTo.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  if (!dateFrom || !dateTo || Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime())) {
    jsonRpcSuccess(res, biotimeFail('dateFrom و dateTo مطلوبان', 'VALIDATION'), req.rpcId);
    return;
  }

  const includeAllBiotimeCodes =
    params.includeAllBiotimeCodes === true || params.includeAllBiotimeCodes === 'true';
  const syncFirst = !(params.syncFirst === false || params.syncFirst === 'false');
  const employeeIds = Array.isArray(params.employeeIds)
    ? (params.employeeIds as unknown[]).map(String).filter(Boolean)
    : [];

  if (!includeAllBiotimeCodes && !employeeIds.length) {
    jsonRpcSuccess(res, biotimeFail('حدّد موظفين أو اختر كل أكواد BioTime', 'VALIDATION'), req.rpcId);
    return;
  }

  const jobId = await generateJobService.queuePunchReportExport({
    dateFrom,
    dateTo,
    includeAllBiotimeCodes,
    employeeIds: includeAllBiotimeCodes ? undefined : employeeIds,
    syncFirst,
  });

  jsonRpcSuccess(
    res,
    biotimeOk({
      jobId,
      queued: true,
      status: 'Queued',
      message: includeAllBiotimeCodes
        ? 'بدأ تجهيز تقرير البصمات (كل أكواد BioTime) في الخلفية'
        : `بدأ تجهيز تقرير البصمات لـ ${employeeIds.length} موظف في الخلفية`,
    }),
    req.rpcId,
  );
}));

router.post('/employees/punch-report-export/download', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const jobId = String(p(req).jobId ?? '').trim();
  if (!jobId) {
    jsonRpcSuccess(res, biotimeFail('jobId مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }

  const job = await generateJobService.getJobStatus(jobId);
  if (!job) {
    jsonRpcSuccess(res, biotimeFail('Job not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  if (job.jobType !== generateJobService.PUNCH_REPORT_EXPORT_JOB) {
    jsonRpcSuccess(res, biotimeFail('نوع المهمة غير صالح للتنزيل', 'VALIDATION'), req.rpcId);
    return;
  }
  if (job.status !== SyncJobStatus.done) {
    jsonRpcSuccess(
      res,
      biotimeFail(
        job.status === SyncJobStatus.failed ? (job.message || 'فشلت المهمة') : 'الملف غير جاهز بعد',
        job.status === SyncJobStatus.failed ? 'ACTION_ERROR' : 'NOT_READY',
      ),
      req.rpcId,
    );
    return;
  }

  const filename =
    (job.result?.filename != null ? String(job.result.filename) : '') ||
    `punch_report_${jobId}.xlsx`;
  const filePath = path.join(process.cwd(), 'storage', 'exports', `${jobId}.xlsx`);
  if (!fs.existsSync(filePath)) {
    jsonRpcSuccess(res, biotimeFail('ملف التصدير غير موجود على الخادم', 'NOT_FOUND'), req.rpcId);
    return;
  }

  const base64 = fs.readFileSync(filePath).toString('base64');
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, filename)), req.rpcId);
}));

router.post('/employees/punch-report-export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = params.dateFrom ? new Date(String(params.dateFrom)) : undefined;
  const dateTo = params.dateTo ? new Date(String(params.dateTo)) : undefined;
  if (!dateFrom || !dateTo || Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime())) {
    jsonRpcSuccess(res, biotimeFail('dateFrom و dateTo مطلوبان', 'VALIDATION'), req.rpcId);
    return;
  }

  const includeAllBiotimeCodes =
    params.includeAllBiotimeCodes === true || params.includeAllBiotimeCodes === 'true';

  if (includeAllBiotimeCodes) {
    try {
      const empCodes = await listAllBiotimeEmpCodes();
      if (!empCodes.length) {
        jsonRpcSuccess(res, biotimeFail('لا توجد أكواد موظفين على خادم BioTime', 'NOT_FOUND'), req.rpcId);
        return;
      }
      const file = await exportPunchReportFileResponse({
        dateFrom,
        dateTo,
        empCodes,
        includeInactive: true,
      });
      jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
    } catch (e: unknown) {
      jsonRpcSuccess(
        res,
        biotimeFail(e instanceof Error ? e.message : 'فشل التصدير', 'ACTION_ERROR'),
        req.rpcId,
      );
    }
    return;
  }

  const search = String(params.search ?? '').trim();
  const departmentId = params.departmentId != null ? String(params.departmentId) : undefined;
  const biotimeSynced = params.biotimeSynced;
  const explicitIds = Array.isArray(params.employeeIds)
    ? (params.employeeIds as unknown[]).map(String).filter(Boolean)
    : [];

  let employeeIds = explicitIds;
  if (!employeeIds.length) {
    const where: Prisma.EmployeeProfileWhereInput = { active: true };
    if (departmentId) where.departmentId = departmentId;
    if (biotimeSynced === true || biotimeSynced === 'true') where.biotimeSynced = true;
    if (biotimeSynced === false || biotimeSynced === 'false') where.biotimeSynced = false;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { identificationId: { contains: search, mode: 'insensitive' } },
        { barcode: { contains: search, mode: 'insensitive' } },
        { mapping: { biotimeEmpCode: { contains: search, mode: 'insensitive' } } },
      ];
    }
    const rows = await prisma.employeeProfile.findMany({ where, select: { id: true } });
    employeeIds = rows.map((r) => r.id);
  }

  if (!employeeIds.length) {
    jsonRpcSuccess(res, biotimeFail('لا يوجد موظفون للتصدير', 'NOT_FOUND'), req.rpcId);
    return;
  }

  try {
    const file = await exportPunchReportFileResponse({ dateFrom, dateTo, employeeIds });
    jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'فشل التصدير', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

router.post('/employees/get', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).employeeId ?? '');
  const employee = await prisma.employeeProfile.findUnique({
    where: { id },
    include: { department: true, mapping: true, workLocation: true, manager: true },
  });
  if (!employee) {
    jsonRpcSuccess(res, biotimeFail('Employee not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const hrScope = await getHrLocationScopeFromReq(req);
  assertEmployeeLocationAccess(hrScope, employee.locationId);
  const leaveSummary = await getEmployeeLeaveSummary(id);
  const custodies = await listEmployeeCustodies(id);
  jsonRpcSuccess(res, biotimeOk({
    employee: { ...employeeJson(employee, true), custodies },
    leaveSummary,
  }), req.rpcId);
}));

router.post('/employees/leave-summary', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).employeeId ?? '');
  const year = p(req).year != null ? Number(p(req).year) : undefined;
  const leaveSummary = await getEmployeeLeaveSummary(id, year);
  jsonRpcSuccess(res, biotimeOk({ leaveSummary }), req.rpcId);
}));

router.post('/employees/insurance-print/upload', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.employeeId ?? '');
  const base64 = String(params.base64 ?? params.file ?? '');
  if (!base64.trim()) {
    jsonRpcSuccess(res, biotimeFail('ملف فارغ', 'VALIDATION'), req.rpcId);
    return;
  }
  const result = await saveInsurancePrint(id, base64, params.mimeType ? String(params.mimeType) : undefined);
  const employee = await prisma.employeeProfile.findUniqueOrThrow({
    where: { id },
    include: { department: true, mapping: true, workLocation: true },
  });
  jsonRpcSuccess(res, biotimeOk({
    employee: employeeJson(employee, true),
    relativePath: result.relativePath,
    message: 'تم رفع البرنت التأميني',
  }), req.rpcId);
}));

router.post('/employees/insurance-print/get', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).employeeId ?? '');
  const file = await readInsurancePrint(id);
  if (!file) {
    jsonRpcSuccess(res, biotimeFail('لا يوجد برنت تأميني', 'NOT_FOUND'), req.rpcId);
    return;
  }
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

export default router;
