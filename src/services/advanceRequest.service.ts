/**
 * Employee-submitted advance requests («طلب سلفة»).
 *
 * Flow: employee (or their branch manager, for staff who can't use the app) files
 * a request → branch manager confirms it → HR approves, and only then does an
 * `AdvanceShort` exist for payroll to deduct. A pending request reserves its amount
 * against the employee's entitlement so the same allowance can't be claimed twice.
 */
import { AdvanceRequestState, UserRole } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, ForbiddenError } from '../utils/errors';
import {
  computeAdvanceEligibility,
  getAdvanceSettings,
  advanceEligibilityJson,
  type AdvanceEligibilityResult,
} from './advanceEligibility.service';
import { createShortAdvance, round2 } from './advances.service';
import { isResigned } from './payrollExport.service';
import {
  isBranchManagerOf,
  locationsManagedBy,
  resolveBranchManager,
} from './branchManager.service';

export type Actor = {
  id: string;
  role: UserRole;
  locationId?: string | null;
};

const HR_ROLES: UserRole[] = [
  UserRole.HR_MANAGER,
  UserRole.HR_SUPERVISOR,
  UserRole.HR_USER,
  UserRole.PLATFORM_ADMIN,
];

/** HR managers and platform admins are the only ones who can grant the advance. */
function isHrApprover(actor: Actor): boolean {
  return actor.role === UserRole.HR_MANAGER || actor.role === UserRole.PLATFORM_ADMIN;
}

function isHrStaff(actor: Actor): boolean {
  return HR_ROLES.includes(actor.role);
}

export function isPendingRequestState(state: AdvanceRequestState): boolean {
  return (
    state === AdvanceRequestState.pending_branch || state === AdvanceRequestState.pending_hr
  );
}

/**
 * Where a new request starts.
 *
 * An employee filing for themselves needs their branch manager to vouch first.
 * A manager filing for their own staff has already vouched, so it goes straight
 * to HR — and so does a branch manager's *own* request, because they are the only
 * person who could clear the branch step and nobody may approve themselves.
 */
export function initialRequestState(input: {
  onBehalf: boolean;
  actorIsBranchManager: boolean;
  actorIsHrStaff: boolean;
}): AdvanceRequestState {
  if (input.actorIsBranchManager) return AdvanceRequestState.pending_hr;
  if (input.onBehalf && input.actorIsHrStaff) return AdvanceRequestState.pending_hr;
  return AdvanceRequestState.pending_branch;
}

export async function employeeForUser(userId: string) {
  const profile = await prisma.employeeProfile.findFirst({ where: { userId } });
  if (!profile) throw new ForbiddenError('لا يوجد ملف موظف مرتبط بالحساب', 'ACCESS_DENIED');
  return profile;
}

type RequestRow = {
  id: string;
  employeeId: string;
  requestedById: string;
  locationId: string | null;
  amount: number;
  reason: string;
  state: AdvanceRequestState;
  eligibilityPercent: number | null;
  maxEligibleAtRequest: number | null;
  availableAtRequest: number | null;
  actualWorkingDaysAtRequest: number | null;
  branchApprovedById: string | null;
  branchApprovedAt: Date | null;
  hrApprovedById: string | null;
  hrApprovedAt: Date | null;
  rejectedById: string | null;
  rejectionReason: string | null;
  limitOverride: boolean;
  overrideReason: string | null;
  advanceShortId: string | null;
  createdAt: Date;
  updatedAt: Date;
  employee?: { id: string; name: string; code: string | null; locationId: string | null } | null;
  location?: { id: string; name: string } | null;
};

