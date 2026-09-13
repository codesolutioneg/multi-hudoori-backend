import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import * as payrollImportService from '../../services/payrollImport.service';
import * as payrollService from '../../services/payroll.service';
import { AdvanceState, DeductionState, PayrollState, ShiftGridState, HiringAppointmentStatus, UserRole } from '@prisma/client';
import { NotFoundError, AppError } from '../../utils/errors';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { linkLongAdvancesOnly, lockLongAdvanceAccounting } from '../../services/advances.service';
import { parsePagination, paginationMeta } from '../../utils/pagination';
import { writeAudit } from '../../services/auditLog.service';
import { findOverDeductedPayrollLines } from '../../services/payrollLine.service';
import {
  exportPunchImportReferenceForPayroll,
  getAppliedPunchImportForPayroll,
  punchImportSourceJson,
  reimportPunchReportForPayroll,
} from '../../services/punchReportImport.service';
import { exportFileResponse } from '../../services/payrollExport.service';

const router = Router();

router.post('/payroll/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const { limit, offset, page } = parsePagination(params, { limit: 100, maxLimit: 200 });
  const state = params.state ? (String(params.state) as PayrollState) : undefined;
  const [total, payrolls] = await Promise.all([
    payrollService.countPayrolls(state),
    payrollService.listPayrolls({ limit, offset, state }),
  ]);
  jsonRpcSuccess(
    res,
    biotimeOk({
      payrolls: payrolls.map((row) => {
        const batch = row.punchReportImports?.[0] ?? null;
        return payrollJson(row, false, undefined, undefined, undefined, punchImportSourceJson(batch));
      }),
      items: payrolls.map((row) => {
        const batch = row.punchReportImports?.[0] ?? null;
        return payrollJson(row, false, undefined, undefined, undefined, punchImportSourceJson(batch));
      }),
      ...paginationMeta(total, limit, offset, page),
    }),
    req.rpcId,
  );
}));

router.post('/payroll/get', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.payrollId ?? '');
  const lineLimit = params.lineLimit != null ? Number(params.lineLimit) : undefined;
  const lineOffset = params.lineOffset != null ? Number(params.lineOffset) : undefined;
  const lineSearch = params.lineSearch != null ? String(params.lineSearch) : params.search != null ? String(params.search) : undefined;
  const payroll = await payrollService.getPayroll(id, {
    includeLines: params.includeLines !== false,
    lineLimit,
    lineOffset,
    lineSearch,
  });
  const linePagination = (payroll as { linePagination?: Record<string, unknown> }).linePagination;
  const employeeCount = linePagination
    ? Number(linePagination.total ?? 0)
    : (payroll as { _count?: { lines: number } })._count?.lines ?? payroll.lines.length;
  const linkStats = await payrollService.getPayrollLinkStats(id);
  const overDeducted = await findOverDeductedPayrollLines(id);
  const punchImport = await getAppliedPunchImportForPayroll(id);
  jsonRpcSuccess(
    res,
    biotimeOk({
      payroll: payrollJson(
        payroll,
        true,
        payroll.lines,
        employeeCount,
        linkStats,
        punchImportSourceJson(punchImport),
      ),
      overDeducted,
      overDeductedCount: overDeducted.length,
      ...(linePagination ? { linePagination } : {}),
    }),
    req.rpcId,
  );
}));

router.post('/payroll/create', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const payroll = await payrollService.createPayroll({
    dateFrom: params.dateFrom != null ? String(params.dateFrom) : undefined,
    dateTo: params.dateTo != null ? String(params.dateTo) : undefined,
    shiftGridId: params.shiftGridId ? String(params.shiftGridId) : undefined,
    deviceId: params.deviceId ? String(params.deviceId) : undefined,
    name: params.name ? String(params.name) : undefined,
  });
  await writeAudit({
    req,
    module: 'payroll',
    action: 'payroll.create',
    entityType: 'Payroll',
    entityId: payroll.id,
    summary: `إنشاء مسير: ${payroll.name || payroll.id}`,
    route: '/payroll/create',
  });
  jsonRpcSuccess(res, biotimeOk({ payroll: payrollJson(payroll) }), req.rpcId);
}));

