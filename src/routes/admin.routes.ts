import { Router, Request } from 'express';
import { UserRole } from '@prisma/client';
import { asyncHandler } from '../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../middlewares/jsonRpc';
import { requireAuth, requirePlatformAdmin } from '../middlewares/auth';
import { prisma, prismaBase } from '../prisma/client';
import { hashPassword, revokeUserSessions, userInfoJson } from '../services/auth.service';
import { normalizeLoginInput, PASSWORD_MIN_LENGTH } from '../utils/loginValidation';
import { queueUserCredentialsEmail } from '../services/mail.service';
import { isLocationScopedHrRole } from '../services/userLocationScope.service';
import { listFeatureGrants, setFeatureGrant, AUDIT_FEATURE } from '../services/auditLog.service';
import {
  assertCanCreateDashboardUsers,
  assertCanCreateEmployees,
  roleTakesSeat,
} from '../services/licenseQuota.service';
import { ensureHomeMembership } from '../services/companyMembership.service';
import { randomBytes } from 'crypto';
import companiesRoutes from './admin.companies.routes';
import salesPlansRoutes from './admin.sales.routes';
import membershipsRoutes from './admin.memberships.routes';

const router = Router();

router.use(companiesRoutes);
router.use(salesPlansRoutes);
router.use(membershipsRoutes);

function params(req: { rpcParams?: Record<string, unknown> }) {
  return req.rpcParams ?? {};
}

function requireSelectedCompany(req: Request): string | null {
  const id = req.user?.activeCompanyId ?? null;
  return id && id.trim() !== '' ? id : null;
}

