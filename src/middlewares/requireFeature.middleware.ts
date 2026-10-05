import { UserRole } from '@prisma/client';
import type { Request, Response, NextFunction } from 'express';
import { getCompanyId } from '../tenant/context';
import { isFeatureEnabled } from '../services/companyEntitlements.service';
import { ROUTE_FEATURE_PREFIXES } from '../services/featureCatalog';

export function featureForPath(path: string): string | null {
  const p = path.toLowerCase();
  for (const { prefix, feature } of ROUTE_FEATURE_PREFIXES) {
    if (p.includes(prefix)) return feature;
  }
  return null;
}

/** Block tenant API when company entitlement is off. Platform admin bypasses. */
export async function requireFeatureMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.user?.role === UserRole.PLATFORM_ADMIN) {
      next();
      return;
    }
    const companyId = getCompanyId();
    if (!companyId) {
      next();
      return;
    }
    const pathForFeature = `${req.baseUrl ?? ''}${req.path ?? ''}`.toLowerCase();
    const feat = featureForPath(pathForFeature);
    if (!feat) {
      next();
      return;
    }
    const ok = await isFeatureEnabled(companyId, feat);
    if (!ok) {
      res.status(403).json({
        success: false,
        message: 'هذه الميزة غير مفعّلة في باقة اشتراك شركتك.',
        error_code: 'FEATURE_DISABLED',
      });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
