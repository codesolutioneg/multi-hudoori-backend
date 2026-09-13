import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole } from '@prisma/client';
import { prisma, prismaBase } from '../prisma/client';
import { UnauthorizedError } from '../utils/errors';
import { normalizeLoginInput } from '../utils/loginValidation';
import { runWithTenant } from '../tenant/context';

const TOKEN_EXPIRY_DAYS = 30;

function normalizeCompanyCode(raw: string): string {
  return raw.trim().toLowerCase();
}

async function findTenantUser(companyId: string, login: string): Promise<User | null> {
  const normalized = normalizeLoginInput(login);
  const byLogin = await prismaBase.user.findFirst({
    where: { companyId, login: normalized },
  });
  if (byLogin) return byLogin;

  if (normalized.includes('@')) {
    return prismaBase.user.findFirst({
      where: {
        companyId,
        email: { equals: normalized, mode: 'insensitive' },
      },
    });
  }

  return null;
}

async function findPlatformAdmin(login: string): Promise<User | null> {
  const normalized = normalizeLoginInput(login);
  const byLogin = await prismaBase.user.findFirst({
    where: { companyId: null, role: UserRole.PLATFORM_ADMIN, login: normalized },
  });
  if (byLogin) return byLogin;

  if (normalized.includes('@')) {
    return prismaBase.user.findFirst({
      where: {
        companyId: null,
        role: UserRole.PLATFORM_ADMIN,
        email: { equals: normalized, mode: 'insensitive' },
      },
    });
  }

  return null;
}

/**
 * Company user login: companyCode + login/email + password.
 * Platform admin login: login/email + password (no companyCode).
 */
export async function login(
  loginName: string,
  password: string,
  deviceInfo?: string,
  companyCode?: string | null,
) {
  const code = companyCode != null && String(companyCode).trim() !== ''
    ? normalizeCompanyCode(String(companyCode))
    : null;

  let user: User | null = null;
  let resolvedCompanyId: string | null = null;

  if (code) {
    const company = await prismaBase.company.findFirst({
      where: { code, active: true },
    });
    // Also allow case-insensitive match if stored mixed-case historically
    const companyResolved =
      company ??
      (await prismaBase.company.findFirst({
        where: { active: true, code: { equals: code, mode: 'insensitive' } },
      }));

    if (!companyResolved) {
      throw new UnauthorizedError('Invalid company, login or password', 'INVALID_CREDENTIALS');
    }

    resolvedCompanyId = companyResolved.id;
    user = await findTenantUser(companyResolved.id, loginName);
  } else {
    user = await findPlatformAdmin(loginName);
  }

  if (!user || !user.active) {
    throw new UnauthorizedError('Invalid login or password', 'INVALID_CREDENTIALS');
  }

  if (code && user.role === UserRole.PLATFORM_ADMIN) {
    throw new UnauthorizedError('Invalid login or password', 'INVALID_CREDENTIALS');
  }

  if (!code && user.role !== UserRole.PLATFORM_ADMIN) {
    throw new UnauthorizedError(
      'Company code is required for this account',
      'COMPANY_CODE_REQUIRED',
    );
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError('Invalid login or password', 'INVALID_CREDENTIALS');
  }

  const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + TOKEN_EXPIRY_DAYS);

  await prismaBase.apiToken.create({
    data: {
      token,
      userId: user.id,
      companyId: user.companyId,
      deviceInfo: deviceInfo ?? 'Hudoori Multi App',
      expiryDate,
    },
  });

  const companyId = resolvedCompanyId ?? user.companyId ?? null;
  const company = companyId
    ? await prismaBase.company.findUnique({
        where: { id: companyId },
        select: { id: true, code: true, name: true },
      })
    : null;

  return {
    token,
    expiry_date: expiryDate.toISOString().replace('T', ' ').slice(0, 19),
    user: userInfoJson(user),
    companyId,
    company: company
      ? { id: company.id, code: company.code, name: company.name }
      : null,
  };
}

export async function logout(token: string): Promise<void> {
  await prismaBase.apiToken.deleteMany({ where: { token } });
}

export async function validateToken(token: string): Promise<boolean> {
  const apiToken = await prismaBase.apiToken.findUnique({
    where: { token },
    include: { user: { select: { active: true } } },
  });
  return Boolean(apiToken && apiToken.expiryDate >= new Date() && apiToken.user.active);
}

export function userInfoJson(user: {
  id: string;
  name: string;
  email?: string | null;
  login: string;
  role: UserRole;
  locationId?: string | null;
  companyId?: string | null;
  location?: { id: string; name: string; code?: string | null } | null;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email ?? null,
    login: user.login,
    role: user.role,
    isPlatformAdmin: user.role === UserRole.PLATFORM_ADMIN,
    companyId: user.companyId ?? null,
    locationId: user.locationId ?? null,
    locationName: user.location?.name ?? null,
    locationCode: user.location?.code ?? null,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/** Run a callback inside the user's company tenant (no-op company for platform admin). */
export function withUserCompany<T>(companyId: string | null | undefined, fn: () => T): T {
  return runWithTenant(
    {
      companyId: companyId ?? null,
      isImpersonatingCompany: false,
    },
    fn,
  );
}
