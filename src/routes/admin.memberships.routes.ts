import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { asyncHandler } from '../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../middlewares/jsonRpc';
import { requireAuth, requirePlatformAdmin } from '../middlewares/auth';
import {
  addMembership,
  listMembershipsForAdmin,
  removeMembership,
} from '../services/companyMembership.service';

const router = Router();

function params(req: { rpcParams?: Record<string, unknown> }) {
  return req.rpcParams ?? {};
}

router.post(
  '/memberships/list',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const userId = String(params(req).userId ?? params(req).id ?? '').trim();
    if (!userId) {
      jsonRpcSuccess(res, biotimeFail('userId is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    try {
      const memberships = await listMembershipsForAdmin(userId);
      jsonRpcSuccess(res, biotimeOk({ memberships, count: memberships.length }), req.rpcId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error';
      const code =
        e && typeof e === 'object' && 'errorCode' in e
          ? String((e as { errorCode: string }).errorCode)
          : 'SERVER_ERROR';
      jsonRpcSuccess(res, biotimeFail(msg, code), req.rpcId);
    }
  }),
);

router.post(
  '/memberships/add',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const userId = String(p.userId ?? '').trim();
    const companyId = String(p.companyId ?? '').trim();
    const roleRaw = p.role != null ? String(p.role).toUpperCase() : null;
    const role =
      roleRaw && Object.values(UserRole).includes(roleRaw as UserRole)
        ? (roleRaw as UserRole)
        : undefined;
    if (!userId || !companyId) {
      jsonRpcSuccess(res, biotimeFail('userId and companyId are required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    try {
      const membership = await addMembership({ userId, companyId, role });
      jsonRpcSuccess(res, biotimeOk({ membership }), req.rpcId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error';
      const code =
        e && typeof e === 'object' && 'errorCode' in e
          ? String((e as { errorCode: string }).errorCode)
          : 'SERVER_ERROR';
      jsonRpcSuccess(res, biotimeFail(msg, code), req.rpcId);
    }
  }),
);

router.post(
  '/memberships/remove',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const userId = String(p.userId ?? '').trim();
    const companyId = String(p.companyId ?? '').trim();
    if (!userId || !companyId) {
      jsonRpcSuccess(res, biotimeFail('userId and companyId are required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    try {
      await removeMembership(userId, companyId);
      jsonRpcSuccess(res, biotimeOk({ message: 'Membership removed' }), req.rpcId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error';
      const code =
        e && typeof e === 'object' && 'errorCode' in e
          ? String((e as { errorCode: string }).errorCode)
          : 'SERVER_ERROR';
      jsonRpcSuccess(res, biotimeFail(msg, code), req.rpcId);
    }
  }),
);

export default router;