export function advanceRequestJson(r: RequestRow) {
  return {
    id: r.id,
    employeeId: r.employeeId,
    employeeName: r.employee?.name ?? null,
    employeeCode: r.employee?.code ?? null,
    requestedById: r.requestedById,
    locationId: r.locationId,
    locationName: r.location?.name ?? null,
    amount: round2(r.amount),
    reason: r.reason,
    state: r.state,
    eligibilityPercent: r.eligibilityPercent,
    maxEligibleAtRequest: r.maxEligibleAtRequest,
    availableAtRequest: r.availableAtRequest,
    actualWorkingDaysAtRequest: r.actualWorkingDaysAtRequest,
    branchApprovedById: r.branchApprovedById,
    branchApprovedAt: r.branchApprovedAt?.toISOString() ?? null,
    hrApprovedById: r.hrApprovedById,
    hrApprovedAt: r.hrApprovedAt?.toISOString() ?? null,
    rejectedById: r.rejectedById,
    rejectionReason: r.rejectionReason,
    limitOverride: r.limitOverride,
    overrideReason: r.overrideReason,
    advanceShortId: r.advanceShortId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const REQUEST_INCLUDE = {
  employee: { select: { id: true, name: true, code: true, locationId: true } },
  location: { select: { id: true, name: true } },
} as const;

/**
 * Entitlement for the request form. `excludeRequestId` lets an approver see the
 * figure without the request under review counting against itself.
 */
export async function getRequestEligibility(
  employeeId: string,
  excludeRequestId?: string | null,
): Promise<AdvanceEligibilityResult> {
  return computeAdvanceEligibility({ employeeId, excludeRequestId });
}

export async function createAdvanceRequest(
  actor: Actor,
  input: { employeeId?: string | null; amount: number; reason: string },
) {
  const amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError('قيمة السلفة يجب أن تكون أكبر من صفر', 400, 'VALIDATION_ERROR');
  }
  const reason = String(input.reason ?? '').trim();
  if (!reason) {
    throw new AppError('اكتب سبب طلب السلفة', 400, 'VALIDATION_ERROR');
  }

  const employee = input.employeeId
    ? await prisma.employeeProfile.findUnique({ where: { id: input.employeeId } })
    : await employeeForUser(actor.id);
  if (!employee) throw new AppError('الموظف غير موجود', 404, 'NOT_FOUND');

  // Filing on someone else's behalf is a manager action, and a branch manager is
  // only a manager inside their own branch.
  const onBehalf = employee.userId !== actor.id;
  const actorRunsThisBranch = await isBranchManagerOf(actor, employee.locationId);
  if (onBehalf && !actorRunsThisBranch && !isHrStaff(actor)) {
    throw new ForbiddenError(
      actor.role === UserRole.BRANCH_MANAGER
        ? 'يمكنك تقديم طلبات لموظفي فرعك فقط'
        : 'لا يمكنك تقديم طلب نيابة عن موظف آخر',
      'ACCESS_DENIED',
    );
  }

  if (isResigned(employee)) {
    throw new AppError('الموظف غير على رأس العمل — لا يمكن طلب سلفة', 400, 'ACTION_ERROR');
  }

  const state = initialRequestState({
    onBehalf,
    actorIsBranchManager: actorRunsThisBranch,
    actorIsHrStaff: isHrStaff(actor),
  });

  // Nothing may sit in a branch queue that nobody can reach. Rather than strand
  // the request, refuse it and say why — HR sets «مدير الفرع» in settings.
  if (state === AdvanceRequestState.pending_branch) {
    const manager = await resolveBranchManager(employee.locationId);
    if (!manager?.userId) {
      throw new AppError(
        'فرعك ليس له مدير معتمد على النظام — راجع الموارد البشرية',
        400,
        'NO_BRANCH_MANAGER',
      );
    }
  }

  const settings = await getAdvanceSettings();
  const eligibility = await computeAdvanceEligibility({ employeeId: employee.id });

  if (!eligibility.isEligible && settings.enforceLimit) {
    throw new AppError(
      `غير مستحق للسلفة — أيام العمل الفعلية (${eligibility.actualWorkingDays}) أقل من الحد (${eligibility.minimumWorkingDays})`,
      400,
      'NOT_ELIGIBLE',
    );
  }
  // Requests are always held to the limit; HR can still override at approval time.
  if (amount > eligibility.availableAmount + 0.009) {
    throw new AppError(
      `المبلغ يتجاوز المتاح (${eligibility.availableAmount}) — الحد الأقصى ${eligibility.maxEligibleAmount}`,
      400,
      'LIMIT_EXCEEDED',
    );
  }

  // Record who cleared the branch step when the submitter runs the branch.
  const branchSatisfied = onBehalf && actorRunsThisBranch;

  return prisma.advanceRequest.create({
    data: {
      employeeId: employee.id,
      requestedById: actor.id,
      locationId: employee.locationId,
      amount,
      reason,
      state,
      branchApprovedById: branchSatisfied ? actor.id : null,
      branchApprovedAt: branchSatisfied ? new Date() : null,
      eligibilityPercent: eligibility.percentUsed,
      maxEligibleAtRequest: eligibility.maxEligibleAmount,
      availableAtRequest: eligibility.availableAmount,
      actualWorkingDaysAtRequest: eligibility.actualWorkingDays,
    },
    include: REQUEST_INCLUDE,
  });
}

export async function listMyAdvanceRequests(userId: string) {
  const employee = await employeeForUser(userId);
  return prisma.advanceRequest.findMany({
    where: { employeeId: employee.id },
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * The approval queue, scoped to what the caller may act on: branch managers see
 * their own branch waiting on them, HR sees everything already cleared by a branch.
 */
export async function listAdvanceRequestQueue(
  actor: Actor,
  filter: { state?: string | null; locationId?: string | null } = {},
) {
  const where: Record<string, unknown> = {};

  if (isHrStaff(actor)) {
    if (filter.locationId) where.locationId = filter.locationId;
  } else {
    // Anyone else only reaches the queue by running a branch, whatever their role
    // says — most designated managers are plain EMPLOYEE accounts.
    const managed = await locationsManagedBy(actor.id);
    if (actor.role === UserRole.BRANCH_MANAGER && actor.locationId) {
      if (!managed.includes(actor.locationId)) managed.push(actor.locationId);
    }
    if (!managed.length) throw new ForbiddenError('غير مصرح', 'ACCESS_DENIED');
    where.locationId = filter.locationId && managed.includes(filter.locationId)
      ? filter.locationId
      : { in: managed };
  }

  const state = (filter.state ?? '').trim();
  if (state && state !== 'all') {
    if (!(state in AdvanceRequestState)) {
      throw new AppError('حالة غير معروفة', 400, 'VALIDATION_ERROR');
    }
    where.state = state as AdvanceRequestState;
  } else if (!state) {
    where.state = {
      in: [AdvanceRequestState.pending_branch, AdvanceRequestState.pending_hr],
    };
  }

  return prisma.advanceRequest.findMany({
    where,
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

async function loadForAction(id: string) {
  const request = await prisma.advanceRequest.findUnique({
    where: { id },
    include: REQUEST_INCLUDE,
  });
  if (!request) throw new AppError('الطلب غير موجود', 404, 'NOT_FOUND');
  return request;
}

/**
 * Who may act on a request at the branch step: the person who runs that branch,
 * or HR stepping in. Nobody clears their own request.
 */
async function assertMayActForBranch(
  actor: Actor,
  request: { locationId: string | null; employeeId: string },
) {
  if (isHrStaff(actor)) return;
  if (!(await isBranchManagerOf(actor, request.locationId))) {
    throw new ForbiddenError('الطلب خارج نطاق فرعك', 'ACCESS_DENIED');
  }
  const own = await prisma.employeeProfile.findFirst({
    where: { userId: actor.id },
    select: { id: true },
  });
  if (own?.id === request.employeeId) {
    throw new ForbiddenError('لا يمكنك الموافقة على طلبك بنفسك', 'ACCESS_DENIED');
  }
}

/** Branch manager step — moves the request into the HR queue. */
export async function branchApproveAdvanceRequest(actor: Actor, id: string) {
  const request = await loadForAction(id);
  await assertMayActForBranch(actor, request);
  if (request.state !== AdvanceRequestState.pending_branch) {
    throw new AppError('الطلب لم يعد في انتظار موافقة الفرع', 400, 'ACTION_ERROR');
  }
  return prisma.advanceRequest.update({
    where: { id },
    data: {
      state: AdvanceRequestState.pending_hr,
      branchApprovedById: actor.id,
      branchApprovedAt: new Date(),
      rejectionReason: null,
      rejectedById: null,
    },
    include: REQUEST_INCLUDE,
  });
}

/**
 * HR approval — the only step that moves money. Creating the `AdvanceShort`
 * re-checks the entitlement (the request may have sat in the queue for weeks),
 * ignoring this request's own reservation.
 */
export async function hrApproveAdvanceRequest(
  actor: Actor,
  input: { id: string; amount?: number | null; limitOverride?: boolean; overrideReason?: string | null },
) {
  if (!isHrApprover(actor)) {
    throw new ForbiddenError('اعتماد السلف يتطلب صلاحية مدير الموارد البشرية', 'ACCESS_DENIED');
  }
  const request = await loadForAction(input.id);
  if (request.state !== AdvanceRequestState.pending_hr) {
    if (request.state === AdvanceRequestState.pending_branch) {
      throw new AppError('الطلب في انتظار موافقة مدير الفرع أولًا', 400, 'ACTION_ERROR');
    }
    throw new AppError('الطلب غير معلّق', 400, 'ACTION_ERROR');
  }

  const amount =
    input.amount != null && Number.isFinite(Number(input.amount))
      ? round2(Number(input.amount))
      : round2(request.amount);
  if (amount <= 0) {
    throw new AppError('قيمة السلفة يجب أن تكون أكبر من صفر', 400, 'VALIDATION_ERROR');
  }

  const advance = await createShortAdvance({
    employeeId: request.employeeId,
    amount,
    notes: `طلب سلفة: ${request.reason}`,
    limitOverride: input.limitOverride,
    overrideReason: input.overrideReason,
    excludeRequestId: request.id,
  });

  return prisma.advanceRequest.update({
    where: { id: request.id },
    data: {
      state: AdvanceRequestState.approved,
      amount,
      hrApprovedById: actor.id,
      hrApprovedAt: new Date(),
      advanceShortId: advance.id,
      limitOverride: Boolean(input.limitOverride),
      overrideReason: input.limitOverride ? (input.overrideReason?.trim() || null) : null,
      rejectionReason: null,
      rejectedById: null,
    },
    include: REQUEST_INCLUDE,
  });
}

export async function rejectAdvanceRequest(actor: Actor, id: string, reason: string) {
  const trimmed = String(reason ?? '').trim();
  if (!trimmed) throw new AppError('اكتب سبب الرفض', 400, 'VALIDATION_ERROR');

  const request = await loadForAction(id);
  if (!isPendingRequestState(request.state)) {
    throw new AppError('الطلب غير معلّق', 400, 'ACTION_ERROR');
  }

  if (isHrApprover(actor)) {
    // HR may turn a request down at either step.
  } else {
    await assertMayActForBranch(actor, request);
    if (request.state !== AdvanceRequestState.pending_branch) {
      throw new ForbiddenError('الطلب انتقل إلى الموارد البشرية', 'ACCESS_DENIED');
    }
  }

  return prisma.advanceRequest.update({
    where: { id },
    data: {
      state: AdvanceRequestState.rejected,
      rejectedById: actor.id,
      rejectionReason: trimmed,
    },
    include: REQUEST_INCLUDE,
  });
}

/** The requester withdrawing their own request while nobody has acted on it yet. */
export async function cancelAdvanceRequest(actor: Actor, id: string) {
  const request = await loadForAction(id);
  if (!isPendingRequestState(request.state)) {
    throw new AppError('الطلب غير معلّق', 400, 'ACTION_ERROR');
  }

  const ownProfile = await prisma.employeeProfile.findFirst({ where: { userId: actor.id } });
  const isOwner = request.requestedById === actor.id || ownProfile?.id === request.employeeId;
  if (!isOwner && !isHrApprover(actor)) {
    throw new ForbiddenError('يمكن لصاحب الطلب أو الموارد البشرية فقط إلغاؤه', 'ACCESS_DENIED');
  }

  return prisma.advanceRequest.update({
    where: { id },
    data: { state: AdvanceRequestState.cancelled },
    include: REQUEST_INCLUDE,
  });
}

export { advanceEligibilityJson };
