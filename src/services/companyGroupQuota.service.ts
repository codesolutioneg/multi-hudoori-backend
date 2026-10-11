import { UserRole } from '@prisma/client';
import { prismaBase } from '../prisma/client';
import { AppError } from '../utils/errors';
import { SEATLESS_ROLES } from './licenseQuota.service';

export const PARENT_QUOTA_EXCEEDED = 'PARENT_QUOTA_EXCEEDED';

function quotaError(message: string): AppError {
  return new AppError(message, 400, PARENT_QUOTA_EXCEEDED);
}

/** Root = topmost parent (no parentCompanyId). */
export async function getGroupRootCompanyId(companyId: string): Promise<string> {
  let cursor = companyId;
  for (let i = 0; i < 32; i++) {
    const row = await prismaBase.company.findUnique({
      where: { id: cursor },
      select: { id: true, parentCompanyId: true },
    });
    if (!row) return companyId;
    if (!row.parentCompanyId) return row.id;
    cursor = row.parentCompanyId;
  }
  return cursor;
}

/** Root plus all descendant companies (one level or deep). */
export async function listGroupCompanyIds(rootId: string): Promise<string[]> {
  const ids = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < 32 && frontier.length; depth++) {
    const children = await prismaBase.company.findMany({
      where: { parentCompanyId: { in: frontier }, active: true },
      select: { id: true },
    });
    frontier = [];
    for (const c of children) {
      if (!ids.has(c.id)) {
        ids.add(c.id);
        frontier.push(c.id);
      }
    }
  }
  return [...ids];
}

async function sumAllocatedMaxUsers(parentId: string, excludeCompanyId?: string): Promise<number> {
  const children = await prismaBase.company.findMany({
    where: { parentCompanyId: parentId, active: true },
    select: { id: true, maxUsers: true },
  });
  let sum = 0;
  for (const c of children) {
    if (excludeCompanyId && c.id === excludeCompanyId) continue;
    if (c.maxUsers != null) sum += c.maxUsers;
  }
  return sum;
}

async function sumAllocatedMaxEmployees(parentId: string, excludeCompanyId?: string): Promise<number> {
  const children = await prismaBase.company.findMany({
    where: { parentCompanyId: parentId, active: true },
    select: { id: true, maxEmployees: true },
  });
  let sum = 0;
  for (const c of children) {
    if (excludeCompanyId && c.id === excludeCompanyId) continue;
    if (c.maxEmployees != null) sum += c.maxEmployees;
  }
  return sum;
}

export type ParentPoolSnapshot = {
  parentCompanyId: string;
  parentMaxEmployees: number | null;
  parentMaxUsers: number | null;
  siblingsAllocatedEmployees: number;
  siblingsAllocatedUsers: number;
  /** Null when parent employees are unlimited. */
  remainingEmployees: number | null;
  /** Null when parent users are unlimited. */
  remainingUsers: number | null;
};

/** Remaining seat budget a child can take from its direct parent (siblings excluded). */
export async function getParentPoolSnapshot(
  parentCompanyId: string,
  excludeCompanyId?: string,
): Promise<ParentPoolSnapshot | null> {
  const parent = await prismaBase.company.findUnique({
    where: { id: parentCompanyId },
    select: { id: true, maxUsers: true, maxEmployees: true },
  });
  if (!parent) return null;

  const [siblingsAllocatedEmployees, siblingsAllocatedUsers] = await Promise.all([
    sumAllocatedMaxEmployees(parentCompanyId, excludeCompanyId),
    sumAllocatedMaxUsers(parentCompanyId, excludeCompanyId),
  ]);

  return {
    parentCompanyId: parent.id,
    parentMaxEmployees: parent.maxEmployees,
    parentMaxUsers: parent.maxUsers,
    siblingsAllocatedEmployees,
    siblingsAllocatedUsers,
    remainingEmployees:
      parent.maxEmployees == null
        ? null
        : Math.max(0, parent.maxEmployees - siblingsAllocatedEmployees),
    remainingUsers:
      parent.maxUsers == null ? null : Math.max(0, parent.maxUsers - siblingsAllocatedUsers),
  };
}

