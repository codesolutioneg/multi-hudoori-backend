import {
  SalesRequestActivityKind,
  SalesRequestSource,
  SalesRequestStatus,
  SubscriptionPlanStatus,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { prismaBase } from '../prisma/client';
import { createCompany } from './company.service';
import { getPlanById } from './subscriptionPlan.service';
import { applyPlanSnapshotToCompany } from './companyEntitlements.service';
import { sendRegistrationSuccessEmail } from './mail.service';

const COMPANY_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE = /^[\d+\s()-]{7,20}$/;

export function normalizeCompanyCode(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateCompanyCode(code: string): string | null {
  const c = normalizeCompanyCode(code);
  if (!c) return 'معرف الشركة مطلوب';
  if (!COMPANY_CODE_RE.test(c)) {
    return 'معرف الشركة: حروف إنجليزية صغيرة وأرقام و _ - فقط (٢–٦٣ حرف)';
  }
  if (c === 'demo') return 'معرف demo محجوز للتجربة';
  return null;
}

function validateEmail(email: string): string | null {
  const e = email.trim();
  if (!e) return 'البريد الإلكتروني مطلوب';
  if (!EMAIL_RE.test(e)) return 'البريد الإلكتروني غير صالح';
  return null;
}

function validatePhone(phone: string): string | null {
  const p = phone.trim();
  if (!p) return 'رقم الهاتف مطلوب';
  if (!PHONE_RE.test(p)) return 'رقم الهاتف غير صالح';
  return null;
}

export type CreateSalesRequestInput = {
  companyCode: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  requestedEmployees: number;
  planId?: string | null;
  notes?: string | null;
};

export async function assertCodeAvailableForRequest(code: string, exceptRequestId?: string): Promise<void> {
  const normalized = normalizeCompanyCode(code);
  const [company, pending] = await Promise.all([
    prismaBase.company.findFirst({ where: { code: { equals: normalized, mode: 'insensitive' } } }),
    prismaBase.salesRequest.findFirst({
      where: {
        companyCode: normalized,
        status: SalesRequestStatus.PENDING,
        ...(exceptRequestId ? { NOT: { id: exceptRequestId } } : {}),
      },
    }),
  ]);
  if (company) {
    throw Object.assign(new Error('معرف الشركة مستخدم بالفعل'), { errorCode: 'DUPLICATE' });
  }
  if (pending) {
    throw Object.assign(new Error('يوجد طلب قيد المراجعة بنفس معرف الشركة'), { errorCode: 'DUPLICATE' });
  }
}

export async function createSalesRequest(input: CreateSalesRequestInput) {
  const companyCode = normalizeCompanyCode(input.companyCode);
  const errCode = validateCompanyCode(companyCode);
  if (errCode) throw Object.assign(new Error(errCode), { errorCode: 'VALIDATION_ERROR' });
  const errEmail = validateEmail(input.email);
  if (errEmail) throw Object.assign(new Error(errEmail), { errorCode: 'VALIDATION_ERROR' });
  const errPhone = validatePhone(input.phone);
  if (errPhone) throw Object.assign(new Error(errPhone), { errorCode: 'VALIDATION_ERROR' });

  const companyName = input.companyName.trim();
  const contactName = input.contactName.trim();
  if (!companyName || !contactName) {
    throw Object.assign(new Error('اسم الشركة واسم المسؤول مطلوبان'), { errorCode: 'VALIDATION_ERROR' });
  }

  const requestedEmployees = Number(input.requestedEmployees);
  if (!Number.isInteger(requestedEmployees) || requestedEmployees < 1) {
    throw Object.assign(new Error('عدد الموظفين يجب أن يكون عدداً صحيحاً أكبر من صفر'), {
      errorCode: 'VALIDATION_ERROR',
    });
  }

  if (input.planId) {
    const plan = await getPlanById(input.planId);
    if (!plan || plan.status !== SubscriptionPlanStatus.PUBLISHED) {
      throw Object.assign(new Error('الباقة المختارة غير متاحة'), { errorCode: 'VALIDATION_ERROR' });
    }
  }

  await assertCodeAvailableForRequest(companyCode);

  return insertSalesRequest({
    companyCode,
    companyName,
    contactName,
    email: input.email.trim().toLowerCase(),
    phone: input.phone.trim(),
    requestedEmployees,
    planId: input.planId?.trim() || null,
    notes: input.notes?.trim() || null,
    source: SalesRequestSource.LANDING,
    landingNote: 'طلب من صفحة الهبوط',
  });
}

const salesRequestInclude = {
  plan: true,
  createdCompany: { select: { id: true, code: true, name: true } },
  ownerUser: { select: { id: true, name: true, login: true } },
  activities: {
    orderBy: { createdAt: 'desc' as const },
    include: { actorUser: { select: { id: true, name: true, login: true } } },
  },
};

async function insertSalesRequest(data: {
  companyCode: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  requestedEmployees: number;
  planId: string | null;
  notes: string | null;
  source: SalesRequestSource;
  ownerUserId?: string | null;
  nextFollowUpAt?: Date | null;
  landingNote?: string | null;
  manualNote?: string | null;
  actorUserId?: string | null;
}) {
  const row = await prismaBase.salesRequest.create({
    data: {
      companyCode,
      companyName,
      contactName,
      email: input.email.trim().toLowerCase(),
      phone: input.phone.trim(),
      requestedEmployees,
      planId: data.planId,
      notes: data.notes,
      source: data.source,
      ownerUserId: data.ownerUserId ?? null,
      nextFollowUpAt: data.nextFollowUpAt ?? null,
    },
  });
  if (data.landingNote) {
    await logActivity({
      salesRequestId: row.id,
      kind: SalesRequestActivityKind.NOTE,
      body: data.landingNote,
      actorUserId: null,
    });
  }
  if (data.manualNote) {
    await logActivity({
      salesRequestId: row.id,
      kind: SalesRequestActivityKind.NOTE,
      body: data.manualNote,
      actorUserId: data.actorUserId ?? null,
    });
  }
  return getSalesRequest(row.id);
}

export async function listSalesRequests(status?: SalesRequestStatus) {
  const rows = await prismaBase.salesRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    include: {
      plan: true,
      createdCompany: { select: { id: true, code: true, name: true } },
      ownerUser: { select: { id: true, name: true, login: true } },
    },
  });
  return rows;
}

