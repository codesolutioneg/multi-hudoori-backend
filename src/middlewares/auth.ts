import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { PLATFORM_ADMIN_LOCAL_TOKEN, PLATFORM_ADMIN_LOGIN } from '../config';
import { prismaBase } from '../prisma/client';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { asyncHandler } from './asyncHandler';
import { extractRequestToken } from '../utils/requestToken';
import { enterTenant } from '../tenant/context';

function extractActiveCompanyId(req: Request): string | null {
  const p = req.rpcParams ?? {};
  const fromParams = p.activeCompanyId ?? p.active_company_id ?? p.companyId ?? p.company_id;
  if (fromParams != null && String(fromParams).trim() !== '') {
    return String(fromParams).trim();
  }
  const header = req.headers['x-company-id'];
  if (typeof header === 'string' && header.trim() !== '') return header.trim();
  return null;
}

export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const token = extractRequestToken(req);
  if (!token) throw new UnauthorizedError('Authentication token is required', 'MISSING_TOKEN');

  if (token === PLATFORM_ADMIN_LOCAL_TOKEN) {
    const activeCompanyId = extractActiveCompanyId(req);
    req.user = {
      id: 'platform-admin',
      login: PLATFORM_ADMIN_LOGIN,
      name: 'Platform Admin',
      role: UserRole.PLATFORM_ADMIN,
      email: PLATFORM_ADMIN_LOGIN,
      companyId: null,
      activeCompanyId,
    };
    enterTenant({
      companyId: activeCompanyId,
      isImpersonatingCompany: Boolean(activeCompanyId),
      actorUserId: 'platform-admin',
    });
    next();
    return;
  }

  const apiToken = await prismaBase.apiToken.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!apiToken || apiToken.expiryDate < new Date() || !apiToken.user.active) {
    throw new UnauthorizedError('Invalid or expired token', 'INVALID_TOKEN');
  }

  const user = apiToken.user;
  const isPlatformAdmin = user.role === UserRole.PLATFORM_ADMIN;
  const activeCompanyId = isPlatformAdmin
    ? extractActiveCompanyId(req)
    : user.companyId;

  if (!isPlatformAdmin && !user.companyId) {
    throw new UnauthorizedError('User has no company', 'INVALID_TOKEN');
  }

  // Super Admin may select a company; verify it exists and is active.
  if (isPlatformAdmin && activeCompanyId) {
    const company = await prismaBase.company.findFirst({
      where: { id: activeCompanyId, active: true },
    });
    if (!company) {
      throw new ForbiddenError('Selected company not found or inactive', 'COMPANY_NOT_FOUND');
    }
  }

  req.user = {
    id: user.id,
    login: user.login,
    name: user.name,
    role: user.role,
    email: user.email,
    locationId: user.locationId,
    companyId: user.companyId,
    activeCompanyId: activeCompanyId ?? null,
  };

  enterTenant({
    companyId: activeCompanyId ?? null,
    isImpersonatingCompany: isPlatformAdmin && Boolean(activeCompanyId),
    actorUserId: user.id,
  });
  next();
});

export function requireRoles(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw new UnauthorizedError();
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenError('Access denied', 'ACCESS_DENIED');
    }
    next();
  };
}

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== UserRole.PLATFORM_ADMIN) {
    throw new ForbiddenError('Platform admin access required', 'ACCESS_DENIED');
  }
  next();
}

/** HR access: company users with HR roles, or Super Admin with a company selected. */
export function requireHr(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new UnauthorizedError();
  if (req.user.role === UserRole.PLATFORM_ADMIN) {
    if (!req.user.activeCompanyId) {
      throw new ForbiddenError('Select a company first', 'COMPANY_CONTEXT_REQUIRED');
    }
    next();
    return;
  }
  const hrRoles: UserRole[] = [
    UserRole.HR_MANAGER,
    UserRole.HR_SUPERVISOR,
    UserRole.HR_USER,
  ];
  if (!hrRoles.includes(req.user.role)) {
    throw new ForbiddenError('HR access required', 'ACCESS_DENIED');
  }
  next();
}

export function isBranchManagerUser(req: Request): boolean {
  return req.user?.role === UserRole.BRANCH_MANAGER;
}

/** HR plus branch managers (location-scoped). Super Admin needs company selected. */
export function requireHrOrBranchManager(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new UnauthorizedError();
  if (req.user.role === UserRole.PLATFORM_ADMIN) {
    if (!req.user.activeCompanyId) {
      throw new ForbiddenError('Select a company first', 'COMPANY_CONTEXT_REQUIRED');
    }
    next();
    return;
  }
  const roles: UserRole[] = [
    UserRole.HR_MANAGER,
    UserRole.HR_SUPERVISOR,
    UserRole.HR_USER,
    UserRole.BRANCH_MANAGER,
  ];
  if (!roles.includes(req.user.role)) {
    throw new ForbiddenError('Access denied', 'ACCESS_DENIED');
  }
  next();
}

export function requireHrManager(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new UnauthorizedError();
  if (req.user.role === UserRole.PLATFORM_ADMIN) {
    if (!req.user.activeCompanyId) {
      throw new ForbiddenError('Select a company first', 'COMPANY_CONTEXT_REQUIRED');
    }
    next();
    return;
  }
  if (req.user.role !== UserRole.HR_MANAGER) {
    throw new ForbiddenError('HR Manager access required', 'ACCESS_DENIED');
  }
  next();
}
