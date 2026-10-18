/**
 * Field mission requests — employee create + branch-manager approve (final).
 */
import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth } from '../../middlewares/auth';
import { p } from './route-helpers';
import { writeAudit } from '../../services/auditLog.service';
import { AppError } from '../../utils/errors';
import {
  branchApproveFieldMissionRequest,
  cancelFieldMissionRequest,
  createFieldMissionRequest,
  fieldMissionRequestJson,
  listFieldMissionRequestQueue,
  listMyFieldMissionRequests,
  rejectFieldMissionRequest,
  type Actor,
} from '../../services/fieldMissionRequest.service';

const router = Router();

function actorOf(req: {
  user?: { id: string; role: UserRole; locationId?: string | null };
}): Actor {
  return {
    id: req.user!.id,
    role: req.user!.role,
    locationId: req.user!.locationId ?? null,
  };
}

async function guard(
  res: Parameters<typeof jsonRpcSuccess>[0],
  rpcId: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError) {
      jsonRpcSuccess(res, biotimeFail(err.message, err.errorCode), rpcId as never);
      return;
    }
    throw err;
  }
}

router.post(
  '/field-mission-requests/create',
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = p(req);
    await guard(res, req.rpcId, async () => {
      const request = await createFieldMissionRequest(actorOf(req), {
        employeeId: params.employeeId != null ? String(params.employeeId) : null,
        details: String(params.details ?? ''),
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      });
      await writeAudit({
        req,
        module: 'attendance',
        action: 'field_mission.create',
        entityType: 'FieldMissionRequest',
        entityId: request.id,
        summary: `طلب مأمورية لـ ${request.employee?.name ?? request.employeeId}`,
      });
      jsonRpcSuccess(res, biotimeOk(fieldMissionRequestJson(request)), req.rpcId);
    });
  }),
);

router.post(
  '/field-mission-requests/my',
  requireAuth,
  asyncHandler(async (req, res) => {
    await guard(res, req.rpcId, async () => {
      const rows = await listMyFieldMissionRequests(req.user!.id);
      jsonRpcSuccess(
        res,
        biotimeOk({ requests: rows.map(fieldMissionRequestJson) }),
        req.rpcId,
      );
    });
  }),
);

router.post(
  '/field-mission-requests/list',
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = p(req);
    await guard(res, req.rpcId, async () => {
      const rows = await listFieldMissionRequestQueue(actorOf(req), {
        state: params.state != null ? String(params.state) : null,
        locationId: params.locationId != null ? String(params.locationId) : null,
      });
      jsonRpcSuccess(
        res,
        biotimeOk({ requests: rows.map(fieldMissionRequestJson) }),
        req.rpcId,
      );
    });
  }),
);

router.post(
  '/field-mission-requests/branch-approve',
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = p(req);
    await guard(res, req.rpcId, async () => {
      const request = await branchApproveFieldMissionRequest(
        actorOf(req),
        String(params.id ?? ''),
      );
      await writeAudit({
        req,
        module: 'attendance',
        action: 'field_mission.branch_approve',
        entityType: 'FieldMissionRequest',
        entityId: request.id,
        summary: `اعتماد مأمورية: ${request.employee?.name ?? request.employeeId}`,
      });
      jsonRpcSuccess(res, biotimeOk(fieldMissionRequestJson(request)), req.rpcId);
    });
  }),
);

router.post(
  '/field-mission-requests/reject',
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = p(req);
    await guard(res, req.rpcId, async () => {
      const request = await rejectFieldMissionRequest(
        actorOf(req),
        String(params.id ?? ''),
        String(params.reason ?? ''),
      );
      await writeAudit({
        req,
        module: 'attendance',
        action: 'field_mission.reject',
        entityType: 'FieldMissionRequest',
        entityId: request.id,
        summary: `رفض مأمورية: ${request.employee?.name ?? request.employeeId}`,
      });
      jsonRpcSuccess(res, biotimeOk(fieldMissionRequestJson(request)), req.rpcId);
    });
  }),
);

router.post(
  '/field-mission-requests/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = p(req);
    await guard(res, req.rpcId, async () => {
      const request = await cancelFieldMissionRequest(
        actorOf(req),
        String(params.id ?? ''),
      );
      await writeAudit({
        req,
        module: 'attendance',
        action: 'field_mission.cancel',
        entityType: 'FieldMissionRequest',
        entityId: request.id,
        summary: `إلغاء مأمورية: ${request.id}`,
      });
      jsonRpcSuccess(res, biotimeOk(fieldMissionRequestJson(request)), req.rpcId);
    });
  }),
);

export default router;