export async function getSalesRequest(id: string) {
  return prismaBase.salesRequest.findUnique({
    where: { id },
    include: salesRequestInclude,
  });
}

export async function getSalesRequestAnalytics() {
  const [byStatus, byPlan, total] = await Promise.all([
    prismaBase.salesRequest.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    prismaBase.salesRequest.groupBy({
      by: ['planId'],
      _count: { _all: true },
      where: { status: SalesRequestStatus.PENDING },
    }),
    prismaBase.salesRequest.count(),
  ]);
  const statusCounts = Object.fromEntries(
    byStatus.map((r) => [r.status, r._count._all]),
  ) as Record<string, number>;
  const planCounts = byPlan.map((r) => ({ planId: r.planId, count: r._count._all }));
  return { total, statusCounts, planCounts };
}

async function logActivity(input: {
  salesRequestId: string;
  kind: SalesRequestActivityKind;
  body?: string | null;
  fromStatus?: SalesRequestStatus | null;
  toStatus?: SalesRequestStatus | null;
  actorUserId?: string | null;
}) {
  await prismaBase.salesRequestActivity.create({
    data: {
      salesRequestId: input.salesRequestId,
      kind: input.kind,
      body: input.body?.trim() || null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      actorUserId: input.actorUserId ?? null,
    },
  });
}

export type CreateManualSalesRequestInput = CreateSalesRequestInput & {
  ownerUserId?: string | null;
  nextFollowUpAt?: string | Date | null;
};

