import { User, UserRole } from '@prisma/client';
import { prismaBase } from '../prisma/client';

export type MembershipSummary = {
  companyId: string;
  companyCode: string;
  companyName: string;
  role: UserRole;
};

export async function listMembershipsForUser(userId: string): Promise<MembershipSummary[]> {
  const rows = await prismaBase.userCompanyMembership.findMany({
    where: { userId },
    include: {
      company: { select: { id: true, code: true, name: true, active: true } },
    },
    orderBy: { company: { name: 'asc' } },
  });
  return rows
    .filter((r) => r.company.active)
    .map((r) => ({
      companyId: r.companyId,
      companyCode: r.company.code,
      companyName: r.company.name,
      role: r.role,
    }));
}

export async function userHasMembership(userId: string, companyId: string): Promise<boolean> {
  const row = await prismaBase.userCompanyMembership.findUnique({
    where: { userId_companyId: { userId, companyId } },
    include: { company: { select: { active: true } } },
  });
  return Boolean(row && row.company.active);
}

export async function getMembershipRole(
  userId: string,
  companyId: string,
): Promise<UserRole | null> {
  const row = await prismaBase.userCompanyMembership.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
  return row?.role ?? null;
}

export async function ensureHomeMembership(user: Pick<User, 'id' | 'companyId' | 'role'>): Promise<void> {
  if (!user.companyId) return;
  await prismaBase.userCompanyMembership.upsert({
    where: { userId_companyId: { userId: user.id, companyId: user.companyId } },
    create: {
      userId: user.id,
      companyId: user.companyId,
      role: user.role,
    },
    update: {},
  });
}

export async function addMembership(input: {
  userId: string;
  companyId: string;
  role?: UserRole;
}): Promise<MembershipSummary> {
  const user = await prismaBase.user.findUnique({ where: { id: input.userId } });
  if (!user || !user.companyId) {
    throw Object.assign(new Error('User not found'), { errorCode: 'NOT_FOUND' });
  }
  const company = await prismaBase.company.findFirst({
    where: { id: input.companyId, active: true },
  });
  if (!company) {
    throw Object.assign(new Error('Company not found'), { errorCode: 'NOT_FOUND' });
  }
  const role = input.role ?? user.role;
  await prismaBase.userCompanyMembership.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    create: { userId: user.id, companyId: company.id, role },
    update: { role },
  });
  return {
    companyId: company.id,
    companyCode: company.code,
    companyName: company.name,
    role,
  };
}

export async function removeMembership(userId: string, companyId: string): Promise<void> {
  const user = await prismaBase.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw Object.assign(new Error('User not found'), { errorCode: 'NOT_FOUND' });
  }
  if (user.companyId === companyId) {
    throw Object.assign(new Error('Cannot remove home company membership'), {
      errorCode: 'VALIDATION_ERROR',
    });
  }
  await prismaBase.userCompanyMembership.deleteMany({
    where: { userId, companyId },
  });
}

export async function listMembershipsForAdmin(userId: string): Promise<MembershipSummary[]> {
  const user = await prismaBase.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw Object.assign(new Error('User not found'), { errorCode: 'NOT_FOUND' });
  }
  return listMembershipsForUser(userId);
}