async function assertChildCapsAgainstParent(
  parentCompanyId: string,
  maxUsers: number | null,
  maxEmployees: number | null,
  excludeCompanyId?: string,
): Promise<void> {
  const parent = await prismaBase.company.findUnique({
    where: { id: parentCompanyId },
    select: { maxUsers: true, maxEmployees: true },
  });
  if (!parent) return;

  // Under a capped parent, child must have a numeric share — "unlimited" would bypass the pool.
  if (parent.maxEmployees != null && maxEmployees == null) {
    throw quotaError(
      `الشركة الرئيسية لها حد موظفين (${parent.maxEmployees}) — يجب تحديد حد موظفين للفرع من نفس الحصة.`,
    );
  }
  if (parent.maxUsers != null && maxUsers == null) {
    throw quotaError(
      `الشركة الرئيسية لها حد مستخدمين (${parent.maxUsers}) — يجب تحديد حد مستخدمين للفرع من نفس الحصة.`,
    );
  }

  if (maxUsers != null && parent.maxUsers != null && maxUsers > parent.maxUsers) {
    throw quotaError(
      `حد مستخدمي الفرع (${maxUsers}) لا يمكن أن يتجاوز حد الشركة الرئيسية (${parent.maxUsers}).`,
    );
  }
  if (maxEmployees != null && parent.maxEmployees != null && maxEmployees > parent.maxEmployees) {
    throw quotaError(
      `حد موظفي الفرع (${maxEmployees}) لا يمكن أن يتجاوز حد الشركة الرئيسية (${parent.maxEmployees}).`,
    );
  }

  if (maxUsers != null && parent.maxUsers != null) {
    const siblingSum = await sumAllocatedMaxUsers(parentCompanyId, excludeCompanyId);
    if (siblingSum + maxUsers > parent.maxUsers) {
      throw quotaError(
        `مجموع حدود مستخدمي الفروع (${siblingSum + maxUsers}) يتجاوز حد الشركة الرئيسية (${parent.maxUsers}). المتبقي للتوزيع: ${Math.max(0, parent.maxUsers - siblingSum)}.`,
      );
    }
  }
  if (maxEmployees != null && parent.maxEmployees != null) {
    const siblingSum = await sumAllocatedMaxEmployees(parentCompanyId, excludeCompanyId);
    if (siblingSum + maxEmployees > parent.maxEmployees) {
      throw quotaError(
        `مجموع حدود موظفي الفروع (${siblingSum + maxEmployees}) يتجاوز حد الشركة الرئيسية (${parent.maxEmployees}). المتبقي للتوزيع: ${Math.max(0, parent.maxEmployees - siblingSum)}.`,
      );
    }
  }
}

/**
 * When lowering (or setting) a parent company's caps, ensure existing children still fit
 * and none are "unlimited" under a finite parent pool.
 */
export async function assertParentQuotaCoversChildren(
  parentCompanyId: string,
  maxUsers: number | null,
  maxEmployees: number | null,
): Promise<void> {
  const children = await prismaBase.company.findMany({
    where: { parentCompanyId, active: true },
    select: { id: true, code: true, maxUsers: true, maxEmployees: true },
  });
  if (children.length === 0) return;

  if (maxEmployees != null) {
    const unlimited = children.filter((c) => c.maxEmployees == null);
    if (unlimited.length > 0) {
      throw quotaError(
        `لا يمكن ضبط حد موظفي الشركة الرئيسية (${maxEmployees}) بينما فرع بلا حد موظفين: ${unlimited.map((c) => c.code).join(', ')}.`,
      );
    }
    const sum = children.reduce((acc, c) => acc + (c.maxEmployees ?? 0), 0);
    if (sum > maxEmployees) {
      throw quotaError(
        `مجموع حدود موظفي الفروع (${sum}) يتجاوز الحد الجديد للشركة الرئيسية (${maxEmployees}). قلّل حدود الفروع أولاً.`,
      );
    }
  }

  if (maxUsers != null) {
    const unlimited = children.filter((c) => c.maxUsers == null);
    if (unlimited.length > 0) {
      throw quotaError(
        `لا يمكن ضبط حد مستخدمي الشركة الرئيسية (${maxUsers}) بينما فرع بلا حد مستخدمين: ${unlimited.map((c) => c.code).join(', ')}.`,
      );
    }
    const sum = children.reduce((acc, c) => acc + (c.maxUsers ?? 0), 0);
    if (sum > maxUsers) {
      throw quotaError(
        `مجموع حدود مستخدمي الفروع (${sum}) يتجاوز الحد الجديد للشركة الرئيسية (${maxUsers}). قلّل حدود الفروع أولاً.`,
      );
    }
  }
}

export async function assertNewChildQuotasUnderParent(
  parentCompanyId: string,
  quotas: { maxUsers: number | null; maxEmployees: number | null },
): Promise<void> {
  await assertChildCapsAgainstParent(parentCompanyId, quotas.maxUsers, quotas.maxEmployees);
}

