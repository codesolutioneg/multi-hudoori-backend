import type { Request } from 'express';
import { Prisma, UserRole } from '@prisma/client';
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { getCompanyId } from '../tenant/context';
import { AppError, ForbiddenError } from '../utils/errors';
import { exportFileResponse } from './payrollExport.service';

export const AUDIT_FEATURE = 'audit_log' as const;
export const ASSISTANT_FEATURE = 'help_assistant' as const;
export const EMPLOYEE_DELETE_FEATURE = 'employee_delete' as const;

export type AuditModule =
  | 'employees'
  | 'shift_grid'
  | 'advances'
  | 'payroll'
  | 'hiring'
  | 'deductions';

export type AuditActor = {
  id: string;
  login: string;
  name?: string | null;
  role?: UserRole | null;
  email?: string | null;
};

export type AuditDiffRow = {
  entityId?: string;
  entityLabel?: string;
  field?: string;
  before?: unknown;
  after?: unknown;
  note?: string;
};

export type WriteAuditInput = {
  req?: Request;
  actor?: AuditActor | null;
  module: AuditModule | string;
  action: string;
  summary: string;
  entityType?: string;
  entityId?: string;
  counts?: Record<string, unknown>;
  diffPreview?: AuditDiffRow[];
  payload?: Record<string, unknown>;
  route?: string;
};

const PREVIEW_MAX_ROWS = 200;
const PREVIEW_MAX_STR = 500;

/** Arabic labels for common audit fields (employees / grids / payroll). */
export const AUDIT_FIELD_LABELS_AR: Record<string, string> = {
  name: 'الاسم',
  active: 'نشط',
  departmentId: 'القسم',
  locationId: 'الفرع',
  jobTitle: 'المسمى الوظيفي',
  workPhone: 'هاتف العمل',
  mobilePhone: 'الموبايل',
  workEmail: 'البريد',
  birthday: 'تاريخ الميلاد',
  hiringDate: 'تاريخ التعيين',
  firstWorkDay: 'أول يوم عمل',
  basicSalary: 'الراتب الأساسي',
  bankIban: 'IBAN',
  bankName: 'البنك',
  fawryAccount: 'حساب فوري',
  hasFawryAccount: 'لديه فوري',
  insuranceNumber: 'رقم التأمين',
  insuranceStatus: 'موقف التأمين',
  insuranceCompanyId: 'شركة التأمين',
  insuranceSalary: 'أجر التأمين',
  medicalInsuranceStatus: 'موقف التأمين الطبي',
  medicalInsuranceCompanyId: 'شركة التأمين الطبي',
  medicalInsuranceSalary: 'أجر التأمين الطبي',
  nationalIdConfirm: 'الرقم القومي',
  identificationId: 'كود البصمة',
  mobileLine: 'خط الموبايل',
  shiftId: 'الشيفت',
  gridId: 'الجدول',
  dateFrom: 'من تاريخ',
  dateTo: 'إلى تاريخ',
  state: 'الحالة',
  amount: 'المبلغ',
  note: 'ملاحظة',
};

export const AUDIT_ACTION_LABELS_AR: Record<string, string> = {
  'employees.create': 'إنشاء موظف',
  'employees.update': 'تعديل موظف',
  'employees.delete': 'حذف موظف',
  'employees.archive': 'أرشفة موظف',
  'employees.restore': 'استعادة موظف',
  'employees.export': 'تصدير موظفين',
  'employees.import': 'استيراد موظفين',
  'shift_grid.create': 'إنشاء جدول شيفت',
  'shift_grid.update': 'تعديل جدول شيفت',
  'shift_grid.delete': 'حذف جدول شيفت',
  'shift_grid.export': 'تصدير جدول شيفت',
  'shift_grid.import': 'استيراد جدول شيفت',
  'shift_grid.clear_assignments': 'مسح تعيينات الجدول',
  'shift_grid.wipe_employees': 'إزالة موظفي الجدول',
  'shift_grid.create_all_locations': 'إنشاء جداول لكل الفروع',
  'advances.create': 'إنشاء سلفة',
  'advances.update': 'تعديل سلفة',
  'advances.loan_import.create': 'إنشاء استيراد سلف',
  'advances.loan_import.approve': 'اعتماد استيراد سلف',
  'advances.loan_import.delete_draft': 'حذف مسودة استيراد سلف',
  'advances.loan_import.merge_loan': 'إعادة دمج شيت السلف',
  'advances.loan_import.send_odoo_accounts': 'إرسال حسابات السلف لأودو',
  'payroll.create': 'إنشاء رواتب',
  'payroll.update': 'تعديل رواتب',
  'payroll.export': 'تصدير رواتب',
  'hiring.create': 'إنشاء تعيين',
  'hiring.update': 'تعديل تعيين',
  'hiring.approve': 'اعتماد تعيين',
  'hiring.reject': 'رفض تعيين',
  'hiring.cancel': 'إلغاء تعيين',
  'deductions.create': 'إنشاء استقطاع',
  'deductions.cancel': 'إلغاء استقطاع',
  'deductions.import': 'استيراد استقطاعات',
  'deductions.distribute': 'توزيع استقطاعات',
  'deductions.export': 'تصدير قالب استقطاعات',
};

