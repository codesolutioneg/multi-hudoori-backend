import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import {
  broadcastToCompany,
  listCompanyPushLog,
  listNotificationsForUser,
  markNotificationsRead,
  resolveTargetUserIds,
  sendDirectPush,
  setUserFcmToken,
} from '../../services/appNotification.service';
import { requireCompanyId } from '../../tenant/context';

const router = Router();

router.post('/me/fcm-token', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  const raw = params.fcmToken;
  const fcmToken =
    raw === null || raw === undefined || raw === false
      ? null
      : String(raw).trim() || null;
  await setUserFcmToken(req.user!.id, fcmToken);
  jsonRpcSuccess(res, biotimeOk({ saved: true }), req.rpcId);
}));

router.post('/notifications/list', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  const limit = params.limit != null ? Number(params.limit) : undefined;
  const offset = params.offset != null ? Number(params.offset) : undefined;
  const data = await listNotificationsForUser(req.user!.id, { limit, offset });
  jsonRpcSuccess(res, biotimeOk(data), req.rpcId);
}));

router.post('/notifications/read', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  const ids = Array.isArray(params.ids)
    ? (params.ids as unknown[]).map(String).filter(Boolean)
    : undefined;
  const all = params.all === true || params.all === 'true';
  const data = await markNotificationsRead(req.user!.id, { ids, all });
  jsonRpcSuccess(res, biotimeOk(data), req.rpcId);
}));

router.post('/notifications/broadcast', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const title = String(params.title ?? '').trim();
  const body = String(params.body ?? '').trim();
  const imageUrl = params.imageUrl != null ? String(params.imageUrl).trim() : undefined;
  if (!title || !body) {
    jsonRpcSuccess(res, biotimeFail('title و body مطلوبان', 'VALIDATION'), req.rpcId);
    return;
  }
  const companyId = requireCompanyId();
  const result = await broadcastToCompany({
    companyId,
    title,
    body,
    imageUrl: imageUrl || null,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/notifications/send', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const title = String(params.title ?? '').trim();
  const body = String(params.body ?? '').trim();
  const imageUrl = params.imageUrl != null ? String(params.imageUrl).trim() : undefined;
  if (!title || !body) {
    jsonRpcSuccess(res, biotimeFail('title و body مطلوبان', 'VALIDATION'), req.rpcId);
    return;
  }
  const userIds = Array.isArray(params.userIds)
    ? (params.userIds as unknown[]).map(String).filter(Boolean)
    : [];
  const employeeIds = Array.isArray(params.employeeIds)
    ? (params.employeeIds as unknown[]).map(String).filter(Boolean)
    : [];
  const targets = await resolveTargetUserIds({ userIds, employeeIds });
  if (!targets.length) {
    jsonRpcSuccess(
      res,
      biotimeFail('حدّد مستخدمين أو موظفين مرتبطين بحساب تطبيق', 'VALIDATION'),
      req.rpcId,
    );
    return;
  }
  const companyId = requireCompanyId();
  const result = await sendDirectPush({
    companyId,
    userIds: targets,
    title,
    body,
    imageUrl: imageUrl || null,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/notifications/admin-list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const limit = params.limit != null ? Number(params.limit) : undefined;
  const offset = params.offset != null ? Number(params.offset) : undefined;
  const companyId = requireCompanyId();
  const data = await listCompanyPushLog(companyId, { limit, offset });
  jsonRpcSuccess(res, biotimeOk(data), req.rpcId);
}));

export default router;
