import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrOrBranchManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { loadShiftGridForAccess } from './shift-grid-helpers';
import * as payrollService from '../../services/payroll.service';
import * as payslipPdfService from '../../services/payslipPdf.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { exportPayrollXlsx, exportPayslipsXlsx, exportCashFawryXlsx, exportFileResponse, } from '../../services/payrollExport.service';
import { getSentSnapshotOrGenerate } from '../../services/payrollSentSnapshot.service';
import { exportPunchReportFileResponse, exportSelectedGridPunchReportXlsx, exportShiftGridPunchReportXlsx, } from '../../services/punchReportExcel.service';
import {
  importPunchReportExcel,
  createPayrollFromPunchImport,
} from '../../services/punchReportImport.service';
import { exportShiftGridXlsx, importShiftGridXlsx, resolveGridExcelDateRange } from '../../services/shiftGridExcel.service';
import { exportShiftGridsByDepartmentZip, exportShiftGridsFullZip } from '../../services/shiftGridBulkDeptExport.service';
import { parseGridGrouping } from '../../services/shiftGridGrouping.service';
import { updatePayrollLine } from '../../services/payrollLine.service';
import { prisma } from '../../prisma/client';
import { getHrLocationScope } from '../../services/userLocationScope.service';
import type { Prisma } from '@prisma/client';
import { writeAudit } from '../../services/auditLog.service';
import * as odooPayrollJournal from '../../services/odoo/odooPayrollJournal.service';

const router = Router();

router.post('/payroll/payslip/pdf-all', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const payrollId = String(p(req).payrollId ?? p(req).id ?? '');
  const file = await payslipPdfService.generateAllPayslipsPdf(payrollId);
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

router.post('/payroll/link-deductions-confirmed', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  await payrollService.linkDeductionsOnly(id, { allowConfirmed: true });
  const payroll = await payrollService.getPayroll(id);
  jsonRpcSuccess(res, biotimeOk({ payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/fix-penalty-values', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const result = await payrollService.fixPenaltyValues(id);
  const payroll = await payrollService.getPayroll(id);
  jsonRpcSuccess(res, biotimeOk({ ...result, payroll: payrollJson(payroll, true, payroll.lines) }), req.rpcId);
}));

router.post('/payroll/check-duplicates', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const result = await payrollService.checkPayrollDuplicates(id);
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/payroll/line/update', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const lineId = String(params.lineId ?? params.id ?? '');
  const line = await updatePayrollLine(lineId, params as Record<string, unknown>);
  jsonRpcSuccess(res, biotimeOk({ line: payrollLineJson(line) }), req.rpcId);
}));

router.post('/payroll/send-to-odoo', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const result = await odooPayrollJournal.sendPayrollJournalToOdoo(id);
  await writeAudit({
    req,
    module: 'payroll',
    action: 'payroll.send_to_odoo',
    entityType: 'Payroll',
    entityId: id,
    summary: `إرسال قيد مرتبات إلى Odoo: ${result.odooMoveName}`,
    payload: {
      odooMoveId: result.odooMoveId,
      odooMoveName: result.odooMoveName,
      odooPayrollJournalId: result.odooPayrollJournalId,
      email: result.email,
    },
    route: '/payroll/send-to-odoo',
  });
  const payroll = await payrollService.getPayroll(id);
  jsonRpcSuccess(res, biotimeOk({
    payroll: payrollJson(payroll, true, payroll.lines),
    odooMoveId: result.odooMoveId,
    odooMoveName: result.odooMoveName,
    odooPayrollJournalId: result.odooPayrollJournalId,
    journalName: result.journalName,
    amounts: result.amounts,
    cashFawry: result.cashFawry,
    email: result.email,
  }), req.rpcId);
}));

router.post('/payroll/odoo-journal/preview', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const preview = await odooPayrollJournal.previewPayrollJournal(id);
  jsonRpcSuccess(res, biotimeOk(preview), req.rpcId);
}));

router.post('/payroll/finalize', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const result = await payrollService.finalizePayroll(id);
  jsonRpcSuccess(res, biotimeOk({
    payroll: payrollJson(result.payroll, true, result.payroll.lines),
    journalSkipped: result.journalSkipped,
    journalEntryId: result.journalEntryId,
  }), req.rpcId);
}));

