import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth } from '../../middlewares/auth';
import { p } from './route-helpers';
import {
  getMobilePunchContext,
  submitMobilePunch,
} from '../../services/mobileLocationPunch.service';
import { AppError } from '../../utils/errors';

const router = Router();

function requireEmployeeUser(req: { user?: { id: string; role: UserRole } }): string {
  if (!req.user) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  // Any authenticated company user with an employee profile can punch;
  // service resolves the profile. Platform admin cannot punch.
  if (req.user.role === UserRole.PLATFORM_ADMIN) {
    throw new AppError('Platform admin cannot punch', 403, 'ACCESS_DENIED');
  }
  return req.user.id;
}

function parseCoords(params: Record<string, unknown>): { latitude: number; longitude: number } | null {
  const latitude = Number(params.latitude);
  const longitude = Number(params.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function parseClientPunchAt(raw: unknown): Date | null {
  if (raw == null || raw === '') return null;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

router.post(
  '/mobile-punch/context',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const userId = requireEmployeeUser(req);
      const context = await getMobilePunchContext(userId);
      jsonRpcSuccess(res, biotimeOk(context), req.rpcId);
    } catch (e: unknown) {
      const err = e as { message?: string; errorCode?: string };
      jsonRpcSuccess(
        res,
        biotimeFail(err.message ?? 'Failed', err.errorCode ?? 'ERROR'),
        req.rpcId,
      );
    }
  }),
);

router.post(
  '/mobile-punch/check-in',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const userId = requireEmployeeUser(req);
      const coords = parseCoords(p(req));
      if (!coords) {
        jsonRpcSuccess(res, biotimeFail('GPS coordinates are required', 'GPS_REQUIRED'), req.rpcId);
        return;
      }
      const result = await submitMobilePunch({
        userId,
        isCheckIn: true,
        latitude: coords.latitude,
        longitude: coords.longitude,
        clientPunchAt: parseClientPunchAt(p(req).clientPunchAt ?? p(req).punchTime),
      });
      jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
    } catch (e: unknown) {
      const err = e as { message?: string; errorCode?: string };
      jsonRpcSuccess(
        res,
        biotimeFail(err.message ?? 'Failed', err.errorCode ?? 'ERROR'),
        req.rpcId,
      );
    }
  }),
);

router.post(
  '/mobile-punch/check-out',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const userId = requireEmployeeUser(req);
      const coords = parseCoords(p(req));
      if (!coords) {
        jsonRpcSuccess(res, biotimeFail('GPS coordinates are required', 'GPS_REQUIRED'), req.rpcId);
        return;
      }
      const result = await submitMobilePunch({
        userId,
        isCheckIn: false,
        latitude: coords.latitude,
        longitude: coords.longitude,
        clientPunchAt: parseClientPunchAt(p(req).clientPunchAt ?? p(req).punchTime),
      });
      jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
    } catch (e: unknown) {
      const err = e as { message?: string; errorCode?: string };
      jsonRpcSuccess(
        res,
        biotimeFail(err.message ?? 'Failed', err.errorCode ?? 'ERROR'),
        req.rpcId,
      );
    }
  }),
);

export default router;
