import { Request, Response, NextFunction, RequestHandler } from 'express';
import { UserRole } from '@prisma/client';
import { runWithTenant, type TenantStore } from '../tenant/context';

type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function tenantStoreForRequest(req: Request): TenantStore | null {
  const u = req.user;
  if (!u) return null;
  const companyId = u.activeCompanyId ?? u.companyId ?? null;
  return {
    companyId,
    isImpersonatingCompany: u.role === UserRole.PLATFORM_ADMIN && Boolean(companyId),
    actorUserId: u.id,
  };
}

export function asyncHandler(fn: AsyncFn): RequestHandler {
  return (req, res, next) => {
    const store = tenantStoreForRequest(req);
    if (store) {
      runWithTenant(store, () => fn(req, res, next)).catch(next);
      return;
    }
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
