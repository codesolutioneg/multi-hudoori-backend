/**
 * Field mission requests («طلب مأمورية»).
 *
 * Employee (or branch manager on behalf) files details + date range →
 * branch manager approves → shift-grid days marked isFieldMission (no Transaction).
 * While approved for Cairo “today”, mobile GPS punch skips home-branch geofence.
 */
import { FieldMissionRequestState, UserRole, type Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, ForbiddenError } from '../utils/errors';
import { cairoDateOnly } from '../utils/payrollPeriod';
import { enumerateUtcDates } from './payrollCycleGuard.service';
import { assertEmployeeGridCoverage } from './requestFulfillment.service';
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

function isHrStaff(actor: Actor): boolean {
  return HR_ROLES.includes(actor.role);
}

function isHrManager(actor: Actor): boolean {
  return actor.role === UserRole.HR_MANAGER || actor.role === UserRole.PLATFORM_ADMIN;
}

export async function employeeForUser(userId: string) {
  const profile = await prisma.employeeProfile.findFirst({ where: { userId } });
  if (!profile) throw new ForbiddenError('لا يوجد ملف موظف مرتبط بالحساب', 'ACCESS_DENIED');
  return profile;
}

const REQUEST_INCLUDE = {
  employee: { select: { id: true, name: true, code: true, locationId: true } },
  location: { select: { id: true, name: true } },
} as const;

type RequestRow = Prisma.FieldMissionRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