router.post('/payroll/export-fawry', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const { base64, filename } = await getSentSnapshotOrGenerate(id, 'fawry', () =>
    payrollService.exportFawry(id),
  );
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, filename)), req.rpcId);
}));

router.post('/payroll/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const { base64, filename } = await getSentSnapshotOrGenerate(id, 'payroll', () =>
    exportPayrollXlsx(id),
  );
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, filename)), req.rpcId);
}));

router.post('/payroll/export-payslips-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const { base64, filename } = await exportPayslipsXlsx(id);
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, filename)), req.rpcId);
}));

router.post('/payroll/export-cash-fawry', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).payrollId ?? '');
  const { base64, filename } = await getSentSnapshotOrGenerate(id, 'cashFawry', () =>
    exportCashFawryXlsx(id),
  );
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, filename)), req.rpcId);
}));

router.post('/shift-grid/export-xlsx', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? '');
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const dateFrom = params.dateFrom != null ? String(params.dateFrom) : undefined;
  const dateTo = params.dateTo != null ? String(params.dateTo) : undefined;
  try {
    const range = resolveGridExcelDateRange(grid.dateFrom, grid.dateTo, dateFrom, dateTo);
    const fromKey = range.from.toISOString().slice(0, 10);
    const toKey = range.to.toISOString().slice(0, 10);
    const groupKeys = Array.isArray(params.groupKeys)
      ? params.groupKeys.map(String).map((s) => s.trim()).filter(Boolean)
      : undefined;
    const departmentNames = Array.isArray(params.departmentNames)
      ? params.departmentNames.map(String).map((s) => s.trim()).filter(Boolean)
      : undefined;
    const employeeIds = Array.isArray(params.employeeIds)
      ? params.employeeIds.map(String).map((s) => s.trim()).filter(Boolean)
      : undefined;
    const base64 = await exportShiftGridXlsx(gridId, {
      dateFrom,
      dateTo,
      grouping: parseGridGrouping(params.grouping),
      sheetPerGroup: params.sheetPerGroup === true,
      ...(groupKeys?.length ? { groupKeys } : {}),
      ...(departmentNames?.length ? { departmentNames } : {}),
      ...(employeeIds?.length ? { employeeIds } : {}),
    });
    const safeName = String(grid.name || 'shift_grid')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'shift_grid';
    const deptSuffix = (departmentNames ?? [])
      .map((name) =>
        name
          .replace(/[\\/:*?"<>|]+/g, '_')
          .replace(/\s+/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, ''),
      )
      .filter(Boolean)
      .join('_');
    const filename = deptSuffix
      ? `${safeName}_${fromKey}_${toKey}_${deptSuffix}.xlsx`
      : `${safeName}_${fromKey}_${toKey}.xlsx`;
    await writeAudit({
      req,
      module: 'shift_grid',
      action: 'shift_grid.export',
      entityType: 'ShiftGrid',
      entityId: gridId,
      summary: `تصدير جدول شيفت: ${grid.name || gridId}`,
      payload: {
        dateFrom: fromKey,
        dateTo: toKey,
        filename,
        employeeIds: employeeIds?.length ?? 0,
        departmentNames: departmentNames?.length ?? 0,
      },
      route: '/shift-grid/export-xlsx',
    });
    jsonRpcSuccess(
      res,
      biotimeOk(exportFileResponse(base64, filename)),
      req.rpcId,
    );
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'Export failed', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

/**
 * One Excel per department for every selected (or accessible) shift grid,
 * returned as a single ZIP.
 */
router.post('/shift-grid/export-xlsx-by-department-bulk', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = params.dateFrom != null ? String(params.dateFrom) : undefined;
  const dateTo = params.dateTo != null ? String(params.dateTo) : undefined;
  const explicitIds = Array.isArray(params.gridIds)
    ? params.gridIds.map(String).map((s) => s.trim()).filter(Boolean)
    : [];

  try {
    const scope = await getHrLocationScope(req.user!.id, req.user!.role);
    const where: Prisma.ShiftGridWhereInput = {};
    if (explicitIds.length) {
      where.id = { in: explicitIds };
    }
    if (scope) {
      where.locationId = scope;
    }

    const grids = await prisma.shiftGrid.findMany({
      where,
      select: { id: true, name: true, dateFrom: true, dateTo: true, locationId: true },
      orderBy: [{ dateFrom: 'desc' }, { name: 'asc' }],
    });

    // When the client passes the currently visible list, keep that order/filter.
    const ordered = explicitIds.length
      ? explicitIds
          .map((id) => grids.find((g) => g.id === id))
          .filter((g): g is (typeof grids)[number] => !!g)
      : grids;

    const result = await exportShiftGridsByDepartmentZip(ordered, { dateFrom, dateTo });
    jsonRpcSuccess(
      res,
      biotimeOk({
        file: result.base64,
        base64: result.base64,
        filename: result.filename,
        mimeType: result.mimeType,
        gridCount: result.gridCount,
        fileCount: result.fileCount,
        skipped: result.skipped,
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'Export failed', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

/**
 * One full Excel workbook per selected shift grid, returned as a ZIP.
 */
router.post('/shift-grid/export-xlsx-bulk', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const dateFrom = params.dateFrom != null ? String(params.dateFrom) : undefined;
  const dateTo = params.dateTo != null ? String(params.dateTo) : undefined;
  const explicitIds = Array.isArray(params.gridIds)
    ? params.gridIds.map(String).map((s) => s.trim()).filter(Boolean)
    : [];

  try {
    const scope = await getHrLocationScope(req.user!.id, req.user!.role);
    const where: Prisma.ShiftGridWhereInput = {};
    if (explicitIds.length) {
      where.id = { in: explicitIds };
    }
    if (scope) {
      where.locationId = scope;
    }

    const grids = await prisma.shiftGrid.findMany({
      where,
      select: { id: true, name: true, dateFrom: true, dateTo: true, locationId: true },
      orderBy: [{ dateFrom: 'desc' }, { name: 'asc' }],
    });

    const ordered = explicitIds.length
      ? explicitIds
          .map((id) => grids.find((g) => g.id === id))
          .filter((g): g is (typeof grids)[number] => !!g)
      : grids;

    if (!ordered.length) {
      jsonRpcSuccess(res, biotimeFail('لا توجد جداول للتصدير', 'VALIDATION'), req.rpcId);
      return;
    }

    const result = await exportShiftGridsFullZip(ordered, { dateFrom, dateTo });
    jsonRpcSuccess(
      res,
      biotimeOk({
        file: result.base64,
        base64: result.base64,
        filename: result.filename,
        mimeType: result.mimeType,
        gridCount: result.gridCount,
        fileCount: result.fileCount,
        skipped: result.skipped,
      }),
      req.rpcId,
    );
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'Export failed', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

router.post('/shift-grid/punch-report-export-xlsx', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const gridId = String(p(req).gridId ?? p(req).id ?? '');
  if (!gridId) {
    jsonRpcSuccess(res, biotimeFail('معرّف الجدول مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const file = await exportShiftGridPunchReportXlsx(gridId);
    jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'فشل تصدير تقرير البصمات', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

router.post('/shift-grid/punch-report-import', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? params.id ?? '');
  if (!gridId) {
    jsonRpcSuccess(res, biotimeFail('معرّف الجدول مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const file = String(params.file ?? params.base64 ?? '');
  if (!file) {
    jsonRpcSuccess(res, biotimeFail('ملف Excel مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  try {
    const result = await importPunchReportExcel({
      shiftGridId: gridId,
      base64: file,
      filename: params.filename != null ? String(params.filename) : undefined,
    });
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'فشل استيراد تقرير البصمات', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

router.post('/shift-grid/payroll-from-punch-import', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const gridId = String(params.gridId ?? params.id ?? '');
  if (!gridId) {
    jsonRpcSuccess(res, biotimeFail('معرّف الجدول مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  const grid = await loadShiftGridForAccess(req, gridId);
  if (!grid) {
    jsonRpcSuccess(res, biotimeFail('Grid not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  try {
    const result = await createPayrollFromPunchImport({
      shiftGridId: gridId,
      importId: params.importId != null ? String(params.importId) : undefined,
    });
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(
      res,
      biotimeFail(e instanceof Error ? e.message : 'فشل إنشاء كشف الرواتب من الاستيراد', 'ACTION_ERROR'),
      req.rpcId,
    );
  }
}));

export default router;
