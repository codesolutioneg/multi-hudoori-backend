import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../middlewares/jsonRpc';
import { requireAuth, requirePlatformAdmin } from '../middlewares/auth';
import * as companyService from '../services/company.service';
import {
  listCompanyFeaturesForAdmin,
  setCompanyFeaturesFromAdmin,
} from '../services/companyEntitlements.service';

const router = Router();

function params(req: { rpcParams?: Record<string, unknown> }) {
  return req.rpcParams ?? {};
}

router.post(
  '/companies/list',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const rows = await companyService.listCompanies();
    jsonRpcSuccess(res, biotimeOk({ companies: rows }), req.rpcId);
  }),
);

router.post(
  '/companies/get',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const id = String(params(req).id ?? '').trim();
    if (!id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    const company = await companyService.getCompany(id);
    if (!company) {
      jsonRpcSuccess(res, biotimeFail('Company not found', 'NOT_FOUND'), req.rpcId);
      return;
    }
    jsonRpcSuccess(res, biotimeOk({ company }), req.rpcId);
  }),
);

router.post(
  '/companies/stats',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const id = String(params(req).id ?? '').trim();
    if (!id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    const stats = await companyService.getCompanyStats(id);
    if (!stats) {
      jsonRpcSuccess(res, biotimeFail('Company not found', 'NOT_FOUND'), req.rpcId);
      return;
    }
    jsonRpcSuccess(res, biotimeOk({ stats }), req.rpcId);
  }),
);

router.post(
  '/companies/create',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    try {
      const maxEmployees = companyService.parseQuota(p.maxEmployees, 'Max employees');
      const maxUsers = companyService.parseQuota(p.maxUsers, 'Max users');
      if (maxEmployees == null || maxUsers == null) {
        jsonRpcSuccess(
          res,
          biotimeFail('Max employees and max users are required', 'VALIDATION_ERROR'),
          req.rpcId,
        );
        return;
      }
      const result = await companyService.createCompany({
        code: String(p.code ?? ''),
        name: String(p.name ?? ''),
        maxEmployees,
        maxUsers,
        hrManagerName: p.hrManagerName != null ? String(p.hrManagerName) : undefined,
        hrManagerLogin: p.hrManagerLogin != null ? String(p.hrManagerLogin) : undefined,
        hrManagerPassword: p.hrManagerPassword != null ? String(p.hrManagerPassword) : undefined,
      });
      jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Create failed';
      const code =
        e && typeof e === 'object' && 'errorCode' in e
          ? String((e as { errorCode: string }).errorCode)
          : 'ERROR';
      jsonRpcSuccess(res, biotimeFail(msg, code), req.rpcId);
    }
  }),
);

router.post(
  '/companies/update',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const id = String(p.id ?? '').trim();
    if (!id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    let maxEmployees: number | null | undefined;
    let maxUsers: number | null | undefined;
    try {
      // Key present with null/'' = unlimited; key absent = unchanged.
      if ('maxEmployees' in p) maxEmployees = companyService.parseQuota(p.maxEmployees, 'Max employees');
      if ('maxUsers' in p) maxUsers = companyService.parseQuota(p.maxUsers, 'Max users');
    } catch (e: unknown) {
      jsonRpcSuccess(
        res,
        biotimeFail(e instanceof Error ? e.message : 'Invalid quota', 'VALIDATION_ERROR'),
        req.rpcId,
      );
      return;
    }
    try {
      await companyService.updateCompany(id, {
        name: p.name != null ? String(p.name) : undefined,
        active: p.active != null ? Boolean(p.active) : undefined,
        maxEmployees,
        maxUsers,
      });
      const company = await companyService.getCompany(id);
      jsonRpcSuccess(res, biotimeOk({ company }), req.rpcId);
    } catch {
      jsonRpcSuccess(res, biotimeFail('Company not found', 'NOT_FOUND'), req.rpcId);
    }
  }),
);

router.post(
  '/companies/features/get',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const id = String(params(req).id ?? '').trim();
    if (!id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    const company = await companyService.getCompany(id);
    if (!company) {
      jsonRpcSuccess(res, biotimeFail('Company not found', 'NOT_FOUND'), req.rpcId);
      return;
    }
    const features = await listCompanyFeaturesForAdmin(id);
    jsonRpcSuccess(res, biotimeOk({ company, features }), req.rpcId);
  }),
);

router.post(
  '/companies/features/update',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const id = String(p.id ?? '').trim();
    if (!id) {
      jsonRpcSuccess(res, biotimeFail('id is required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    const raw = p.features;
    const toggles = Array.isArray(raw)
      ? raw.map((item) => {
          const o = item as Record<string, unknown>;
          return { key: String(o.key ?? ''), enabled: o.enabled === true || o.enabled === 'true' };
        })
      : [];
    await setCompanyFeaturesFromAdmin(id, toggles);
    const features = await listCompanyFeaturesForAdmin(id);
    jsonRpcSuccess(res, biotimeOk({ features }), req.rpcId);
  }),
);

export default router;