router.post(
  '/users',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const companyId = requireSelectedCompany(req);
    if (!companyId) {
      jsonRpcSuccess(res, biotimeFail('Select a company first', 'COMPANY_CONTEXT_REQUIRED'), req.rpcId);
      return;
    }

    const p = params(req);
    const name = String(p.name ?? p.new_user_name ?? '').trim();
    const loginRaw = String(p.login ?? p.new_user_login ?? '').trim();
    const login = loginRaw ? normalizeLoginInput(loginRaw) : '';
    const password = String(p.password ?? p.new_user_password ?? '');
    const role = String(p.role ?? 'EMPLOYEE').toUpperCase() as UserRole;
    const locationIdRaw = p.locationId ?? p.location_id;
    const locationId = locationIdRaw != null && String(locationIdRaw).trim() !== ''
      ? String(locationIdRaw).trim()
      : null;

    if (!name || !login || !password) {
      jsonRpcSuccess(res, biotimeFail('Name, login and password are required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }

    const validRoles: UserRole[] = [
      UserRole.EMPLOYEE,
      UserRole.HR_USER,
      UserRole.HR_SUPERVISOR,
      UserRole.HR_MANAGER,
      UserRole.BRANCH_MANAGER,
      UserRole.DEVICE_MANAGER,
    ];
    const userRole = validRoles.includes(role) ? role : UserRole.EMPLOYEE;

    if (isLocationScopedHrRole(userRole) && !locationId) {
      jsonRpcSuccess(res, biotimeFail('Location is required for HR and branch manager users', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }

    if (locationId) {
      const location = await prisma.location.findFirst({ where: { id: locationId, active: true } });
      if (!location) {
        jsonRpcSuccess(res, biotimeFail('Location not found', 'NOT_FOUND'), req.rpcId);
        return;
      }
    }

    const existing = await prismaBase.user.findFirst({ where: { companyId, login } });
    if (existing) {
      jsonRpcSuccess(res, biotimeFail('Login already exists', 'DUPLICATE_LOGIN'), req.rpcId);
      return;
    }

    const createsProfile =
      userRole === UserRole.EMPLOYEE ||
      userRole === UserRole.HR_USER ||
      userRole === UserRole.HR_SUPERVISOR ||
      userRole === UserRole.HR_MANAGER;
    // Check both seats before the user insert so a full employee quota never leaves an orphan login.
    if (roleTakesSeat(userRole)) await assertCanCreateDashboardUsers(companyId, 1);
    if (createsProfile) await assertCanCreateEmployees(companyId, 1);

    const user = await prisma.user.create({
      data: {
        companyId,
        name,
        login,
        email: login.includes('@') ? login : null,
        passwordHash: await hashPassword(password),
        initialPassword: password,
        role: userRole,
        locationId: isLocationScopedHrRole(userRole) ? locationId : null,
      },
      include: { location: true },
    });

    await ensureHomeMembership(user);

    if (createsProfile) {
      await prisma.employeeProfile.create({
        data: {
          companyId,
          userId: user.id,
          name,
          displayName: name,
          workEmail: login.includes('@') ? login : undefined,
        },
      });
    }

    const emailResult = queueUserCredentialsEmail({
      name,
      login,
      email: user.email,
      password,
      role: userRole,
      kind: 'welcome',
    });

    const message = emailResult.queued
      ? `تم إنشاء المستخدم — جاري إرسال بيانات الدخول إلى ${emailResult.to}`
      : emailResult.error === 'NO_EMAIL'
        ? 'User created (no email on login — credentials email skipped)'
        : `User created (email not sent: ${emailResult.error ?? 'unknown'})`;

    jsonRpcSuccess(
      res,
      biotimeOk({
        user: userInfoJson(user),
        message,
        emailSent: emailResult.queued,
        emailQueued: emailResult.queued,
        emailTo: emailResult.to ?? null,
        emailError: emailResult.queued ? null : emailResult.error ?? null,
      }),
      req.rpcId,
    );
  }),
);

router.post(
  '/users/list',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const companyId = requireSelectedCompany(req);
    if (!companyId) {
      jsonRpcSuccess(res, biotimeFail('Select a company first', 'COMPANY_CONTEXT_REQUIRED'), req.rpcId);
      return;
    }

    const users = await prismaBase.user.findMany({
      where: { companyId, role: { not: UserRole.PLATFORM_ADMIN } },
      include: { location: true },
      orderBy: { createdAt: 'desc' },
    });
    jsonRpcSuccess(
      res,
      biotimeOk({
        users: users.map((u) => ({
          ...userInfoJson(u),
          initialPassword: u.initialPassword ?? null,
          active: u.active,
          createdAt: u.createdAt.toISOString(),
        })),
        count: users.length,
      }),
      req.rpcId,
    );
  }),
);

router.post(
  '/users/deactivate',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const companyId = requireSelectedCompany(req);
    if (!companyId) {
      jsonRpcSuccess(res, biotimeFail('Select a company first', 'COMPANY_CONTEXT_REQUIRED'), req.rpcId);
      return;
    }
    const p = params(req);
    const userId = String(p.userId ?? p.id ?? '');
    if (!userId) {
      jsonRpcSuccess(res, biotimeFail('userId required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    const user = await prismaBase.user.findFirst({ where: { id: userId, companyId } });
    if (!user || user.role === UserRole.PLATFORM_ADMIN) {
      jsonRpcSuccess(res, biotimeFail('User not found', 'NOT_FOUND'), req.rpcId);
      return;
    }
    await prismaBase.user.update({ where: { id: userId }, data: { active: false } });
    jsonRpcSuccess(res, biotimeOk({ message: 'User deactivated' }), req.rpcId);
  }),
);

router.post(
  '/users/reset-password',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const companyId = requireSelectedCompany(req);
    if (!companyId) {
      jsonRpcSuccess(res, biotimeFail('Select a company first', 'COMPANY_CONTEXT_REQUIRED'), req.rpcId);
      return;
    }
    const p = params(req);
    const userId = String(p.userId ?? p.id ?? '');
    if (!userId) {
      jsonRpcSuccess(res, biotimeFail('userId required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    const user = await prismaBase.user.findFirst({
      where: { id: userId, companyId },
      include: { location: true },
    });
    if (!user || user.role === UserRole.PLATFORM_ADMIN) {
      jsonRpcSuccess(res, biotimeFail('User not found', 'NOT_FOUND'), req.rpcId);
      return;
    }
    const password = String(p.password ?? '').trim() || randomBytes(6).toString('base64url').slice(0, 12);
    const updated = await prismaBase.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(password),
        initialPassword: password,
      },
      include: { location: true },
    });
    await revokeUserSessions(userId);

    const company = await prismaBase.company.findUnique({
      where: { id: companyId },
      select: { code: true, name: true },
    });

    const emailResult = queueUserCredentialsEmail({
      name: updated.name,
      login: updated.login,
      email: updated.email,
      password,
      role: updated.role,
      kind: 'reset',
      companyCode: company?.code,
      companyName: company?.name,
      subject: 'حضوري — بيانات الدخول الجديدة',
    });

    const message = emailResult.queued
      ? `تم إعادة تعيين كلمة المرور — جاري الإرسال إلى ${emailResult.to}`
      : `Password reset (email not sent: ${emailResult.error ?? 'unknown'})`;

    jsonRpcSuccess(
      res,
      biotimeOk({
        user: { ...userInfoJson(updated), initialPassword: password },
        password,
        message,
        emailSent: emailResult.queued,
        emailQueued: emailResult.queued,
        emailTo: emailResult.to ?? null,
        emailError: emailResult.queued ? null : emailResult.error ?? null,
      }),
      req.rpcId,
    );
  }),
);

