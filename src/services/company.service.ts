import { prismaBase } from '../prisma/client';
import { hashPassword } from './auth.service';
import { UserRole } from '@prisma/client';
import { ensureBioTimeConfigFromEnv } from '../bootstrap/biotimeConfig';
import { ensureOdooConfigFromEnv } from '../bootstrap/odooConfig';

function normalizeCompanyCode(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function listCompanies() {
  return prismaBase.company.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      code: true,
      name: true,
      active: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { users: true, employees: true } },
    },
  });
}

export async function getCompany(id: string) {
  return prismaBase.company.findUnique({
    where: { id },
    select: {
      id: true,
      code: true,
      name: true,
      active: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export type CreateCompanyInput = {
  code: string;
  name: string;
  hrManagerName?: string;
  hrManagerLogin?: string;
  hrManagerPassword?: string;
};

export async function createCompany(input: CreateCompanyInput) {
  const code = normalizeCompanyCode(input.code);
  const name = input.name.trim();
  if (!code || !name) {
    throw Object.assign(new Error('Code and name are required'), { errorCode: 'VALIDATION_ERROR' });
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(code)) {
    throw Object.assign(
      new Error('Company code must be 2–63 chars: lowercase letters, digits, _ or -'),
      { errorCode: 'VALIDATION_ERROR' },
    );
  }

  const existing = await prismaBase.company.findFirst({
    where: { code: { equals: code, mode: 'insensitive' } },
  });
  if (existing) {
    throw Object.assign(new Error('Company code already exists'), { errorCode: 'DUPLICATE' });
  }

  const company = await prismaBase.company.create({
    data: { code, name, active: true },
  });

  await ensureBioTimeConfigFromEnv(company.id);
  await ensureOdooConfigFromEnv(company.id);

  let hrManager: { id: string; login: string } | null = null;
  const hrLogin = (input.hrManagerLogin ?? '').trim();
  const hrPassword = input.hrManagerPassword ?? '';
  const hrName = (input.hrManagerName ?? '').trim() || 'HR Manager';

  if (hrLogin && hrPassword) {
    const passwordHash = await hashPassword(hrPassword);
    const user = await prismaBase.user.create({
      data: {
        companyId: company.id,
        login: hrLogin,
        email: hrLogin.includes('@') ? hrLogin : null,
        name: hrName,
        passwordHash,
        initialPassword: hrPassword,
        role: UserRole.HR_MANAGER,
      },
    });
    await prismaBase.employeeProfile.create({
      data: {
        companyId: company.id,
        userId: user.id,
        name: hrName,
        displayName: hrName,
        workEmail: hrLogin.includes('@') ? hrLogin : undefined,
      },
    });
    hrManager = { id: user.id, login: user.login };
  }

  return { company, hrManager };
}

export async function updateCompany(
  id: string,
  data: { name?: string; active?: boolean },
) {
  const patch: { name?: string; active?: boolean } = {};
  if (data.name != null) patch.name = data.name.trim();
  if (data.active != null) patch.active = data.active;
  return prismaBase.company.update({ where: { id }, data: patch });
}