export async function createManualSalesRequest(input: CreateManualSalesRequestInput, actorUserId: string) {
  const companyCode = normalizeCompanyCode(input.companyCode);
  const errCode = validateCompanyCode(companyCode);
  if (errCode) throw Object.assign(new Error(errCode), { errorCode: 'VALIDATION_ERROR' });
  const errEmail = validateEmail(input.email);
  if (errEmail) throw Object.assign(new Error(errEmail), { errorCode: 'VALIDATION_ERROR' });
  const errPhone = validatePhone(input.phone);
  if (errPhone) throw Object.assign(new Error(errPhone), { errorCode: 'VALIDATION_ERROR' });
  const companyName = input.companyName.trim();
  const contactName = input.contactName.trim();
  if (!companyName || !contactName) {
    throw Object.assign(new Error('اسم الشركة واسم المسؤول مطلوبان'), { errorCode: 'VALIDATION_ERROR' });
  }
  const requestedEmployees = Number(input.requestedEmployees);
  if (!Number.isInteger(requestedEmployees) || requestedEmployees < 1) {
    throw Object.assign(new Error('عدد الموظفين يجب أن يكون عدداً صحيحاً أكبر من صفر'), {
      errorCode: 'VALIDATION_ERROR',
    });
  }
  if (input.planId) {
    const plan = await getPlanById(input.planId);
    if (!plan || plan.status !== SubscriptionPlanStatus.PUBLISHED) {
      throw Object.assign(new Error('الباقة المختارة غير متاحة'), { errorCode: 'VALIDATION_ERROR' });
    }
  }
  await assertCodeAvailableForRequest(companyCode);
  return insertSalesRequest({
    companyCode,
    companyName,
    contactName,
    email: input.email.trim().toLowerCase(),
    phone: input.phone.trim(),
    requestedEmployees,
    planId: input.planId?.trim() || null,
    notes: input.notes?.trim() || null,
    source: SalesRequestSource.MANUAL,
    ownerUserId: input.ownerUserId?.trim() || actorUserId,
    nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null,
    manualNote: 'إنشاء يدوي من لوحة المنصة',
    actorUserId,
  });
}

export async function addSalesRequestNote(id: string, body: string, actorUserId: string) {
  const row = await getSalesRequest(id);
  if (!row) throw Object.assign(new Error('الطلب غير موجود'), { errorCode: 'NOT_FOUND' });
  await logActivity({
    salesRequestId: id,
    kind: SalesRequestActivityKind.NOTE,
    body,
    actorUserId,
  });
  return getSalesRequest(id);
}

function randomPassword(): string {
  const base = randomBytes(9).toString('base64url');
  return `Hd${base}!9`;
}

function resolveMaxEmployees(requested: number, _planMax: number | null | undefined): number {
  // Admin-edited requestedEmployees is the authoritative seat quota on approve.
  return requested;
}

export type UpdateSalesRequestInput = {
  companyCode?: string;
  companyName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  requestedEmployees?: number;
  planId?: string | null;
  notes?: string | null;
};

export type CrmPatchInput = UpdateSalesRequestInput & {
  ownerUserId?: string | null;
  nextFollowUpAt?: string | Date | null;
};

export async function updateSalesRequest(id: string, input: CrmPatchInput) {
  const row = await getSalesRequest(id);
  if (!row) throw Object.assign(new Error('الطلب غير موجود'), { errorCode: 'NOT_FOUND' });
  if (row.status !== SalesRequestStatus.PENDING) {
    throw Object.assign(new Error('يمكن تعديل الطلبات قيد المراجعة فقط'), { errorCode: 'VALIDATION_ERROR' });
  }

  const data: Record<string, unknown> = {};

  if (input.companyCode != null) {
    const companyCode = normalizeCompanyCode(input.companyCode);
    const errCode = validateCompanyCode(companyCode);
    if (errCode) throw Object.assign(new Error(errCode), { errorCode: 'VALIDATION_ERROR' });
    await assertCodeAvailableForRequest(companyCode, id);
    data.companyCode = companyCode;
  }
  if (input.companyName != null) {
    const companyName = input.companyName.trim();
    if (!companyName) throw Object.assign(new Error('اسم الشركة مطلوب'), { errorCode: 'VALIDATION_ERROR' });
    data.companyName = companyName;
  }
  if (input.contactName != null) {
    const contactName = input.contactName.trim();
    if (!contactName) throw Object.assign(new Error('اسم المسؤول مطلوب'), { errorCode: 'VALIDATION_ERROR' });
    data.contactName = contactName;
  }
  if (input.email != null) {
    const errEmail = validateEmail(input.email);
    if (errEmail) throw Object.assign(new Error(errEmail), { errorCode: 'VALIDATION_ERROR' });
    data.email = input.email.trim().toLowerCase();
  }
  if (input.phone != null) {
    const errPhone = validatePhone(input.phone);
    if (errPhone) throw Object.assign(new Error(errPhone), { errorCode: 'VALIDATION_ERROR' });
    data.phone = input.phone.trim();
  }
  if (input.requestedEmployees != null) {
    const requestedEmployees = Number(input.requestedEmployees);
    if (!Number.isInteger(requestedEmployees) || requestedEmployees < 1) {
      throw Object.assign(new Error('عدد الموظفين يجب أن يكون عدداً صحيحاً أكبر من صفر'), {
        errorCode: 'VALIDATION_ERROR',
      });
    }
    data.requestedEmployees = requestedEmployees;
  }
  if (input.planId !== undefined) {
    if (input.planId) {
      const plan = await getPlanById(input.planId);
      if (!plan || plan.status !== SubscriptionPlanStatus.PUBLISHED) {
        throw Object.assign(new Error('الباقة المختارة غير متاحة'), { errorCode: 'VALIDATION_ERROR' });
      }
      data.planId = input.planId;
    } else {
      data.planId = null;
    }
  }
  if (input.notes !== undefined) {
    data.notes = input.notes?.trim() || null;
  }
  if (input.ownerUserId !== undefined) {
    data.ownerUserId = input.ownerUserId?.trim() || null;
  }
  if (input.nextFollowUpAt !== undefined) {
    data.nextFollowUpAt =
      input.nextFollowUpAt == null || input.nextFollowUpAt === ''
        ? null
        : new Date(input.nextFollowUpAt);
  }

  await prismaBase.salesRequest.update({ where: { id }, data });
  return getSalesRequest(id);
}

