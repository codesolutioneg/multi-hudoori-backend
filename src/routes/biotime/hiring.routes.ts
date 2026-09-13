import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrOrBranchManager, isBranchManagerUser } from '../../middlewares/auth';
import { p } from './route-helpers';
import { AdvanceState, DeductionState, PayrollState, ShiftGridState, HiringAppointmentStatus, UserRole } from '@prisma/client';
import { applyHiringAppointmentWebhook, countUnreadHiringUpdates, countPendingHiringAppointments, createHiringAppointment, getHiringAppointmentPdfBase64, hiringAppointmentJson, listHiringAppointments, markHiringAppointmentsSeen, parseCreateHiringAppointmentParams, parseHiringAppointmentWebhookParams, parseUpdateHiringAppointmentParams, updateHiringAppointment, } from '../../services/hiringAppointment.service';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { config } from '../../config';
import { hiringProvisionJson, provisionEmployeeFromHiringAppointment } from '../../services/hiringAppointmentProvision.service';
import { parsePagination, paginationMeta } from '../../utils/pagination';
import { prisma } from '../../prisma/client';
import { writeAudit } from '../../services/auditLog.service';

const router = Router();

router.post('/hiring-appointments/list', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const { limit, offset } = parsePagination(params, { limit: 50, maxLimit: 100 });
  const hrScope = await getHrLocationScopeFromReq(req);
  const result = await listHiringAppointments({ locationId: hrScope, limit, offset });
  jsonRpcSuccess(res, biotimeOk({
    appointments: result.items.map(hiringAppointmentJson),
    ...paginationMeta(result.total, limit, offset, result.items.length),
  }), req.rpcId);
}));

router.post('/hiring-appointments/unread-count', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const hrScope = await getHrLocationScopeFromReq(req);
  const count = isBranchManagerUser(req)
    ? await countPendingHiringAppointments(hrScope)
    : await countUnreadHiringUpdates(hrScope);
  jsonRpcSuccess(res, biotimeOk({ count }), req.rpcId);
}));

router.post('/hiring-appointments/mark-seen', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const hrScope = await getHrLocationScopeFromReq(req);
  await markHiringAppointmentsSeen(hrScope);
  jsonRpcSuccess(res, biotimeOk({ message: 'تم التحديث' }), req.rpcId);
}));

router.post('/hiring-appointments/create', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const input = parseCreateHiringAppointmentParams(params, req.user!.id);
  const hrScope = await getHrLocationScopeFromReq(req);
  if (hrScope) input.locationId = hrScope;
  const created = await createHiringAppointment(input);
  if (created.kind === 'existing_appointment') {
    const codeLabel = created.appointment.fingerprintCode || input.fingerprintCode;
    jsonRpcSuccess(
      res,
      biotimeFail(
        `الكود ${codeLabel} موجود بالفعل في التعيينات ومينفعش تعمل تعيين جديد بنفس الكود.`,
        'EXISTING_APPOINTMENT',
        { data: { existingAppointment: created.appointment } },
      ),
      req.rpcId,
    );
    return;
  }
  if (created.kind === 'existing') {
    const codeLabel = created.employee.code || input.fingerprintCode;
    const message = created.employee.matchBy === 'nationalId'
      ? 'رقم البطاقة موجود على موظف قديم ومينفعش تضيف تعيين جديد بنفس الرقم.'
      : `الكود ${codeLabel} موجود على موظف ومينفعش تضيف تعيين جديد بنفس الكود.`;
    jsonRpcSuccess(
      res,
      biotimeFail(message, 'EXISTING_EMPLOYEE', { data: { existingEmployee: created.employee } }),
      req.rpcId,
    );
    return;
  }
  const appt = created.appointment;
  await writeAudit({
    req,
    module: 'hiring',
    action: 'hiring.create',
    entityType: 'HiringAppointment',
    entityId: appt.id,
    summary: `إنشاء تعيين: ${appt.employeeName}`,
    payload: {
      employeeName: appt.employeeName,
      fingerprintCode: appt.fingerprintCode,
      jobTitle: appt.jobTitle,
      nationalId: appt.nationalId,
      locationId: appt.locationId,
      status: appt.status,
    },
    diffPreview: [
      { field: 'name', after: appt.employeeName, entityLabel: appt.employeeName },
      { field: 'identificationId', after: appt.fingerprintCode, entityLabel: appt.employeeName },
      { field: 'jobTitle', after: appt.jobTitle, entityLabel: appt.employeeName },
    ],
    route: '/hiring-appointments/create',
  });
  jsonRpcSuccess(res, biotimeOk({
    appointment: hiringAppointmentJson(created.appointment),
    message: 'تم إنشاء التعيين وتوليد PDF',
  }), req.rpcId);
}));

