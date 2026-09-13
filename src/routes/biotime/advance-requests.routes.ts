/**
 * «طلب سلفة» — the employee-facing advance request and its two approval steps.
 *
 * Unlike the other request types, EMPLOYEE accounts may write here: filing an
 * advance request is the whole point of the screen. Every other guard is layered
 * inside the service, which knows the branch scope of each request.
 */
import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth } from '../../middlewares/auth';
import { p } from './route-helpers';
import { writeAudit } from '../../services/auditLog.service';
import { AppError } from '../../utils/errors';
import { advanceEligibilityJson } from '../../services/advanceEligibility.service';
import {
  advanceRequestJson,
  branchApproveAdvanceRequest,
  cancelAdvanceRequest,
  createAdvanceRequest,
  employeeForUser,
  getRequestEligibility,
  hrApproveAdvanceRequest,
  listAdvanceRequestQueue,
  listMyAdvanceRequests,
  rejectAdvanceRequest,
  type Actor,
} from '../../services/advanceRequest.service';

const router = Router();

function actorOf(req: { user?: { id: string; role: UserRole; locationId?: string | null } }): Actor {
  return {
    id: req.user!.id,
    role: req.user!.role,
    locationId: req.user!.locationId ?? null,
  };
}

/** Turns business errors into the JSON-RPC failure shape the dashboard reads. */
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

router.post('/advance-requests/eligibility', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  await guard(res, req.rpcId, async () => {
    const actor = actorOf(req);
    let employeeId = params.employeeId != null ? String(params.employeeId) : null;

    // Employees may only ever see their own entitlement, whatever they ask for.
    if (!employeeId || actor.role === UserRole.EMPLOYEE) {
      employeeId = (await employeeForUser(actor.id)).id;
    }
    const eligibility = await getRequestEligibility(
      employeeId,
      params.excludeRequestId != null ? String(params.excludeRequestId) : null,
    );
    jsonRpcSuccess(res, biotimeOk(advanceEligibilityJson(eligibility)), req.rpcId);
  });
}));

router.post('/advance-requests/create', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  await guard(res, req.rpcId, async () => {
    const request = await createAdvanceRequest(actorOf(req), {
      employeeId: params.employeeId != null ? String(params.employeeId) : null,
      amount: Number(params.amount),
      reason: String(params.reason ?? ''),
    });
    await writeAudit({
      req,
      module: 'advances',
      action: 'advance_request.create',
      entityType: 'AdvanceRequest',
      entityId: request.id,
      summary: `طلب سلفة ${request.amount} لـ ${request.employee?.name ?? request.employeeId}`,
    });
    jsonRpcSuccess(res, biotimeOk(advanceRequestJson(request)), req.rpcId);
  });
}));

router.post('/advance-requests/my', requireAuth, asyncHandler(async (req, res) => {
  await guard(res, req.rpcId, async () => {
    const rows = await listMyAdvanceRequests(req.user!.id);
    jsonRpcSuccess(res, biotimeOk({ requests: rows.map(advanceRequestJson) }), req.rpcId);
  });
}));

router.post('/advance-requests/list', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  await guard(res, req.rpcId, async () => {
    const rows = await listAdvanceRequestQueue(actorOf(req), {
      state: params.state != null ? String(params.state) : null,
      locationId: params.locationId != null ? String(params.locationId) : null,
    });
    jsonRpcSuccess(res, biotimeOk({ requests: rows.map(advanceRequestJson) }), req.rpcId);
  });
}));

router.post('/advance-requests/branch-approve', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  await guard(res, req.rpcId, async () => {
    const request = await branchApproveAdvanceRequest(actorOf(req), String(params.id ?? ''));
    await writeAudit({
      req,
      module: 'advances',
      action: 'advance_request.branch_approve',
      entityType: 'AdvanceRequest',
      entityId: request.id,
      summary: `موافقة الفرع على سلفة ${request.amount} لـ ${request.employee?.name ?? request.employeeId}`,
    });
    jsonRpcSuccess(res, biotimeOk(advanceRequestJson(request)), req.rpcId);
  });
}));

router.post('/advance-requests/approve', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  await guard(res, req.rpcId, async () => {
    const request = await hrApproveAdvanceRequest(actorOf(req), {
      id: String(params.id ?? ''),
      amount: params.amount != null ? Number(params.amount) : null,
      limitOverride: params.limitOverride === true,
      overrideReason: params.overrideReason != null ? String(params.overrideReason) : null,
    });
    await writeAudit({
      req,
      module: 'advances',
      action: 'advance_request.approve',
      entityType: 'AdvanceRequest',
      entityId: request.id,
      summary: `اعتماد سلفة ${request.amount} لـ ${request.employee?.name ?? request.employeeId}`,
    });
    jsonRpcSuccess(res, biotimeOk(advanceRequestJson(request)), req.rpcId);
  });
}));

router.post('/advance-requests/reject', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  await guard(res, req.rpcId, async () => {
    const request = await rejectAdvanceRequest(
      actorOf(req),
      String(params.id ?? ''),
      String(params.reason ?? ''),
    );
    await writeAudit({
      req,
      module: 'advances',
      action: 'advance_request.reject',
      entityType: 'AdvanceRequest',
      entityId: request.id,
      summary: `رفض طلب سلفة لـ ${request.employee?.name ?? request.employeeId}`,
    });
    jsonRpcSuccess(res, biotimeOk(advanceRequestJson(request)), req.rpcId);
  });
}));

router.post('/advance-requests/cancel', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  await guard(res, req.rpcId, async () => {
    const request = await cancelAdvanceRequest(actorOf(req), String(params.id ?? ''));
    await writeAudit({
      req,
      module: 'advances',
      action: 'advance_request.cancel',
      entityType: 'AdvanceRequest',
      entityId: request.id,
      summary: `إلغاء طلب سلفة لـ ${request.employee?.name ?? request.employeeId}`,
    });
    jsonRpcSuccess(res, biotimeOk(advanceRequestJson(request)), req.rpcId);
  });
}));

export default router;
