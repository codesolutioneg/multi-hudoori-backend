import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import * as payrollDuplicateService from '../../services/payrollDuplicate.service';
import * as payrollEditTemplateService from '../../services/payrollEditTemplate.service';
import * as payrollImportService from '../../services/payrollImport.service';
import * as payrollLocationTransferService from '../../services/payrollLocationTransfer.service';
import * as payrollService from '../../services/payroll.service';
import * as payslipPdfService from '../../services/payslipPdf.service';
import { AdvanceState, DeductionState, PayrollState, ShiftGridState, HiringAppointmentStatus, UserRole } from '@prisma/client';
import { NotFoundError, AppError } from '../../utils/errors';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { exportPayrollDuplicatesXlsx } from '../../services/payrollDuplicatesExport.service';
import { exportPayrollXlsx, exportCashFawryXlsx, exportFileResponse, } from '../../services/payrollExport.service';
import {
  listPeriodZeroBasicSalary,
  exportPeriodZeroBasicSalaryXlsx,
  listPeriodDuplicates,
  exportPeriodDuplicatesXlsx,
  listPeriodNegativeNet,
  exportPeriodNegativeNetXlsx,
} from '../../services/payrollPeriodReports.service';
import {
  exportPeriodCashFawryZip,
  exportPeriodPayrollSummaryXlsx,
  exportZipFileResponse,
} from '../../services/payrollPeriodExports.service';
import { fixBasicSalarySingle } from '../../services/payrollLine.service';
import { prisma } from '../../prisma/client';
import { writeAudit } from '../../services/auditLog.service';

const router = Router();

router.post('/payroll/reset-edit-comparison', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const result = await payrollImportService.resetEditComparison(id);
  const payroll = await payrollService.getPayroll(id);
  jsonRpcSuccess(res, biotimeOk({ ...result, payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/duplicates/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const items = await payrollDuplicateService.listPayrollDuplicates(id);
  jsonRpcSuccess(res, biotimeOk({ items, count: items.length }), req.rpcId);
}));

router.post('/payroll/duplicates/move-line', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const result = await payrollDuplicateService.movePayrollLine({
    lineId: String(params.lineId ?? params.id ?? ''),
    targetPayrollId: params.targetPayrollId ? String(params.targetPayrollId) : undefined,
    action: params.action === 'delete' ? 'delete' : 'move',
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/payroll/duplicates/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const base64 = await exportPayrollDuplicatesXlsx(id);
  jsonRpcSuccess(
    res,
    biotimeOk(exportFileResponse(base64, `payroll_duplicates_${id}.xlsx`)),
    req.rpcId,
  );
}));

router.post('/payroll/period/zero-basic/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const result = await listPeriodZeroBasicSalary({
    dateFrom: params.dateFrom != null ? String(params.dateFrom) : null,
    dateTo: params.dateTo != null ? String(params.dateTo) : null,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/payroll/period/zero-basic/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const { base64, filename } = await exportPeriodZeroBasicSalaryXlsx({
    dateFrom: params.dateFrom != null ? String(params.dateFrom) : null,
    dateTo: params.dateTo != null ? String(params.dateTo) : null,
  });
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, filename)), req.rpcId);
}));

router.post('/payroll/period/duplicates/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const result = await listPeriodDuplicates({
    dateFrom: params.dateFrom != null ? String(params.dateFrom) : null,
    dateTo: params.dateTo != null ? String(params.dateTo) : null,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/payroll/period/duplicates/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const { base64, filename } = await exportPeriodDuplicatesXlsx({
    dateFrom: params.dateFrom != null ? String(params.dateFrom) : null,
    dateTo: params.dateTo != null ? String(params.dateTo) : null,
  });
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, filename)), req.rpcId);
}));

router.post('/payroll/period/negative-net/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const result = await listPeriodNegativeNet({
    dateFrom: params.dateFrom != null ? String(params.dateFrom) : null,
    dateTo: params.dateTo != null ? String(params.dateTo) : null,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/payroll/period/negative-net/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const { base64, filename } = await exportPeriodNegativeNetXlsx({
    dateFrom: params.dateFrom != null ? String(params.dateFrom) : null,
    dateTo: params.dateTo != null ? String(params.dateTo) : null,
  });
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, filename)), req.rpcId);
}));

router.post('/payroll/period/cash-fawry/export-zip', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = params.dateFrom != null ? String(params.dateFrom) : null;
  const dateTo = params.dateTo != null ? String(params.dateTo) : null;
  const result = await exportPeriodCashFawryZip({ dateFrom, dateTo });
  await writeAudit({
    req,
    module: 'payroll',
    action: 'payroll.period.cash_fawry_zip',
    entityType: 'PayrollPeriod',
    entityId: `${dateFrom}_${dateTo}`,
    summary: `تنزيل كاش/فوري للدورة (${result.fileCount} ملف)`,
    counts: { fileCount: result.fileCount },
    route: '/payroll/period/cash-fawry/export-zip',
  });
  jsonRpcSuccess(
    res,
    biotimeOk({
      ...exportZipFileResponse(result.base64, result.filename),
      fileCount: result.fileCount,
    }),
    req.rpcId,
  );
}));