router.post(
  '/users/set-password',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const companyId = requireSelectedCompany(req);
    if (!companyId) {
      jsonRpcSuccess(res, biotimeFail('Select a company first', 'COMPANY_CONTEXT_REQUIRED'), req.rpcId);
      return;
    }
    const p = params(req);
    const userId = String(p.userId ?? p.id ?? '').trim();
    const password = String(p.password ?? '').trim();
    if (!userId) {
      jsonRpcSuccess(res, biotimeFail('userId required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      jsonRpcSuccess(
        res,
        biotimeFail(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`, 'VALIDATION_ERROR'),
        req.rpcId,
      );
      return;
    }
    const user = await prismaBase.user.findFirst({
      where: { id: userId, companyId },
      include: { location: true },
    });
    if (!user || user.role === UserRole.PLATFORM_ADMIN) {
      jsonRpcSuccess(res, biotimeFail('User not found', 'NOT_FOUND'), req.rpcId);
      return;
    }
    const updated = await prismaBase.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(password),
        initialPassword: password,
      },
      include: { location: true },
    });
    await revokeUserSessions(userId);
    jsonRpcSuccess(
      res,
      biotimeOk({
        user: { ...userInfoJson(updated), initialPassword: password },
        password,
        message: 'تم تحديث كلمة المرور',
      }),
      req.rpcId,
    );
  }),
);

router.post(
  '/feature-grants/list',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const feature = String(params(req).feature ?? AUDIT_FEATURE);
    const items = await listFeatureGrants(feature);
    jsonRpcSuccess(res, biotimeOk({ items, feature, count: items.length }), req.rpcId);
  }),
);

router.post(
  '/feature-grants/set',
  requireAuth,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const userId = String(p.userId ?? p.id ?? '');
    const enabled = p.enabled === true || p.enabled === 'true';
    const feature = String(p.feature ?? AUDIT_FEATURE);
    if (!userId) {
      jsonRpcSuccess(res, biotimeFail('userId required', 'VALIDATION_ERROR'), req.rpcId);
      return;
    }
    const grant = await setFeatureGrant({
      userId,
      feature,
      enabled,
      grantedById: req.user?.id ?? null,
    });
    jsonRpcSuccess(
      res,
      biotimeOk({
        grant: {
          userId: grant.userId,
          feature: grant.feature,
          enabled: grant.enabled,
          grantedAt: grant.grantedAt.toISOString(),
        },
        message: enabled ? 'تم تفعيل الصلاحية للمستخدم' : 'تم إيقاف الصلاحية للمستخدم',
      }),
      req.rpcId,
    );
  }),
);

export default router;
