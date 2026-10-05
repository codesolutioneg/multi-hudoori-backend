import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { AdvanceState, DeductionState, PayrollState, ShiftGridState, HiringAppointmentStatus, UserRole } from '@prisma/client';
import { DEDUCTION_TYPE_FIELD } from '../../services/payrollDeductions.service';
import { NotFoundError, AppError } from '../../utils/errors';
import { Prisma } from '@prisma/client';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { exportDeductionMultiTemplate, exportDeductionTemplate, importDeductionMultiXlsx, importDeductionXlsx, } from '../../services/deductionExcel.service';
import { exportPayrollXlsx, exportCashFawryXlsx, exportFileResponse, } from '../../services/payrollExport.service';
import { nextDeductionReference } from '../../services/deductionReference.service';
import { parsePagination, paginationMeta } from '../../utils/pagination';
import { prisma } from '../../prisma/client';
import { writeAudit } from '../../services/auditLog.service';

const router = Router();

router.post('/deductions/types', requireAuth, requireHr, asyncHandler(async (req, res) => {
  jsonRpcSuccess(res, biotimeOk({ types: DEDUCTION_TYPES }), req.rpcId);
}));

router.post('/deductions/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const { limit, offset, page } = parsePagination(params, { limit: 40, maxLimit: 2000 });
  const stateParam = params.state ? String(params.state) : undefined;
  const where: Prisma.DeductionWhereInput =
    stateParam === 'pending'
      ? { state: DeductionState.draft }
      : stateParam === 'applied'
        ? { state: DeductionState.linked }
        : stateParam === 'cancelled'
          ? { state: DeductionState.cancelled }
          : {};

  if (params.deviceId) where.deviceId = String(params.deviceId);
  if (params.locationId) {
    where.device = { locationId: String(params.locationId) };
  }
  if (params.type) where.type = String(params.type);
  if (params.dateFrom || params.dateTo) {
    where.date = {};
    if (params.dateFrom) where.date.gte = new Date(String(params.dateFrom).slice(0, 10));
    if (params.dateTo) where.date.lte = new Date(String(params.dateTo).slice(0, 10));
  }

  const [total, deductions] = await Promise.all([
    prisma.deduction.count({ where }),
    prisma.deduction.findMany({
      where,
      include: { employee: true, device: { include: { location: true } } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      skip: offset,
    }),
  ]);
  const items = deductions.map(deductionJson);
  jsonRpcSuccess(
    res,
    biotimeOk({
      deductions: items,
      items,
      ...paginationMeta(total, limit, offset, page),
    }),
    req.rpcId,
  );
}));

router.post('/deductions/create', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const dedType = String(params.type ?? params.deductionType ?? 'manual_debit');
  if (!DEDUCTION_TYPE_FIELD[dedType]) {
    throw new AppError('نوع الخصم غير مدعوم', 400, 'VALIDATION_ERROR');
  }
  const dedDate = params.date
    ? new Date(String(params.date).slice(0, 10))
    : new Date();
  const reference = await nextDeductionReference(dedDate);
  const d = await prisma.deduction.create({
    data: {
      reference,
      employeeId: String(params.employeeId),
      type: dedType,
      amount: Number(params.amount ?? 0),
      date: dedDate,
      deviceId: params.deviceId ? String(params.deviceId) : null,
      notes: params.notes
        ? String(params.notes)
        : params.note
          ? String(params.note)
          : null,
      state: DeductionState.draft,
    },
    include: { employee: true, device: { include: { location: true } } },
  });
  await writeAudit({
    req,
    module: 'deductions',
    action: 'deductions.create',
    entityType: 'Deduction',
    entityId: d.id,
    summary: `إنشاء استقطاع: ${d.employee?.name ?? d.employeeId} — ${d.amount}`,
    payload: {
      reference: d.reference,
      employeeName: d.employee?.name,
      employeeCode: d.employee?.code,
      type: d.type,
      amount: d.amount,
      date: d.date,
      notes: d.notes,
    },
    diffPreview: [
      {
        field: 'amount',
        after: d.amount,
        entityLabel: d.employee?.name ?? d.employeeId,
        note: d.type,
      },
    ],
    route: '/deductions/create',
  });
  jsonRpcSuccess(res, biotimeOk({ deduction: deductionJson(d) }), req.rpcId);
}));

