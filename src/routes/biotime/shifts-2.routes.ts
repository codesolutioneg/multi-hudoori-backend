import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { exportPayrollXlsx, exportCashFawryXlsx, exportFileResponse, } from '../../services/payrollExport.service';
import { exportShiftsXlsx, importShiftsXlsx, normalizeShiftTime } from '../../services/shiftsExcel.service';
import { prisma } from '../../prisma/client';
import { shiftJsonExtras, shiftTimesFromParams, sortShiftsForDisplay, validateShiftTimes } from '../../services/shiftCalculations.service';

const router = Router();

router.post('/shifts/delete', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.shiftId ?? '').trim();
  if (!id) {
    jsonRpcSuccess(res, biotimeFail('معرّف الشيفت مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }

  const existing = await prisma.shift.findUnique({ where: { id } });
  if (!existing) {
    jsonRpcSuccess(res, biotimeFail('الشيفت غير موجود', 'NOT_FOUND'), req.rpcId);
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.shiftAssignment.deleteMany({ where: { shiftId: id } });
      await tx.shiftChangeRequest.deleteMany({
        where: { OR: [{ newShiftId: id }, { currentShiftId: id }] },
      });
      await tx.shiftGridLine.updateMany({ where: { shiftId: id }, data: { shiftId: null } });
      await tx.attendance.updateMany({ where: { shiftId: id }, data: { shiftId: null } });
      await tx.shift.delete({ where: { id } });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'فشل حذف الشيفت';
    jsonRpcSuccess(res, biotimeFail(msg, 'SERVER_ERROR'), req.rpcId);
    return;
  }

  jsonRpcSuccess(res, biotimeOk({ message: 'تم حذف الشيفت' }), req.rpcId);
}));

router.post('/shifts/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const base64 = await exportShiftsXlsx();
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, 'shifts.xlsx')), req.rpcId);
}));

router.post('/shifts/import-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const file = String(p(req).file ?? p(req).base64 ?? '');
  if (!file) {
    jsonRpcSuccess(res, biotimeFail('ملف Excel مطلوب', 'MISSING_PARAM'), req.rpcId);
    return;
  }
  const result = await importShiftsXlsx(file);
  const shifts = sortShiftsForDisplay(await prisma.shift.findMany());
  jsonRpcSuccess(
    res,
    biotimeOk({
      ...result,
      message: `تم: ${result.created} جديد، ${result.updated} محدّث، ${result.skipped} تخطي`,
      shifts: shifts.map(shiftJson),
      count: shifts.length,
    }),
    req.rpcId,
  );
}));

// --- Shift assignments ---

export default router;