router.post('/hiring-appointments/update', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const scope = await getHrLocationScopeFromReq(req);
  const params = { ...p(req) };
  if (isBranchManagerUser(req)) {
    delete params.locationId;
  }
  const input = parseUpdateHiringAppointmentParams(params, scope);
  if (
    input.status === HiringAppointmentStatus.approved
    || input.status === HiringAppointmentStatus.rejected
    || input.status === HiringAppointmentStatus.cancelled
  ) {
    input.approvedByName = req.user!.name;
  }
  const row = await updateHiringAppointment(input);
  const provision = await provisionEmployeeFromHiringAppointment(row);
  let message = 'تم تحديث التعيين';
  let auditAction = 'hiring.update';
  if (input.status === HiringAppointmentStatus.approved) {
    message = 'تمت الموافقة';
    auditAction = 'hiring.approve';
    if (provision?.created) {
      message = `${message} — تم إنشاء الموظف في قائمة الموظفين`;
    } else if (provision && !provision.created) {
      message = `${message} — الموظف موجود مسبقاً`;
    }
  } else if (input.status === HiringAppointmentStatus.rejected) {
    message = 'تم الرفض';
    auditAction = 'hiring.reject';
  } else if (input.status === HiringAppointmentStatus.cancelled) {
    message = 'تم الإلغاء';
    auditAction = 'hiring.cancel';
  } else if (input.status === HiringAppointmentStatus.pending) {
    message = 'تم إعادة إرسال الطلب';
  }
  await writeAudit({
    req,
    module: 'hiring',
    action: auditAction,
    entityType: 'HiringAppointment',
    entityId: row.id,
    summary: `${message}: ${row.employeeName}`,
    payload: {
      employeeName: row.employeeName,
      fingerprintCode: row.fingerprintCode,
      jobTitle: row.jobTitle,
      status: row.status,
      previousStatus: input.status ?? null,
      employeeProfileId: row.employeeProfileId,
      provisionCreated: provision?.created ?? false,
    },
    diffPreview: [
      {
        field: 'state',
        after: row.status,
        entityLabel: row.employeeName,
        note: message,
      },
      {
        field: 'identificationId',
        after: row.fingerprintCode,
        entityLabel: row.employeeName,
      },
      ...(provision?.employeeId
        ? [{
            field: 'name',
            after: row.employeeName,
            note: provision.created ? 'تم إنشاء موظف من التعيين' : 'ربط بموظف موجود',
            entityId: provision.employeeId,
            entityLabel: row.employeeName,
          }]
        : []),
    ],
    route: '/hiring-appointments/update',
  });
  jsonRpcSuccess(res, biotimeOk({
    appointment: hiringAppointmentJson(row),
    employee: hiringProvisionJson(provision),
    message,
  }), req.rpcId);
}));

router.post('/hiring-appointments/pdf', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).appointmentId ?? '');
  const hrScope = await getHrLocationScopeFromReq(req);
  const row = await prisma.hiringAppointment.findUnique({ where: { id } });
  if (!row) {
    jsonRpcSuccess(res, biotimeFail('Appointment not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  if (hrScope && row.locationId !== hrScope) {
    jsonRpcSuccess(res, biotimeFail('Access denied', 'ACCESS_DENIED'), req.rpcId);
    return;
  }
  const file = await getHiringAppointmentPdfBase64(id);
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

router.post('/hiring-appointments/webhook/status', asyncHandler(async (req, res) => {
  const secret = String(req.headers['x-hiring-webhook-secret'] ?? p(req).secret ?? '');
  if (!config.hiringWebhookSecret || secret !== config.hiringWebhookSecret) {
    jsonRpcSuccess(res, biotimeFail('Unauthorized', 'UNAUTHORIZED'), req.rpcId);
    return;
  }
  const params = p(req);
  const webhookInput = parseHiringAppointmentWebhookParams(params);
  const { appointment: row, provision } = await applyHiringAppointmentWebhook(webhookInput);
  const approved = row.status === 'approved';
  const rejected = row.status === 'rejected';
  let message = approved ? 'تمت الموافقة' : rejected ? 'تم الرفض' : 'تم التحديث';
  if (provision?.created) {
    message = `${message} — تم إنشاء الموظف في قائمة الموظفين`;
  } else if (provision && !provision.created) {
    message = `${message} — الموظف موجود مسبقاً`;
  }
  jsonRpcSuccess(res, biotimeOk({
    appointment: hiringAppointmentJson(row),
    employee: hiringProvisionJson(provision),
    message,
  }), req.rpcId);
}));

export default router;