router.post('/deductions/cancel', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).deductionId ?? '');
  const existing = await prisma.deduction.findUnique({
    where: { id },
    include: { employee: true },
  });
  if (!existing) throw new NotFoundError('Deduction not found');
  if (existing.state === DeductionState.linked) {
    throw new AppError('الخصم مخصوم بالفعل من كشف راتب — لا يمكن إلغاؤه', 400, 'ACTION_ERROR');
  }
  const d = await prisma.deduction.update({
    where: { id },
    data: { state: DeductionState.cancelled },
    include: { employee: true, device: { include: { location: true } } },
  });
  await writeAudit({
    req,
    module: 'deductions',
    action: 'deductions.cancel',
    entityType: 'Deduction',
    entityId: d.id,
    summary: `إلغاء استقطاع: ${d.employee?.name ?? d.employeeId} — ${d.amount}`,
    payload: {
      reference: d.reference,
      employeeName: d.employee?.name,
      type: d.type,
      amount: d.amount,
      previousStatus: existing.state,
      status: d.state,
    },
    diffPreview: [
      {
        field: 'state',
        before: existing.state,
        after: d.state,
        entityLabel: d.employee?.name ?? d.employeeId,
      },
    ],
    route: '/deductions/cancel',
  });
  jsonRpcSuccess(res, biotimeOk({ deduction: deductionJson(d) }), req.rpcId);
}));

/** Hard-delete pending (draft) deductions only — never linked/applied. */
router.post('/deductions/delete-bulk', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const rawIds = p(req).ids ?? p(req).deductionIds ?? [];
  const ids = (Array.isArray(rawIds) ? rawIds : [rawIds])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) {
    throw new AppError('حدد استقطاعات للحذف', 400, 'VALIDATION_ERROR');
  }
  if (uniqueIds.length > 2000) {
    throw new AppError('الحد الأقصى 2000 استقطاع في العملية الواحدة', 400, 'VALIDATION_ERROR');
  }

  const rows = await prisma.deduction.findMany({
    where: { id: { in: uniqueIds } },
    include: { employee: { select: { id: true, name: true, code: true } } },
  });
  if (rows.length !== uniqueIds.length) {
    throw new AppError('بعض الاستقطاعات غير موجودة', 404, 'NOT_FOUND');
  }

  const blocked = rows.filter((r) => r.state !== DeductionState.draft);
  if (blocked.length) {
    throw new AppError(
      `لا يمكن حذف إلا الاستقطاعات المعلّقة — ${blocked.length} سجل غير معلّق`,
      400,
      'ACTION_ERROR',
    );
  }

  await prisma.deduction.deleteMany({ where: { id: { in: uniqueIds } } });

  const totalAmount = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  await writeAudit({
    req,
    module: 'deductions',
    action: 'deductions.delete_bulk',
    entityType: 'Deduction',
    entityId: '',
    summary: `حذف ${rows.length} استقطاع معلّق — إجمالي ${totalAmount.toFixed(2)}`,
    counts: { deleted: rows.length, totalAmount },
    diffPreview: rows.slice(0, 200).map((r) => ({
      entityId: r.employee?.code ?? r.employeeId,
      entityLabel: r.employee?.name ?? r.employeeId,
      field: 'amount',
      before: r.amount,
      after: null,
      note: [r.reference, r.type].filter(Boolean).join(' · '),
    })),
    payload: {
      ids: uniqueIds,
      deleted: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        type: r.type,
        amount: r.amount,
        employeeCode: r.employee?.code,
        employeeName: r.employee?.name,
        date: r.date,
      })),
    },
    route: '/deductions/delete-bulk',
  });

  jsonRpcSuccess(
    res,
    biotimeOk({
      deleted: rows.length,
      totalAmount,
      message: `تم حذف ${rows.length} استقطاع معلّق`,
    }),
    req.rpcId,
  );
}));

router.post('/deductions/export-template', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const base64 = await exportDeductionTemplate({
    deductionType: String(params.deductionType ?? params.type ?? 'manual_debit'),
    deviceId: params.deviceId ? String(params.deviceId) : null,
    date: params.date ? String(params.date) : undefined,
  });
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, 'deduction_template.xlsx')), req.rpcId);
}));

router.post('/deductions/import-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const file = String(params.file ?? params.base64 ?? '');
  if (!file.trim()) throw new AppError('ارفع ملف Excel', 400, 'VALIDATION_ERROR');
  const result = await importDeductionXlsx({
    base64: file,
    deductionType: String(params.deductionType ?? params.type ?? 'manual_debit'),
    deviceId: params.deviceId ? String(params.deviceId) : null,
    date: params.date ? String(params.date) : undefined,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/deductions/export-multi-template', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const base64 = await exportDeductionMultiTemplate({
    deviceId: params.deviceId ? String(params.deviceId) : null,
    date: params.date ? String(params.date) : undefined,
  });
  jsonRpcSuccess(res, biotimeOk(exportFileResponse(base64, 'deductions_multi_template.xlsx')), req.rpcId);
}));

export default router;
