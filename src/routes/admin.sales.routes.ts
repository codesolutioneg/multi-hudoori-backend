import { Router } from 'express';
import { SalesRequestStatus, SubscriptionPlanStatus } from '@prisma/client';
import { asyncHandler } from '../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../middlewares/jsonRpc';
import { requireAuth, requirePlatformAdmin } from '../middlewares/auth';
import {
  approveSalesRequest,
  getSalesRequest,
  listSalesRequests,
  rejectSalesRequest,
  updateSalesRequest,
} from '../services/salesRequest.service';
import {
  createPlan,
  listAllPlans,
  setPlanStatus,
  updatePlan,
} from '../services/subscriptionPlan.service';
import { listFeatureCatalog } from '../services/featureCatalog';

const router = Router();

function params(req: { rpcParams?: Record<string, unknown> }) {
  return req.rpcParams ?? {};
}

function errPayload(err: unknown): { message: string; code: string } {
  const e = err as { message?: string; errorCode?: string };
  return { message: e?.message ?? 'Error', code: e?.errorCode ?? 'SERVER_ERROR' };
}

router.post(
  '/sales-requests/list',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const statusRaw = String(params(req).status ?? '').trim().toUpperCase();
    const status =
      statusRaw && Object.values(SalesRequestStatus).includes(statusRaw as SalesRequestStatus)
        ? (statusRaw as SalesRequestStatus)
        : undefined;
    const rows = await listSalesRequests(status);
    jsonRpcSuccess(res, biotimeOk({ requests: rows }), req.rpcId);
  }),
);

router.post(
  '/sales-requests/get',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const id = String(params(req).id ?? '').trim();
    if (!id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    const row = await getSalesRequest(id);
    if (!row) {
      jsonRpcSuccess(res, biotimeFail('Not found', 'NOT_FOUND'), req.rpcId);
      return;
    }
    jsonRpcSuccess(res, biotimeOk({ request: row }), req.rpcId);
  }),
);