router.post('/payroll/calculate', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  try {
    const before = await payrollService.getPayroll(id, { includeLines: false });
    const linkOnly = payrollService.isPayrollExcelSourceLocked(before);
    const payroll = await payrollService.calculatePayroll(id);
    const overDeducted = await findOverDeductedPayrollLines(id);
    await writeAudit({
      req,
      module: 'payroll',
      action: 'payroll.calculate',
      entityType: 'Payroll',
      entityId: id,
      summary: linkOnly
        ? `حساب مسير (ربط فقط بعد Excel): ${payroll.name || id}`
        : `حساب مسير: ${payroll.name || id}`,
      counts: overDeducted.length ? { overDeductedCount: overDeducted.length } : undefined,
      route: '/payroll/calculate',
    });
    const punchImport = await getAppliedPunchImportForPayroll(id);
    jsonRpcSuccess(
      res,
      biotimeOk({
        payroll: payrollJson(
          payroll,
          true,
          payroll.lines,
          undefined,
          undefined,
          punchImportSourceJson(punchImport),
        ),
        overDeducted,
        overDeductedCount: overDeducted.length,
        calculateMode: linkOnly ? 'excel_link_only' : 'rebuild',
        message: linkOnly
          ? 'تم ربط السلف والاستقطاعات فقط — لم يُعاد البناء من تقرير البصمات (آخر مصدر: Excel)'
          : undefined,
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    jsonRpcSuccess(res, biotimeFail(e instanceof Error ? e.message : 'Calculate failed', 'ACTION_ERROR'), req.rpcId);
  }
}));

router.post('/payroll/confirm', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const payroll = await payrollService.confirmPayroll(id);
  await writeAudit({
    req,
    module: 'payroll',
    action: 'payroll.confirm',
    entityType: 'Payroll',
    entityId: id,
    summary: `تأكيد مسير: ${payroll.name || id}`,
    route: '/payroll/confirm',
  });
  jsonRpcSuccess(res, biotimeOk({ payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/link-deductions', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  await payrollService.linkDeductionsAndAdvances(id);
  const payroll = await payrollService.getPayroll(id);
  jsonRpcSuccess(res, biotimeOk({ payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/back-to-draft', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const payroll = await payrollService.backToDraft(id);
  jsonRpcSuccess(res, biotimeOk({ payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/sync-employee-info', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const result = await payrollService.syncEmployeeInfo(id);
  const payroll = await payrollService.getPayroll(id);
  jsonRpcSuccess(res, biotimeOk({ ...result, payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/recalculate-basic-salary', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const result = await payrollService.recalculateBasicSalary(id);
  const payroll = await payrollService.getPayroll(id);
  jsonRpcSuccess(res, biotimeOk({ ...result, payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/recalculate-advances', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const result = await payrollService.recalculateAdvancesOnly(id);
  const payroll = await payrollService.getPayroll(id);
  jsonRpcSuccess(res, biotimeOk({ ...result, payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/link-long-advances', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const result = await linkLongAdvancesOnly(id);
  const payroll = await payrollService.getPayroll(id);
  jsonRpcSuccess(res, biotimeOk({ ...result, payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/import-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const payrollId = String(params.payrollId ?? params.id ?? '');
  const file = String(params.file ?? params.base64 ?? '');
  if (!file.trim()) throw new AppError('ارفع ملف Excel', 400, 'VALIDATION_ERROR');
  const result = await payrollImportService.importPayrollXlsx(payrollId, file);
  const payroll = await payrollService.getPayroll(payrollId);
  await writeAudit({
    req,
    module: 'payroll',
    action: 'payroll.import',
    entityType: 'Payroll',
    entityId: payrollId,
    summary: `استيراد مسير Excel: ${payroll.name || payrollId}`,
    counts: { updated: result.updated, skipped: result.skipped },
    route: '/payroll/import-xlsx',
  });
  jsonRpcSuccess(res, biotimeOk({ ...result, payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/export-punch-import-reference', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const { base64, filename } = await exportPunchImportReferenceForPayroll(id);
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, filename)), req.rpcId);
}));

router.post('/payroll/reimport-punch-report', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const payrollId = String(params.payrollId ?? params.id ?? '');
  const file = String(params.file ?? params.base64 ?? '');
  if (!file.trim()) {
    jsonRpcSuccess(res, biotimeFail('ملف Excel مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  try {
    const result = await reimportPunchReportForPayroll({
      payrollId,
      base64: file,
      filename: params.filename != null ? String(params.filename) : undefined,
    });
    await writeAudit({
      req,
      module: 'payroll',
      action: 'payroll.reimport_punch_report',
      entityType: 'Payroll',
      entityId: payrollId,
      summary: result.message ?? `إعادة استيراد تقرير بصمات: ${payrollId}`,
      counts: {
        lineCount: result.lineCount,
        employeeCount: result.employeeCount,
        skippedUnknown: result.skippedUnknown,
      },
      route: '/payroll/reimport-punch-report',
    });
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'فشل إعادة استيراد تقرير البصمات', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

export default router;