export function fieldMissionRequestJson(r: RequestRow) {
  return {
    id: r.id,
    employeeId: r.employeeId,
    employeeName: r.employee?.name ?? null,
    employeeCode: r.employee?.code ?? null,
    requestedById: r.requestedById,
    locationId: r.locationId,
    locationName: r.location?.name ?? null,
    details: r.details,
    dateFrom: r.dateFrom.toISOString().slice(0, 10),
    dateTo: r.dateTo.toISOString().slice(0, 10),
    state: r.state,
    branchApprovedById: r.branchApprovedById,
    branchApprovedAt: r.branchApprovedAt?.toISOString() ?? null,
    rejectedById: r.rejectedById,
    rejectionReason: r.rejectionReason,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function parseDay(raw: unknown, field: string): Date {
  const s = String(raw ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new AppError(`${field} غير صالح`, 400, 'VALIDATION_ERROR');
  }
  return new Date(`${s}T00:00:00.000Z`);
}

async function findGridForEmployeeDay(employeeId: string, day: Date) {
  const grids = await prisma.shiftGrid.findMany({
    where: {
      dateFrom: { lte: day },
      dateTo: { gte: day },
      OR: [
        { employeeIds: { has: employeeId } },
        { lines: { some: { employeeId, date: day } } },
      ],
    },
    orderBy: [{ dateTo: 'desc' }, { createdAt: 'desc' }],
    take: 1,
  });
  return grids[0] ?? null;
}

async function markMissionDays(opts: {
  companyId: string;
  employeeId: string;
  missionId: string;
  dateFrom: Date;
  dateTo: Date;
}) {
  const days = enumerateUtcDates(opts.dateFrom, opts.dateTo);
  await assertEmployeeGridCoverage(opts.employeeId, days);

  for (const day of days) {
    const grid = await findGridForEmployeeDay(opts.employeeId, day);
    if (!grid) {
      throw new AppError(
        'لا يوجد جدول شيفت يغطي أيام المأمورية — أنشئ الجدول أولاً',
        400,
        'NO_GRID_COVERAGE',
      );
    }

    const existing = await prisma.shiftGridLine.findUnique({
      where: {
        gridId_employeeId_date: {
          gridId: grid.id,
          employeeId: opts.employeeId,
          date: day,
        },
      },
    });

    if (existing) {
      await prisma.shiftGridLine.update({
        where: { id: existing.id },
        data: {
          isFieldMission: true,
          fieldMissionRequestId: opts.missionId,
        },
      });
    } else {
      await prisma.shiftGridLine.create({
        data: {
          companyId: opts.companyId,
          gridId: grid.id,
          employeeId: opts.employeeId,
          date: day,
          isFieldMission: true,
          fieldMissionRequestId: opts.missionId,
        },
      });
      if (!grid.employeeIds.includes(opts.employeeId)) {
        await prisma.shiftGrid.update({
          where: { id: grid.id },
          data: { employeeIds: { push: opts.employeeId } },
        });
      }
    }
  }
}

async function clearMissionDays(missionId: string, employeeId: string) {
  const lines = await prisma.shiftGridLine.findMany({
    where: { fieldMissionRequestId: missionId },
  });
  for (const line of lines) {
    const dayStart = line.date;
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
    const punched = await prisma.transaction.count({
      where: {
        employeeId,
        punchSource: 'mobile_geo',
        isDuplicate: false,
        punchTime: { gte: dayStart, lt: dayEnd },
      },
    });
    if (punched > 0) {
      throw new AppError(
        'لا يمكن إلغاء تمييز أيام فيها بصمات GPS للمأمورية',
        400,
        'MISSION_HAS_PUNCHES',
      );
    }
  }
  await prisma.shiftGridLine.updateMany({
    where: { fieldMissionRequestId: missionId },
    data: { isFieldMission: false, fieldMissionRequestId: null },
  });
}

export async function createFieldMissionRequest(
  actor: Actor,
  input: {
    employeeId?: string | null;
    details: string;
    dateFrom: unknown;
    dateTo: unknown;
  },
) {
  const details = String(input.details ?? '').trim();
  if (details.length < 3) {
    throw new AppError('اكتب تفاصيل المأمورية', 400, 'VALIDATION_ERROR');
  }
  const dateFrom = parseDay(input.dateFrom, 'تاريخ البداية');
  const dateTo = parseDay(input.dateTo, 'تاريخ النهاية');
  if (dateTo < dateFrom) {
    throw new AppError('تاريخ النهاية قبل تاريخ البداية', 400, 'VALIDATION_ERROR');
  }

  const employee = input.employeeId
    ? await prisma.employeeProfile.findUnique({ where: { id: input.employeeId } })
    : await employeeForUser(actor.id);
  if (!employee) throw new AppError('الموظف غير موجود', 404, 'NOT_FOUND');

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
    throw new AppError('الموظف غير على رأس العمل', 400, 'ACTION_ERROR');
  }

  // Branch manager (self or on behalf) or HR filing → approve immediately.
  const autoApprove = actorRunsThisBranch || (onBehalf && isHrStaff(actor));
  if (!autoApprove) {
    const manager = await resolveBranchManager(employee.locationId);
    if (!manager?.userId) {
      throw new AppError(
        'فرعك ليس له مدير معتمد على النظام — راجع الموارد البشرية',
        400,
        'NO_BRANCH_MANAGER',
      );
    }
  }

  const created = await prisma.fieldMissionRequest.create({
    data: {
      employeeId: employee.id,
      requestedById: actor.id,
      locationId: employee.locationId,
      details,
      dateFrom,
      dateTo,
      state: autoApprove
        ? FieldMissionRequestState.approved
        : FieldMissionRequestState.pending_branch,
      branchApprovedById: autoApprove ? actor.id : null,
      branchApprovedAt: autoApprove ? new Date() : null,
    },
    include: REQUEST_INCLUDE,
  });

  if (autoApprove) {
    await markMissionDays({
      companyId: employee.companyId,
      employeeId: employee.id,
      missionId: created.id,
      dateFrom,
      dateTo,
    });
  }

  return created;
}

export async function listMyFieldMissionRequests(userId: string) {
  const employee = await employeeForUser(userId);
  return prisma.fieldMissionRequest.findMany({
    where: { employeeId: employee.id },
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

export async function listFieldMissionRequestQueue(
  actor: Actor,
  filter: { state?: string | null; locationId?: string | null } = {},
) {
  const where: Prisma.FieldMissionRequestWhereInput = {};

  if (isHrStaff(actor)) {
    if (filter.locationId) where.locationId = filter.locationId;
  } else {
    const managed = await locationsManagedBy(actor.id);
    if (actor.role === UserRole.BRANCH_MANAGER && actor.locationId) {
      if (!managed.includes(actor.locationId)) managed.push(actor.locationId);
    }
    if (!managed.length) throw new ForbiddenError('غير مصرح', 'ACCESS_DENIED');
    where.locationId =
      filter.locationId && managed.includes(filter.locationId)
        ? filter.locationId
        : { in: managed };
  }

  const state = (filter.state ?? '').trim();
  if (state && state !== 'all') {
    if (!(state in FieldMissionRequestState)) {
      throw new AppError('حالة غير معروفة', 400, 'VALIDATION_ERROR');
    }
    where.state = state as FieldMissionRequestState;
  } else if (!state) {
    where.state = FieldMissionRequestState.pending_branch;
  }

  return prisma.fieldMissionRequest.findMany({
    where,
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

async function loadForAction(id: string) {
  const request = await prisma.fieldMissionRequest.findUnique({
    where: { id },
    include: REQUEST_INCLUDE,
  });
  if (!request) throw new AppError('الطلب غير موجود', 404, 'NOT_FOUND');
  return request;
}

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

export async function branchApproveFieldMissionRequest(actor: Actor, id: string) {
  const request = await loadForAction(id);
  await assertMayActForBranch(actor, request);
  if (request.state !== FieldMissionRequestState.pending_branch) {
    throw new AppError('الطلب لم يعد في انتظار موافقة الفرع', 400, 'ACTION_ERROR');
  }

  const employee = await prisma.employeeProfile.findUnique({
    where: { id: request.employeeId },
    select: { id: true, companyId: true },
  });
  if (!employee) throw new AppError('الموظف غير موجود', 404, 'NOT_FOUND');

  await markMissionDays({
    companyId: employee.companyId,
    employeeId: employee.id,
    missionId: request.id,
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
  });

  return prisma.fieldMissionRequest.update({
    where: { id },
    data: {
      state: FieldMissionRequestState.approved,
      branchApprovedById: actor.id,
      branchApprovedAt: new Date(),
      rejectionReason: null,
      rejectedById: null,
    },
    include: REQUEST_INCLUDE,
  });
}

export async function rejectFieldMissionRequest(actor: Actor, id: string, reason: string) {
  const trimmed = String(reason ?? '').trim();
  if (!trimmed) throw new AppError('اكتب سبب الرفض', 400, 'VALIDATION_ERROR');

  const request = await loadForAction(id);
  if (request.state !== FieldMissionRequestState.pending_branch) {
    throw new AppError('الطلب غير معلّق عند الفرع', 400, 'ACTION_ERROR');
  }
  await assertMayActForBranch(actor, request);

  return prisma.fieldMissionRequest.update({
    where: { id },
    data: {
      state: FieldMissionRequestState.rejected,
      rejectedById: actor.id,
      rejectionReason: trimmed,
    },
    include: REQUEST_INCLUDE,
  });
}

export async function cancelFieldMissionRequest(actor: Actor, id: string) {
  const request = await loadForAction(id);
  const ownProfile = await prisma.employeeProfile.findFirst({ where: { userId: actor.id } });
  const isOwner = request.requestedById === actor.id || ownProfile?.id === request.employeeId;

  if (request.state === FieldMissionRequestState.pending_branch) {
    if (!isOwner && !isHrManager(actor)) {
      throw new ForbiddenError('يمكن لصاحب الطلب أو الموارد البشرية فقط إلغاؤه', 'ACCESS_DENIED');
    }
    return prisma.fieldMissionRequest.update({
      where: { id },
      data: { state: FieldMissionRequestState.cancelled },
      include: REQUEST_INCLUDE,
    });
  }

  if (request.state === FieldMissionRequestState.approved) {
    if (!isHrManager(actor) && !isOwner) {
      throw new ForbiddenError('غير مصرح بإلغاء مأمورية معتمدة', 'ACCESS_DENIED');
    }
    await clearMissionDays(request.id, request.employeeId);
    return prisma.fieldMissionRequest.update({
      where: { id },
      data: { state: FieldMissionRequestState.cancelled },
      include: REQUEST_INCLUDE,
    });
  }

  throw new AppError('لا يمكن إلغاء هذا الطلب', 400, 'ACTION_ERROR');
}

/** Approved mission covering Cairo calendar day for the employee (GPS geofence skip). */
export async function findApprovedMissionForEmployeeDay(employeeId: string, day: Date) {
  const d = cairoDateOnly(day);
  return prisma.fieldMissionRequest.findFirst({
    where: {
      employeeId,
      state: FieldMissionRequestState.approved,
      dateFrom: { lte: d },
      dateTo: { gte: d },
    },
    orderBy: { createdAt: 'desc' },
  });
}