export const AUDIT_COUNT_LABELS_AR: Record<string, string> = {
  employees: 'موظفين',
  lines: 'صفوف',
  cells: 'خلايا',
  created: 'تم إنشاؤها',
  updated: 'تم تحديثها',
  deleted: 'تم حذفها',
  skipped: 'تم تخطيها',
  cleared: 'تم مسحها',
  wiped: 'تم إزالتها',
  added: 'تمت إضافتها',
  relocated: 'تم نقلها',
  createdEmployees: 'موظفين جدد',
  untracked: 'غير مسجلين',
  archived: 'تم أرشفتها',
};

const FK_FIELDS = new Set([
  'departmentId',
  'locationId',
  'insuranceCompanyId',
  'medicalInsuranceCompanyId',
]);

function truncateValue(v: unknown): unknown {
  if (typeof v === 'string' && v.length > PREVIEW_MAX_STR) {
    return `${v.slice(0, PREVIEW_MAX_STR)}…`;
  }
  if (v && typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      if (s.length > PREVIEW_MAX_STR) return JSON.parse(s.slice(0, PREVIEW_MAX_STR));
    } catch {
      return String(v).slice(0, PREVIEW_MAX_STR);
    }
  }
  return v;
}

type NameMaps = {
  departments: Map<string, string>;
  locations: Map<string, string>;
  insurance: Map<string, string>;
};

let cachedNameMaps: { at: number; maps: NameMaps } | null = null;

async function loadNameMaps(): Promise<NameMaps> {
  const now = Date.now();
  if (cachedNameMaps && now - cachedNameMaps.at < 60_000) return cachedNameMaps.maps;
  const [departments, locations, insurance] = await Promise.all([
    prisma.department.findMany({ select: { id: true, name: true } }),
    prisma.location.findMany({ select: { id: true, name: true } }),
    prisma.insuranceCompany.findMany({ select: { id: true, name: true } }),
  ]);
  const maps: NameMaps = {
    departments: new Map(departments.map((d) => [d.id, d.name])),
    locations: new Map(locations.map((l) => [l.id, l.name])),
    insurance: new Map(insurance.map((i) => [i.id, i.name])),
  };
  cachedNameMaps = { at: now, maps };
  return maps;
}