/** Validates child company caps vs direct parent (per-cap and sum of siblings). */
export async function assertChildQuotasWithinParent(
  companyId: string,
  quotas: { maxUsers?: number | null; maxEmployees?: number | null },
): Promise<void> {
  const company = await prismaBase.company.findUnique({
    where: { id: companyId },
    select: { parentCompanyId: true, maxUsers: true, maxEmployees: true },
  });
  if (!company?.parentCompanyId) return;

  const maxUsers = quotas.maxUsers !== undefined ? quotas.maxUsers : company.maxUsers;
  const maxEmployees =
    quotas.maxEmployees !== undefined ? quotas.maxEmployees : company.maxEmployees;

  await assertChildCapsAgainstParent(
    company.parentCompanyId,
    maxUsers,
    maxEmployees,
    companyId,
  );
}

export async function countGroupDashboardUsers(groupCompanyIds: string[]): Promise<number> {
  return prismaBase.user.count({
    where: {
      companyId: { in: groupCompanyIds },
      role: { notIn: [...SEATLESS_ROLES] as UserRole[] },
    },
  });
}

export async function countGroupEmployees(groupCompanyIds: string[]): Promise<number> {
  return prismaBase.employeeProfile.count({
    where: { companyId: { in: groupCompanyIds } },
  });
}

/** Actual seats used across the whole tree must not exceed the root caps. */
export async function assertGroupCanAddDashboardUsers(companyId: string, addCount = 1): Promise<void> {
  if (addCount <= 0) return;
  const rootId = await getGroupRootCompanyId(companyId);
  const root = await prismaBase.company.findUnique({
    where: { id: rootId },
    select: { maxUsers: true, name: true },
  });
  if (!root || root.maxUsers == null) return;

  const groupIds = await listGroupCompanyIds(rootId);
  const used = await countGroupDashboardUsers(groupIds);
  if (used + addCount > root.maxUsers) {
    throw quotaError(
      `مجموع مستخدمي لوحة التحكم في المجموعة (${used + addCount}) يتجاوز حد الشركة الرئيسية (${root.maxUsers}).`,
    );
  }
}

export async function assertGroupCanAddEmployees(companyId: string, addCount = 1): Promise<void> {
  if (addCount <= 0) return;
  const rootId = await getGroupRootCompanyId(companyId);
  const root = await prismaBase.company.findUnique({
    where: { id: rootId },
    select: { maxEmployees: true },
  });
  if (!root || root.maxEmployees == null) return;

  const groupIds = await listGroupCompanyIds(rootId);
  const used = await countGroupEmployees(groupIds);
  if (used + addCount > root.maxEmployees) {
    throw quotaError(
      `مجموع الموظفين في المجموعة (${used + addCount}) يتجاوز حد الشركة الرئيسية (${root.maxEmployees}).`,
    );
  }
}

/** Membership targets must be child companies under the user's home (parent) company. */
export async function assertMembershipTargetAllowed(
  homeCompanyId: string,
  targetCompanyId: string,
): Promise<void> {
  if (homeCompanyId === targetCompanyId) {
    throw Object.assign(new Error('Home company is already the default membership'), {
      errorCode: 'VALIDATION_ERROR',
    });
  }

  const home = await prismaBase.company.findUnique({
    where: { id: homeCompanyId },
    select: { parentCompanyId: true },
  });
  if (home?.parentCompanyId) {
    throw Object.assign(
      new Error('مستخدم HR يجب أن يكون على الشركة الرئيسية (بدون شركة أم) ثم تُربط الفروع'),
      { errorCode: 'VALIDATION_ERROR' },
    );
  }

  const target = await prismaBase.company.findFirst({
    where: { id: targetCompanyId, active: true },
    select: { id: true, parentCompanyId: true, name: true },
  });
  if (!target) {
    throw Object.assign(new Error('Company not found'), { errorCode: 'NOT_FOUND' });
  }
  if (!target.parentCompanyId) {
    throw Object.assign(
      new Error('يمكن ربط شركات فرعية فقط — اختر شركة تابعة لشركة رئيسية'),
      { errorCode: 'VALIDATION_ERROR' },
    );
  }

  const groupIds = await listGroupCompanyIds(homeCompanyId);
  if (!groupIds.includes(target.id)) {
    throw Object.assign(
      new Error('الشركة الفرعية يجب أن تكون تابعة لشركة المستخدم الرئيسية'),
      { errorCode: 'VALIDATION_ERROR' },
    );
  }
}