router.post(
  '/sales-requests/update',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const id = String(p.id ?? '').trim();
    if (!id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    try {
      const row = await updateSalesRequest(id, {
        companyCode: p.companyCode != null ? String(p.companyCode) : undefined,
        companyName: p.companyName != null ? String(p.companyName) : undefined,
        contactName: p.contactName != null ? String(p.contactName) : undefined,
        email: p.email != null ? String(p.email) : undefined,
        phone: p.phone != null ? String(p.phone) : undefined,
        requestedEmployees:
          p.requestedEmployees != null && p.requestedEmployees !== ''
            ? Number(p.requestedEmployees)
            : undefined,
        planId: p.planId !== undefined ? (p.planId ? String(p.planId) : null) : undefined,
        notes: p.notes !== undefined ? String(p.notes ?? '') : undefined,
      });
      jsonRpcSuccess(res, biotimeOk({ request: row }), req.rpcId);
    } catch (err) {
      const { message, code } = errPayload(err);
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

router.post(
  '/sales-requests/approve',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const id = String(params(req).id ?? '').trim();
    if (!id || !req.user?.id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    try {
      const result = await approveSalesRequest(id, req.user.id);
      jsonRpcSuccess(
        res,
        biotimeOk({
          request: result.request,
          company: result.company,
          mail: result.mail,
        }),
        req.rpcId,
      );
    } catch (err) {
      const { message, code } = errPayload(err);
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

router.post(
  '/sales-requests/reject',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const id = String(params(req).id ?? '').trim();
    const reason = String(params(req).reason ?? '').trim();
    if (!id || !req.user?.id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    try {
      const row = await rejectSalesRequest(id, req.user.id, reason || undefined);
      jsonRpcSuccess(res, biotimeOk({ request: row }), req.rpcId);
    } catch (err) {
      const { message, code } = errPayload(err);
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

router.post(
  '/plans/list',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (_req, res) => {
    const plans = await listAllPlans();
    jsonRpcSuccess(res, biotimeOk({ plans }), _req.rpcId);
  }),
);

router.post(
  '/plans/feature-catalog',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (_req, res) => {
    jsonRpcSuccess(res, biotimeOk({ features: listFeatureCatalog() }), _req.rpcId);
  }),
);

router.post(
  '/plans/create',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    try {
      const plan = await createPlan({
        slug: String(p.slug ?? ''),
        nameAr: String(p.nameAr ?? ''),
        nameEn: String(p.nameEn ?? ''),
        descriptionAr: p.descriptionAr != null ? String(p.descriptionAr) : null,
        descriptionEn: p.descriptionEn != null ? String(p.descriptionEn) : null,
        priceDisplayAr: String(p.priceDisplayAr ?? ''),
        priceDisplayEn: String(p.priceDisplayEn ?? ''),
        featuresAr: p.featuresAr ?? [],
        featuresEn: p.featuresEn ?? [],
        defaultMaxEmployees: p.defaultMaxEmployees != null ? Number(p.defaultMaxEmployees) : null,
        defaultMaxUsers: p.defaultMaxUsers != null ? Number(p.defaultMaxUsers) : null,
        sortOrder: p.sortOrder != null ? Number(p.sortOrder) : 0,
        highlighted: p.highlighted === true || p.highlighted === 'true',
        featureKeys: p.featureKeys ?? [],
        status:
          String(p.status ?? 'DRAFT').toUpperCase() === 'PUBLISHED'
            ? SubscriptionPlanStatus.PUBLISHED
            : SubscriptionPlanStatus.DRAFT,
      });
      jsonRpcSuccess(res, biotimeOk({ plan }), req.rpcId);
    } catch (err) {
      const { message, code } = errPayload(err);
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

router.post(
  '/plans/update',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const id = String(p.id ?? '').trim();
    if (!id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    try {
      const plan = await updatePlan(id, {
        slug: p.slug != null ? String(p.slug) : undefined,
        nameAr: p.nameAr != null ? String(p.nameAr) : undefined,
        nameEn: p.nameEn != null ? String(p.nameEn) : undefined,
        descriptionAr: p.descriptionAr !== undefined ? String(p.descriptionAr ?? '') : undefined,
        descriptionEn: p.descriptionEn !== undefined ? String(p.descriptionEn ?? '') : undefined,
        priceDisplayAr: p.priceDisplayAr != null ? String(p.priceDisplayAr) : undefined,
        priceDisplayEn: p.priceDisplayEn != null ? String(p.priceDisplayEn) : undefined,
        featuresAr: p.featuresAr,
        featuresEn: p.featuresEn,
        defaultMaxEmployees:
          p.defaultMaxEmployees !== undefined
            ? p.defaultMaxEmployees === null || p.defaultMaxEmployees === ''
              ? null
              : Number(p.defaultMaxEmployees)
            : undefined,
        defaultMaxUsers:
          p.defaultMaxUsers !== undefined
            ? p.defaultMaxUsers === null || p.defaultMaxUsers === ''
              ? null
              : Number(p.defaultMaxUsers)
            : undefined,
        sortOrder: p.sortOrder != null ? Number(p.sortOrder) : undefined,
        highlighted: p.highlighted !== undefined ? p.highlighted === true || p.highlighted === 'true' : undefined,
        featureKeys: p.featureKeys !== undefined ? p.featureKeys : undefined,
        status:
          p.status != null
            ? String(p.status).toUpperCase() === 'PUBLISHED'
              ? SubscriptionPlanStatus.PUBLISHED
              : SubscriptionPlanStatus.DRAFT
            : undefined,
      });
      jsonRpcSuccess(res, biotimeOk({ plan }), req.rpcId);
    } catch (err) {
      const { message, code } = errPayload(err);
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

router.post(
  '/plans/set-status',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const id = String(p.id ?? '').trim();
    const status =
      String(p.status ?? '').toUpperCase() === 'PUBLISHED'
        ? SubscriptionPlanStatus.PUBLISHED
        : SubscriptionPlanStatus.DRAFT;
    if (!id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    const plan = await setPlanStatus(id, status);
    jsonRpcSuccess(res, biotimeOk({ plan }), req.rpcId);
  }),
);

export default router;