router.post('/payroll/period/summary/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = params.dateFrom != null ? String(params.dateFrom) : null;
  const dateTo = params.dateTo != null ? String(params.dateTo) : null;
  const { base64, filename } = await exportPeriodPayrollSummaryXlsx({ dateFrom, dateTo });
  await writeAudit({
    req,
    module: 'payroll',
    action: 'payroll.period.summary_xlsx',
    entityType: 'PayrollPeriod',
    entityId: `${dateFrom}_${dateTo}`,
    summary: `تنزيل ملخص رواتب الدورة ${dateFrom} → ${dateTo}`,
    route: '/payroll/period/summary/export-xlsx',
  });
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, filename)), req.rpcId);
}));

router.post('/payroll/edit-template/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const base64 = await payrollEditTemplateService.exportPayrollEditTemplate(id);
  jsonRpcSuccess(
    res,
    biotimeOk(exportFileResponse(base64, `edit_template_${id}.xlsx`)),
    req.rpcId,
  );
}));

router.post('/payroll/edit-template/import-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const payrollId = String(params.payrollId ?? params.id ?? '');
  const file = String(params.file ?? params.base64 ?? '');
  if (!file.trim()) throw new AppError('ارفع ملف Excel', 400, 'VALIDATION_ERROR');
  const result = await payrollEditTemplateService.importPayrollEditTemplate(payrollId, file);
  const payroll = await payrollService.getPayroll(payrollId);
  jsonRpcSuccess(res, biotimeOk({ ...result, payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/calculate-single-employee', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const payrollId = String(params.payrollId ?? params.id ?? '');
  const employeeId = String(params.employeeId ?? '');
  if (!employeeId) throw new AppError('حدد الموظف', 400, 'VALIDATION_ERROR');
  const payroll = await payrollService.calculateSingleEmployee(payrollId, employeeId);
  jsonRpcSuccess(res, biotimeOk({ payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/location-transfer/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const payrollId = String(params.payrollId ?? params.id ?? '');
  const targetLocation = String(params.targetLocation ?? '');
  const items = await payrollLocationTransferService.listLocationTransferCandidates(payrollId, targetLocation);
  jsonRpcSuccess(res, biotimeOk({ items, count: items.length }), req.rpcId);
}));

router.post('/payroll/location-transfer/apply', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const result = await payrollLocationTransferService.applyLocationTransfer({
    payrollId: String(params.payrollId ?? params.id ?? ''),
    targetLocation: String(params.targetLocation ?? ''),
    lineIds: Array.isArray(params.lineIds) ? params.lineIds.map(String) : [],
  });
  const payroll = await payrollService.getPayroll(String(params.payrollId ?? params.id ?? ''));
  jsonRpcSuccess(res, biotimeOk({ ...result, payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/line/fix-basic-salary', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const lineId = String(p(req).lineId ?? p(req).id ?? '');
  const line = await fixBasicSalarySingle(lineId);
  const payroll = await payrollService.getPayroll(line.payrollId);
  jsonRpcSuccess(res, biotimeOk({
    line: payrollLineJson(line),
    payroll: payrollJson(payroll, true, payroll.lines),
  }), req.rpcId);
}));

router.post('/payroll/payslip/detail', requireAuth, asyncHandler(async (req, res) => {
  const lineId = String(p(req).lineId ?? '');
  if (!lineId) throw new AppError('حدد سطر الراتب', 400, 'VALIDATION_ERROR');
  const detail = await payslipPdfService.getPayslipDetail(lineId);
  const profile = await prisma.employeeProfile.findFirst({ where: { userId: req.user!.id } });
  const hrRoles: UserRole[] = [
    UserRole.HR_MANAGER,
    UserRole.HR_SUPERVISOR,
    UserRole.HR_USER,
    UserRole.PLATFORM_ADMIN,
  ];
  const isHr = hrRoles.includes(req.user!.role);
  if (req.user!.role === UserRole.EMPLOYEE) {
    throw new AppError('حساب الموظف يعرض الحضور والجدول فقط', 403, 'READ_ONLY');
  }
  if (!isHr && profile?.id !== detail.employeeId) {
    throw new AppError('غير مصرح', 403, 'FORBIDDEN');
  }
  jsonRpcSuccess(res, biotimeOk({ detail }), req.rpcId);
}));

router.post('/payroll/payslip/pdf', requireAuth, asyncHandler(async (req, res) => {
  const lineId = String(p(req).lineId ?? '');
  if (!lineId) throw new AppError('حدد سطر الراتب', 400, 'VALIDATION_ERROR');
  const line = await prisma.payrollLine.findUnique({ where: { id: lineId } });
  if (!line) throw new NotFoundError('Payroll line not found');
  const profile = await prisma.employeeProfile.findFirst({ where: { userId: req.user!.id } });
  const hrRoles: UserRole[] = [
    UserRole.HR_MANAGER,
    UserRole.HR_SUPERVISOR,
    UserRole.HR_USER,
    UserRole.PLATFORM_ADMIN,
  ];
  const isHr = hrRoles.includes(req.user!.role);
  if (req.user!.role === UserRole.EMPLOYEE) {
    throw new AppError('حساب الموظف يعرض الحضور والجدول فقط', 403, 'READ_ONLY');
  }
  if (!isHr && profile?.id !== line.employeeId) {
    throw new AppError('غير مصرح', 403, 'FORBIDDEN');
  }
  const file = await payslipPdfService.generatePayslipPdf(lineId);
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

export default router;
