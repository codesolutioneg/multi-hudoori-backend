import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../middlewares/jsonRpc';
import { requireAuth, requirePlatformAdmin } from '../middlewares/auth';
import * as companyService from '../services/company.service';

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
  '/companies/create',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    try {
      const result = await companyService.createCompany({
        code: String(p.code ?? ''),
        name: String(p.name ?? ''),
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
    try {
      const company = await companyService.updateCompany(id, {
        name: p.name != null ? String(p.name) : undefined,
        active: p.active != null ? Boolean(p.active) : undefined,
      });
      jsonRpcSuccess(res, biotimeOk({ company }), req.rpcId);
    } catch {
      jsonRpcSuccess(res, biotimeFail('Company not found', 'NOT_FOUND'), req.rpcId);
    }
  }),
);

export default router;
