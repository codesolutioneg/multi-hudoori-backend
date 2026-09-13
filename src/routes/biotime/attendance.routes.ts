import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import * as attendanceService from '../../services/attendance.service';
import * as generateJobService from '../../services/generateJob.service';
import * as odooClient from '../../services/odoo/odooClient.service';
import * as odooPushService from '../../services/odoo/odooPush.service';
import * as odooLoanAccounts from '../../services/odoo/odooLoanAccounts.service';
import { config } from '../../config';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { generatePunchReport } from '../../services/punchReport.service';
import { parsePagination, paginationMeta } from '../../utils/pagination';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/attendance/my', requireAuth, asyncHandler(async (req, res) => {
  const profile = await prisma.employeeProfile.findFirst({ where: { userId: req.user!.id } });
  if (!profile) {
    jsonRpcSuccess(res, biotimeOk({ records: [], count: 0 }), req.rpcId);
    return;
  }
  const params = p(req);
  const dateFrom = params.dateFrom ? new Date(String(params.dateFrom)) : new Date(Date.now() - 30 * 86400000);
  const dateTo = params.dateTo ? new Date(String(params.dateTo)) : new Date();
  const records = await prisma.attendance.findMany({
    where: { employeeId: profile.id, date: { gte: dateFrom, lte: dateTo } },
    orderBy: { date: 'desc' },
  });
  jsonRpcSuccess(res, biotimeOk({ records: records.map(attendanceJson), count: records.length }), req.rpcId);
}));

router.post('/attendance/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const { limit, offset, page } = parsePagination(params, { limit: 50, maxLimit: 200 });
  const dateFrom = params.dateFrom ? new Date(String(params.dateFrom)) : undefined;
  const dateTo = params.dateTo ? new Date(String(params.dateTo)) : undefined;
  const result = await attendanceService.listAttendance({
    dateFrom,
    dateTo,
    employeeId: params.employeeId ? String(params.employeeId) : undefined,
    departmentId: params.departmentId ? String(params.departmentId) : undefined,
    search: params.search ? String(params.search) : undefined,
    status: params.status ? String(params.status) : undefined,
    limit,
    offset,
  });
  jsonRpcSuccess(
    res,
    biotimeOk({
      records: result.records.map(attendanceJson),
      dateFrom: result.dateFrom.toISOString().slice(0, 10),
      dateTo: result.dateTo.toISOString().slice(0, 10),
      summary: result.summary,
      ...paginationMeta(result.total, limit, offset, page),
    }),
    req.rpcId,
  );
}));

router.post('/attendance/generate', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = new Date(String(params.dateFrom ?? new Date().toISOString().slice(0, 10)));
  const dateTo = new Date(String(params.dateTo ?? dateFrom.toISOString().slice(0, 10)));
  const jobId = await generateJobService.queueAttendanceGenerate({
    dateFrom,
    dateTo,
    shiftGridId: params.shiftGridId ? String(params.shiftGridId) : undefined,
    employeeIds: params.employeeIds as string[] | undefined,
    deviceSns: Array.isArray(params.deviceSns) ? params.deviceSns.map(String) : undefined,
    skipExisting: params.skipExisting === true,
    generateAbsences: params.generateAbsences !== false,
  });
  jsonRpcSuccess(res, biotimeOk({ jobId, queued: true, message: 'Attendance generation started' }), req.rpcId);
}));

router.post('/odoo/config/get', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const status = await odooPushService.getOdooPushStatus();
  jsonRpcSuccess(res, biotimeOk(status), req.rpcId);
}));

router.post('/odoo/config/update', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const optionalInt = (v: unknown): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === '' || v === false) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  await odooClient.updateOdooConfig({
    baseUrl: params.baseUrl != null ? String(params.baseUrl) : undefined,
    database: params.database != null ? String(params.database) : undefined,
    login: params.login != null ? String(params.login) : undefined,
    password: params.password != null ? String(params.password) : undefined,
    integrationEnabled:
      params.integrationEnabled != null
        ? params.integrationEnabled === true || params.integrationEnabled === 'true'
        : undefined,
    journalOdooId: optionalInt(params.journalOdooId),
    cashDebitAccountOdooId: optionalInt(params.cashDebitAccountOdooId),
    cashCreditAccountOdooId: optionalInt(params.cashCreditAccountOdooId),
    fawryDebitAccountOdooId: optionalInt(params.fawryDebitAccountOdooId),
    fawryCreditAccountOdooId: optionalInt(params.fawryCreditAccountOdooId),
  });
  const status = await odooPushService.getOdooPushStatus();
  jsonRpcSuccess(res, biotimeOk(status), req.rpcId);
}));

router.post('/odoo/config/test-connection', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const result = await odooClient.testOdooConnection();
  const status = await odooPushService.getOdooPushStatus();
  jsonRpcSuccess(
    res,
    result.ok ? biotimeOk({ ...status, message: result.message }) : biotimeFail(result.message, 'CONNECTION_FAILED'),
    req.rpcId,
  );
}));

router.post('/odoo/journals/list', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const journals = await odooLoanAccounts.listOdooJournals();
  jsonRpcSuccess(res, biotimeOk({ journals, count: journals.length }), req.rpcId);
}));

router.post('/odoo/accounts/list', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const search = p(req).search != null ? String(p(req).search) : undefined;
  const accounts = await odooLoanAccounts.listOdooAccounts(search);
  jsonRpcSuccess(res, biotimeOk({ accounts, count: accounts.length }), req.rpcId);
}));

router.post('/odoo/loan-review/upload', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const result = await odooLoanAccounts.uploadLoanReviewExcelToOdoo({
    fileBase64: String(params.fileBase64 ?? params.base64 ?? ''),
    filename: params.filename != null ? String(params.filename) : undefined,
  });
  jsonRpcSuccess(
    res,
    biotimeOk({
      ...result,
      message: `تم إنشاء ${result.name} والقيد رقم ${result.moveId} في Odoo`,
    }),
    req.rpcId,
  );
}));

router.post('/odoo/push-status', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const status = await odooPushService.getOdooPushStatus();
  jsonRpcSuccess(res, biotimeOk(status), req.rpcId);
}));

router.post('/odoo/push-all', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const config = await odooClient.getOdooConfig();
  if (!config.baseUrl || !config.login || !config.password) {
    jsonRpcSuccess(res, biotimeFail('أكمل إعدادات Odoo أولاً', 'CONFIG_MISSING'), req.rpcId);
    return;
  }
  const jobId = await generateJobService.queueOdooPush();
  jsonRpcSuccess(res, biotimeOk({ queued: true, jobId }), req.rpcId);
}));

router.post('/jobs/status', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const jobId = String(p(req).jobId ?? '');
  const job = await generateJobService.getJobStatus(jobId);
  if (!job) {
    jsonRpcSuccess(res, biotimeFail('Job not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  jsonRpcSuccess(res, biotimeOk(job), req.rpcId);
}));

router.post('/punch-report/generate', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = new Date(String(params.dateFrom));
  const dateTo = new Date(String(params.dateTo));
  const lines = await generatePunchReport(
    dateFrom,
    dateTo,
    params.employeeIds as string[] | undefined,
    params.shiftGridId ? String(params.shiftGridId) : undefined,
  );
  jsonRpcSuccess(res, biotimeOk({ lines, count: lines.length }), req.rpcId);
}));

// --- Config ---

export default router;