function formatScalar(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'boolean') return v ? 'نعم' : 'لا';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return '—';
    // ISO date / datetime → date or readable local-ish stamp
    const m = t.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))/);
    if (m) {
      if (m[2] === '00' && m[3] === '00') return m[1];
      return `${m[1]} ${m[2]}:${m[3]}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    return t;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function resolveFk(field: string | undefined, value: unknown, maps: NameMaps): string {
  if (value == null || value === '') return '—';
  const id = String(value);
  if (!field || !FK_FIELDS.has(field)) return formatScalar(value);
  if (field === 'departmentId') return maps.departments.get(id) ?? id;
  if (field === 'locationId') return maps.locations.get(id) ?? id;
  if (field === 'insuranceCompanyId' || field === 'medicalInsuranceCompanyId') {
    return maps.insurance.get(id) ?? id;
  }
  return formatScalar(value);
}

export type HumanAuditDiffRow = AuditDiffRow & {
  fieldLabel?: string;
  beforeDisplay?: string;
  afterDisplay?: string;
};

export async function humanizeDiffRows(rows: AuditDiffRow[] | undefined | null): Promise<HumanAuditDiffRow[]> {
  if (!rows?.length) return [];
  const maps = await loadNameMaps();
  return rows.map((r) => {
    const field = r.field ?? '';
    return {
      ...r,
      fieldLabel: AUDIT_FIELD_LABELS_AR[field] ?? field,
      beforeDisplay: resolveFk(field, r.before, maps),
      afterDisplay: resolveFk(field, r.after, maps),
    };
  });
}

export function actionLabelAr(action: string | null | undefined): string {
  if (!action) return '—';
  return AUDIT_ACTION_LABELS_AR[action] ?? action;
}

export function humanizeCounts(counts: unknown): Record<string, unknown> | null {
  if (!counts || typeof counts !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(counts as Record<string, unknown>)) {
    out[AUDIT_COUNT_LABELS_AR[k] ?? k] = v;
  }
  return out;
}

/** Prefer payload.changes, else diffPreview; synthesize details from common payload shapes. */
export function collectChangeRows(row: {
  action?: string | null;
  summary?: string | null;
  counts?: unknown;
  diffPreview?: unknown;
  payload?: unknown;
}): AuditDiffRow[] {
  const preview = Array.isArray(row.diffPreview) ? (row.diffPreview as AuditDiffRow[]) : [];
  const payload = row.payload && typeof row.payload === 'object'
    ? (row.payload as Record<string, unknown>)
    : null;
  const fromPayload = Array.isArray(payload?.changes)
    ? (payload!.changes as AuditDiffRow[])
    : [];
  if (fromPayload.length) return fromPayload;
  if (preview.length) return preview;

  const synthesized: AuditDiffRow[] = [];

  if (payload?.name != null) {
    synthesized.push({
      field: 'name',
      before: row.action?.includes('delete') || row.action?.includes('archive') ? payload.name : null,
      after: row.action?.includes('delete') ? null : payload.name,
      note: row.action?.includes('delete')
        ? 'تم الحذف'
        : row.action?.includes('archive')
          ? 'تمت الأرشفة'
          : undefined,
      entityLabel: String(payload.name),
    });
  }

  if (payload?.reason != null && String(payload.reason).trim()) {
    synthesized.push({
      field: 'note',
      after: payload.reason,
      note: 'سبب',
      entityLabel: payload.name != null ? String(payload.name) : undefined,
    });
  }

  const createdCodes = Array.isArray(payload?.createdCodes)
    ? (payload!.createdCodes as unknown[]).map(String).filter(Boolean)
    : [];
  for (const code of createdCodes) {
    synthesized.push({
      field: 'code',
      after: code,
      note: 'موظف جديد من الاستيراد',
      entityLabel: code,
    });
  }

  const archivedCodes = Array.isArray(payload?.archivedCodes)
    ? (payload!.archivedCodes as unknown[]).map(String).filter(Boolean)
    : [];
  for (const code of archivedCodes) {
    synthesized.push({
      field: 'active',
      before: true,
      after: false,
      note: 'أرشفة تلقائية من استيراد الجدول (خروج)',
      entityLabel: code,
    });
  }

  const untracked = Array.isArray(payload?.untrackedUsers)
    ? (payload!.untrackedUsers as Array<Record<string, unknown>>)
    : [];
  for (const u of untracked.slice(0, 100)) {
    const code = String(u.code ?? '').trim();
    if (!code) continue;
    synthesized.push({
      field: 'code',
      before: code,
      after: null,
      note: String(u.reason ?? 'كود غير مسجل'),
      entityLabel: String(u.excelName || code),
      entityId: code,
    });
  }

  if (payload?.dateFrom != null || payload?.dateTo != null) {
    synthesized.push({
      field: 'dateFrom',
      after: `${payload?.dateFrom ?? '—'} → ${payload?.dateTo ?? '—'}`,
      note: 'نطاق الاستيراد',
    });
  }

  if (payload?.reference != null) {
    synthesized.push({
      field: 'note',
      after: String(payload.reference),
      note: 'مرجع',
    });
  }

  if (payload?.amount != null) {
    synthesized.push({
      field: 'amount',
      after: payload.amount,
      entityLabel: payload.employeeName != null ? String(payload.employeeName) : undefined,
    });
  }

  if (payload?.type != null || payload?.deductionType != null) {
    synthesized.push({
      field: 'note',
      after: String(payload.type ?? payload.deductionType),
      note: 'نوع الخصم',
    });
  }

  if (payload?.fingerprintCode != null) {
    synthesized.push({
      field: 'identificationId',
      after: payload.fingerprintCode,
      entityLabel: payload.employeeName != null ? String(payload.employeeName) : undefined,
    });
  }

  if (payload?.status != null) {
    synthesized.push({
      field: 'state',
      before: payload.previousStatus ?? null,
      after: payload.status,
      entityLabel: payload.employeeName != null ? String(payload.employeeName) : undefined,
    });
  }

  // Fallback: turn counts into readable detail rows when nothing else exists
  if (!synthesized.length && row.counts && typeof row.counts === 'object') {
    for (const [k, v] of Object.entries(row.counts as Record<string, unknown>)) {
      if (v == null || v === 0 || v === '0') continue;
      synthesized.push({
        field: k,
        after: v,
        note: 'إحصاء العملية',
      });
    }
  }

  return synthesized;
}

export function capDiffPreview(rows: AuditDiffRow[] | undefined): AuditDiffRow[] {
  if (!rows?.length) return [];
  return rows.slice(0, PREVIEW_MAX_ROWS).map((r) => ({
    entityId: r.entityId,
    entityLabel: r.entityLabel,
    field: r.field,
    before: truncateValue(r.before),
    after: truncateValue(r.after),
    note: r.note,
  }));
}

export function resolveAuditActor(req?: Request, actor?: AuditActor | null): {
  actorId: string | null;
  actorLogin: string;
  actorName: string | null;
  actorRole: UserRole | null;
} {
  const u = actor ?? (req?.user as AuditActor | undefined);
  if (!u) {
    return { actorId: null, actorLogin: 'unknown', actorName: null, actorRole: null };
  }
  const isLocalPlatform = u.id === 'platform-admin';
  return {
    actorId: isLocalPlatform ? null : u.id || null,
    actorLogin: u.login || u.email || 'unknown',
    actorName: u.name ?? null,
    actorRole: (u.role as UserRole | undefined) ?? null,
  };
}

function clientIp(req?: Request): string | null {
  if (!req) return null;
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0]?.trim() || null;
  return req.ip || null;
}

/** Fire-and-forget safe write — never throws to caller. */
export async function writeAudit(input: WriteAuditInput): Promise<string | null> {
  try {
    const actor = resolveAuditActor(input.req, input.actor);
    const diffPreview = capDiffPreview(input.diffPreview);
    const row = await prisma.auditLog.create({
      data: {
        actorId: actor.actorId,
        actorLogin: actor.actorLogin,
        actorName: actor.actorName,
        actorRole: actor.actorRole ?? undefined,
        module: input.module,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        summary: input.summary.slice(0, 500),
        counts: (input.counts ?? undefined) as Prisma.InputJsonValue | undefined,
        diffPreview: diffPreview.length
          ? (diffPreview as unknown as Prisma.InputJsonValue)
          : undefined,
        payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
        route: input.route ?? input.req?.path ?? null,
        ip: clientIp(input.req),
        requestId: input.req?.rpcId != null ? String(input.req.rpcId) : null,
      },
    });
    return row.id;
  } catch (err) {
    console.error('[audit] write failed', err);
    return null;
  }
}

export async function userHasFeatureGrant(userId: string, feature: string): Promise<boolean> {
  if (!userId || userId === 'platform-admin') return true;
  const grant = await prisma.userFeatureGrant.findUnique({
    where: { userId_feature: { userId, feature } },
  });
  return Boolean(grant?.enabled);
}

export async function userHasAuditGrant(userId: string): Promise<boolean> {
  return userHasFeatureGrant(userId, AUDIT_FEATURE);
}

export async function userHasAssistantGrant(userId: string): Promise<boolean> {
  return userHasFeatureGrant(userId, ASSISTANT_FEATURE);
}

export async function userHasEmployeeDeleteGrant(userId: string): Promise<boolean> {
  return userHasFeatureGrant(userId, EMPLOYEE_DELETE_FEATURE);
}

export async function canViewAudit(user: AuditActor | undefined | null): Promise<boolean> {
  if (!user) return false;
  if (user.role === UserRole.PLATFORM_ADMIN || user.id === 'platform-admin') return true;
  return userHasAuditGrant(user.id);
}

export async function assertCanViewAudit(req: Request): Promise<void> {
  const ok = await canViewAudit(req.user as AuditActor | undefined);
  if (!ok) throw new ForbiddenError('لا صلاحية لعرض سجل التدقيق', 'FORBIDDEN');
}

export async function canViewAssistant(user: AuditActor | undefined | null): Promise<boolean> {
  if (!user) return false;
  if (user.role === UserRole.PLATFORM_ADMIN || user.id === 'platform-admin') return true;
  return userHasAssistantGrant(user.id);
}

export async function assertCanViewAssistant(req: Request): Promise<void> {
  const ok = await canViewAssistant(req.user as AuditActor | undefined);
  if (!ok) throw new ForbiddenError('لا صلاحية لاستخدام المساعد', 'FORBIDDEN');
}

export async function canDeleteEmployee(user: AuditActor | undefined | null): Promise<boolean> {
  if (!user) return false;
  if (user.role === UserRole.PLATFORM_ADMIN || user.id === 'platform-admin') return true;
  return userHasEmployeeDeleteGrant(user.id);
}

export async function assertCanDeleteEmployee(req: Request): Promise<void> {
  const ok = await canDeleteEmployee(req.user as AuditActor | undefined);
  if (!ok) throw new ForbiddenError('لا صلاحية لحذف الموظفين', 'FORBIDDEN');
}

export async function listFeatureGrants(feature: string = AUDIT_FEATURE) {
  const users = await prisma.user.findMany({
    where: {
      role: { in: [UserRole.HR_MANAGER, UserRole.HR_SUPERVISOR, UserRole.HR_USER] },
      active: true,
    },
    orderBy: [{ name: 'asc' }, { login: 'asc' }],
    select: { id: true, login: true, name: true, role: true, email: true },
  });
  const grants = await prisma.userFeatureGrant.findMany({
    where: { feature, userId: { in: users.map((u) => u.id) } },
  });
  const byUser = new Map(grants.map((g) => [g.userId, g]));
  return users.map((u) => ({
    userId: u.id,
    login: u.login,
    name: u.name,
    role: u.role,
    email: u.email,
    feature,
    enabled: Boolean(byUser.get(u.id)?.enabled),
    grantedAt: byUser.get(u.id)?.grantedAt?.toISOString() ?? null,
  }));
}

export async function setFeatureGrant(params: {
  userId: string;
  feature?: string;
  enabled: boolean;
  grantedById?: string | null;
}) {
  const feature = params.feature || AUDIT_FEATURE;
  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user) throw new AppError('المستخدم غير موجود', 404, 'NOT_FOUND');
  if (user.role === UserRole.PLATFORM_ADMIN) {
    throw new AppError('مشرف المنصة لديه هذه الصلاحية دائماً', 400, 'VALIDATION_ERROR');
  }
  const grantedById =
    params.grantedById && params.grantedById !== 'platform-admin'
      ? params.grantedById
      : null;

  const row = await prisma.userFeatureGrant.upsert({
    where: { userId_feature: { userId: params.userId, feature } },
    create: {
      userId: params.userId,
      feature,
      enabled: params.enabled,
      grantedById,
    },
    update: {
      enabled: params.enabled,
      grantedById,
      grantedAt: new Date(),
    },
  });
  return row;
}

export async function listAuditLogs(params: {
  dateFrom?: string;
  dateTo?: string;
  module?: string;
  action?: string;
  actorId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 40, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const where: Prisma.AuditLogWhereInput = {};

  if (params.module?.trim()) where.module = params.module.trim();
  if (params.action?.trim()) where.action = { contains: params.action.trim(), mode: 'insensitive' };
  if (params.actorId?.trim()) where.actorId = params.actorId.trim();

  if (params.dateFrom || params.dateTo) {
    where.createdAt = {};
    if (params.dateFrom) {
      const d = new Date(params.dateFrom);
      if (!Number.isNaN(d.getTime())) where.createdAt.gte = d;
    }
    if (params.dateTo) {
      const d = new Date(params.dateTo);
      if (!Number.isNaN(d.getTime())) {
        // inclusive end day when bare date
        if (/^\d{4}-\d{2}-\d{2}$/.test(params.dateTo)) {
          d.setUTCHours(23, 59, 59, 999);
        }
        where.createdAt.lte = d;
      }
    }
  }

  const search = params.search?.trim();
  if (search) {
    const like = `%${search.replace(/[%_]/g, '\\$&')}%`;
    const companyId = getCompanyId();
    const payloadHits = companyId
      ? await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM audit_logs
          WHERE company_id = ${companyId}
            AND (
              summary ILIKE ${like}
              OR actor_login ILIKE ${like}
              OR COALESCE(actor_name, '') ILIKE ${like}
              OR COALESCE(entity_id, '') ILIKE ${like}
              OR action ILIKE ${like}
              OR COALESCE(payload::text, '') ILIKE ${like}
              OR COALESCE(diff_preview::text, '') ILIKE ${like}
            )
          ORDER BY created_at DESC
          LIMIT 800
        `
      : await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM audit_logs
          WHERE summary ILIKE ${like}
             OR actor_login ILIKE ${like}
             OR COALESCE(actor_name, '') ILIKE ${like}
             OR COALESCE(entity_id, '') ILIKE ${like}
             OR action ILIKE ${like}
             OR COALESCE(payload::text, '') ILIKE ${like}
             OR COALESCE(diff_preview::text, '') ILIKE ${like}
          ORDER BY created_at DESC
          LIMIT 800
        `;
    const ids = payloadHits.map((h) => h.id);
    if (!ids.length) {
      return { items: [], total: 0, limit, offset, hasMore: false };
    }
    where.id = { in: ids };
  }

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      select: {
        id: true,
        createdAt: true,
        actorId: true,
        actorLogin: true,
        actorName: true,
        actorRole: true,
        module: true,
        action: true,
        entityType: true,
        entityId: true,
        summary: true,
        counts: true,
        diffPreview: true,
        payload: true,
        route: true,
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  const mapped = await Promise.all(
    items.map(async (i) => {
      const changeSource = collectChangeRows({
        action: i.action,
        summary: i.summary,
        counts: i.counts,
        diffPreview: i.diffPreview,
        payload: i.payload,
      });
      const diffPreview = await humanizeDiffRows(changeSource);
      return {
        id: i.id,
        createdAt: i.createdAt.toISOString(),
        actorId: i.actorId,
        actorLogin: i.actorLogin,
        actorName: i.actorName,
        actorRole: i.actorRole,
        module: i.module,
        action: i.action,
        actionLabel: actionLabelAr(i.action),
        entityType: i.entityType,
        entityId: i.entityId,
        summary: i.summary,
        counts: humanizeCounts(i.counts) ?? i.counts,
        countsRaw: i.counts,
        diffPreview,
        route: i.route,
        hasFullPayload: true,
        detailCount: diffPreview.length,
      };
    }),
  );

  return {
    items: mapped,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
  };
}

export async function getAuditLog(id: string) {
  const row = await prisma.auditLog.findUnique({ where: { id } });
  if (!row) throw new AppError('سجل التدقيق غير موجود', 404, 'NOT_FOUND');
  const changeSource = collectChangeRows(row);
  const changes = await humanizeDiffRows(changeSource);
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    actionLabel: actionLabelAr(row.action),
    countsDisplay: humanizeCounts(row.counts),
    diffPreview: changes,
    changes,
    detailCount: changes.length,
  };
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

export async function exportAuditLogXlsx(id: string) {
  const row = await getAuditLog(id);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hudoori Audit';

  const summary = workbook.addWorksheet('ملخص');
  summary.views = [{ rightToLeft: true }];
  summary.getColumn(1).width = 22;
  summary.getColumn(2).width = 60;
  const summaryRows: [string, string][] = [
    ['المعرّف', row.id],
    ['التاريخ', row.createdAt],
    ['المستخدم', row.actorName ? `${row.actorName} (${row.actorLogin})` : row.actorLogin],
    ['الدور', row.actorRole ?? ''],
    ['الوحدة', row.module],
    ['الإجراء', row.action],
    ['الكيان', [row.entityType, row.entityId].filter(Boolean).join(' / ')],
    ['الملخص', row.summary],
    ['المسار', row.route ?? ''],
    ['IP', row.ip ?? ''],
    ['Request', row.requestId ?? ''],
  ];
  summaryRows.forEach(([k, v], i) => {
    summary.getCell(i + 1, 1).value = k;
    summary.getCell(i + 1, 1).font = { bold: true };
    summary.getCell(i + 1, 2).value = v;
  });

  if (row.counts && typeof row.counts === 'object') {
    let r = summaryRows.length + 2;
    summary.getCell(r, 1).value = 'الإحصاءات';
    summary.getCell(r, 1).font = { bold: true };
    r++;
    for (const [k, v] of Object.entries(row.counts as Record<string, unknown>)) {
      summary.getCell(r, 1).value = k;
      summary.getCell(r, 2).value = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
      r++;
    }
  }

  const changesSheet = workbook.addWorksheet('التغييرات');
  changesSheet.views = [{ rightToLeft: true }];
  const headers = ['كيان', 'تسمية', 'الحقل', 'قبل', 'بعد', 'ملاحظة'];
  headers.forEach((h, i) => {
    changesSheet.getCell(1, i + 1).value = h;
    changesSheet.getCell(1, i + 1).font = { bold: true };
  });
  [18, 28, 22, 28, 28, 24].forEach((w, i) => {
    changesSheet.getColumn(i + 1).width = w;
  });

  const changeRows = await humanizeDiffRows(collectChangeRows(row));

  changeRows.forEach((c, idx) => {
    const r = idx + 2;
    changesSheet.getCell(r, 1).value = c.entityId ?? '';
    changesSheet.getCell(r, 2).value = c.entityLabel ?? '';
    changesSheet.getCell(r, 3).value = c.fieldLabel ?? c.field ?? '';
    changesSheet.getCell(r, 4).value = c.beforeDisplay ?? formatScalar(c.before);
    changesSheet.getCell(r, 5).value = c.afterDisplay ?? formatScalar(c.after);
    changesSheet.getCell(r, 6).value = c.note ?? '';
  });

  const full = workbook.addWorksheet('بيانات كاملة');
  full.views = [{ rightToLeft: true }];
  full.getColumn(1).width = 100;
  full.getCell(1, 1).value = 'Payload JSON';
  full.getCell(1, 1).font = { bold: true };
  full.getCell(2, 1).value = JSON.stringify(row.payload ?? { diffPreview: changeRows, counts: row.counts }, null, 2);

  const meta = workbook.addWorksheet('Meta');
  meta.getColumn(1).width = 20;
  meta.getColumn(2).width = 50;
  meta.getCell(1, 1).value = 'exportedAt';
  meta.getCell(1, 2).value = new Date().toISOString();
  meta.getCell(2, 1).value = 'changeRows';
  meta.getCell(2, 2).value = changeRows.length;

  const base64 = await workbookToBase64(workbook);
  const day = row.createdAt.slice(0, 10);
  const safeAction = row.action.replace(/[^\w.-]+/g, '_').slice(0, 40);
  return exportFileResponse(base64, `audit_${row.module}_${safeAction}_${day}.xlsx`);
}

/** Build field diffs between two plain objects (shallow). */
export function shallowFieldDiffs(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  opts?: { entityId?: string; entityLabel?: string; keys?: string[] },
): AuditDiffRow[] {
  const keys = opts?.keys
    ?? [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const rows: AuditDiffRow[] = [];
  for (const key of keys) {
    const b = before?.[key];
    const a = after?.[key];
    const bs = b instanceof Date ? b.toISOString() : b;
    const as = a instanceof Date ? a.toISOString() : a;
    if (JSON.stringify(bs ?? null) === JSON.stringify(as ?? null)) continue;
    rows.push({
      entityId: opts?.entityId,
      entityLabel: opts?.entityLabel,
      field: key,
      before: bs ?? null,
      after: as ?? null,
    });
  }
  return rows;
}