export async function approveSalesRequest(id: string, reviewerUserId: string) {
  const row = await getSalesRequest(id);
  if (!row) throw Object.assign(new Error('الطلب غير موجود'), { errorCode: 'NOT_FOUND' });
  if (row.status !== SalesRequestStatus.PENDING) {
    throw Object.assign(new Error('الطلب ليس قيد المراجعة'), { errorCode: 'VALIDATION_ERROR' });
  }

  await assertCodeAvailableForRequest(row.companyCode, id);

  const plan = row.planId ? await getPlanById(row.planId) : null;
  const maxEmployees = resolveMaxEmployees(row.requestedEmployees, plan?.defaultMaxEmployees);
  const maxUsers = plan?.defaultMaxUsers ?? 5;
  const password = randomPassword();
  const planName = plan ? `${plan.nameAr} / ${plan.nameEn}` : undefined;

  const { company, hrManager } = await createCompany({
    code: row.companyCode,
    name: row.companyName,
    maxEmployees,
    maxUsers,
    hrManagerName: row.contactName,
    hrManagerLogin: row.email,
    hrManagerPassword: password,
  });

  if (plan) {
    await applyPlanSnapshotToCompany(company.id, {
      id: plan.id,
      nameAr: plan.nameAr,
      nameEn: plan.nameEn,
      featureKeys: plan.featureKeys,
    });
  }

  const mail = await sendRegistrationSuccessEmail({
    name: row.contactName,
    login: row.email,
    email: row.email,
    password,
    companyCode: company.code,
    companyName: company.name,
    phone: row.phone,
    maxEmployees,
    planName,
  });

  const updated = await prismaBase.salesRequest.update({
    where: { id },
    data: {
      status: SalesRequestStatus.APPROVED,
      createdCompanyId: company.id,
      reviewedAt: new Date(),
      reviewedByUserId: reviewerUserId,
    },
  });
  await logActivity({
    salesRequestId: id,
    kind: SalesRequestActivityKind.STATUS_CHANGE,
    fromStatus: SalesRequestStatus.PENDING,
    toStatus: SalesRequestStatus.APPROVED,
    actorUserId: reviewerUserId,
    body: 'تمت الموافقة وإنشاء الشركة',
  });

  return { request: await getSalesRequest(updated.id), company, hrManager, mail };
}

export async function rejectSalesRequest(id: string, reviewerUserId: string, reason?: string) {
  const row = await getSalesRequest(id);
  if (!row) throw Object.assign(new Error('الطلب غير موجود'), { errorCode: 'NOT_FOUND' });
  if (row.status !== SalesRequestStatus.PENDING) {
    throw Object.assign(new Error('الطلب ليس قيد المراجعة'), { errorCode: 'VALIDATION_ERROR' });
  }
  await prismaBase.salesRequest.update({
    where: { id },
    data: {
      status: SalesRequestStatus.REJECTED,
      rejectionReason: reason?.trim() || null,
      reviewedAt: new Date(),
      reviewedByUserId: reviewerUserId,
    },
  });
  await logActivity({
    salesRequestId: id,
    kind: SalesRequestActivityKind.STATUS_CHANGE,
    fromStatus: SalesRequestStatus.PENDING,
    toStatus: SalesRequestStatus.REJECTED,
    actorUserId: reviewerUserId,
    body: reason?.trim() || 'مرفوض',
  });
  return getSalesRequest(id);
}
