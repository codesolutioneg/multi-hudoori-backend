import { prisma } from '../prisma/client';
import { prismaBase } from '../prisma/client';
import { requireCompanyId } from '../tenant/context';
import { logger } from '../utils/logger';
import { sendToCompanyTopic, sendToDeviceToken } from '../firebase/fcm.service';

export type AppNotificationType =
  | 'request_approved'
  | 'request_rejected'
  | 'payroll_confirmed'
  | 'company_broadcast'
  | 'hr_push';

export function notificationJson(row: {
  id: string;
  type: string;
  title: string;
  body: string;
  imageUrl: string | null;
  data: unknown;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    imageUrl: row.imageUrl,
    data: row.data,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    read: row.readAt != null,
  };
}

export async function setUserFcmToken(userId: string, fcmToken: string | null): Promise<void> {
  await prismaBase.user.update({
    where: { id: userId },
    data: { fcmToken: fcmToken?.trim() || null },
  });
}

export async function clearUserFcmToken(userId: string): Promise<void> {
  await setUserFcmToken(userId, null);
}

async function pushToUser(userId: string, payload: {
  title: string;
  body: string;
  imageUrl?: string | null;
  notificationId: string;
  data?: Record<string, string>;
}): Promise<void> {
  const user = await prismaBase.user.findUnique({
    where: { id: userId },
    select: { fcmToken: true },
  });
  const token = user?.fcmToken?.trim();
  if (!token) return;
  try {
    await sendToDeviceToken(token, {
      title: payload.title,
      body: payload.body,
      imageUrl: payload.imageUrl,
      notificationId: payload.notificationId,
      data: payload.data,
    });
  } catch (err) {
    logger.warn({ err, userId }, 'FCM send to user failed');
  }
}

export async function notifyUser(params: {
  companyId: string;
  userId: string;
  type: AppNotificationType;
  title: string;
  body: string;
  imageUrl?: string | null;
  data?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const row = await prisma.appNotification.create({
    data: {
      companyId: params.companyId,
      userId: params.userId,
      type: params.type,
      title: params.title,
      body: params.body,
      imageUrl: params.imageUrl?.trim() || null,
      data: params.data ?? undefined,
    },
  });
  const dataStrings: Record<string, string> = {};
  if (params.data) {
    for (const [k, v] of Object.entries(params.data)) {
      if (v != null) dataStrings[k] = String(v);
    }
  }
  await pushToUser(params.userId, {
    title: params.title,
    body: params.body,
    imageUrl: params.imageUrl,
    notificationId: row.id,
    data: { type: params.type, ...dataStrings },
  });
  return { id: row.id };
}

export async function broadcastToCompany(params: {
  companyId: string;
  title: string;
  body: string;
  imageUrl?: string | null;
}): Promise<{ recipientCount: number }> {
  const users = await prisma.user.findMany({
    where: { companyId: params.companyId, active: true },
    select: { id: true },
  });
  const imageUrl = params.imageUrl?.trim() || null;
  const rows = users.map((u) => ({
    companyId: params.companyId,
    userId: u.id,
    type: 'company_broadcast' as const,
    title: params.title,
    body: params.body,
    imageUrl,
  }));
  if (rows.length) {
    await prisma.appNotification.createMany({ data: rows });
  }
  try {
    await sendToCompanyTopic(params.companyId, {
      title: params.title,
      body: params.body,
      imageUrl,
      data: { type: 'company_broadcast' },
    });
  } catch (err) {
    logger.warn({ err, companyId: params.companyId }, 'FCM company topic send failed');
  }
  return { recipientCount: rows.length };
}

export async function resolveTargetUserIds(params: {
  userIds?: string[];
  employeeIds?: string[];
}): Promise<string[]> {
  const ids = new Set<string>();
  for (const raw of params.userIds ?? []) {
    const id = String(raw).trim();
    if (id) ids.add(id);
  }
  const empIds = [...new Set((params.employeeIds ?? []).map(String).map((s) => s.trim()).filter(Boolean))];
  if (empIds.length) {
    const employees = await prisma.employeeProfile.findMany({
      where: { id: { in: empIds }, userId: { not: null } },
      select: { userId: true },
    });
    for (const e of employees) {
      if (e.userId) ids.add(e.userId);
    }
  }
  return [...ids];
}

export async function sendDirectPush(params: {
  companyId: string;
  userIds: string[];
  title: string;
  body: string;
  imageUrl?: string | null;
}): Promise<{ sentCount: number; targetCount: number }> {
  const unique = [...new Set(params.userIds.map(String).filter(Boolean))];
  if (!unique.length) return { sentCount: 0, targetCount: 0 };
  const active = await prisma.user.findMany({
    where: { id: { in: unique }, companyId: params.companyId, active: true },
    select: { id: true },
  });
  let sentCount = 0;
  for (const u of active) {
    await notifyUser({
      companyId: params.companyId,
      userId: u.id,
      type: 'hr_push',
      title: params.title,
      body: params.body,
      imageUrl: params.imageUrl,
      data: { route: '/notifications' },
    });
    sentCount += 1;
  }
  return { sentCount, targetCount: active.length };
}

export async function listCompanyPushLog(
  companyId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ items: ReturnType<typeof notificationJson>[]; total: number }> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 40));
  const offset = Math.max(0, options.offset ?? 0);
  const where = {
    companyId,
    type: { in: ['company_broadcast', 'hr_push'] },
  };
  const [items, total] = await Promise.all([
    prisma.appNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        user: {
          select: {
            login: true,
            name: true,
            employeeProfile: { select: { name: true, code: true } },
          },
        },
      },
    }),
    prisma.appNotification.count({ where }),
  ]);
  return {
    items: items.map((row) => ({
      ...notificationJson(row),
      recipientLogin: row.user.login,
      recipientName:
        row.user.employeeProfile?.name?.trim() ||
        row.user.name?.trim() ||
        row.user.login,
      recipientCode: row.user.employeeProfile?.code ?? null,
    })),
    total,
  };
}

export async function listNotificationsForUser(
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ items: ReturnType<typeof notificationJson>[]; unreadCount: number; total: number }> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 30));
  const offset = Math.max(0, options.offset ?? 0);
  const where = { userId };
  const [items, total, unreadCount] = await Promise.all([
    prisma.appNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.appNotification.count({ where }),
    prisma.appNotification.count({ where: { ...where, readAt: null } }),
  ]);
  return {
    items: items.map(notificationJson),
    unreadCount,
    total,
  };
}

export async function markNotificationsRead(
  userId: string,
  params: { ids?: string[]; all?: boolean },
): Promise<{ readCount: number }> {
  const now = new Date();
  if (params.all) {
    const result = await prisma.appNotification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: now },
    });
    return { readCount: result.count };
  }
  const ids = [...new Set((params.ids ?? []).map(String).filter(Boolean))];
  if (!ids.length) return { readCount: 0 };
  const result = await prisma.appNotification.updateMany({
    where: { userId, id: { in: ids }, readAt: null },
    data: { readAt: now },
  });
  return { readCount: result.count };
}

export async function notifyEmployeeRequestDecision(params: {
  employeeId: string;
  approved: boolean;
  requestKind: string;
  requestId: string;
  detail?: string;
  title?: string;
  rejectionReason?: string | null;
}): Promise<void> {
  const companyId = requireCompanyId();
  const employee = await prisma.employeeProfile.findUnique({
    where: { id: params.employeeId },
    select: { userId: true, name: true },
  });
  if (!employee?.userId) return;
  const kindLabel = requestKindLabel(params.requestKind);
  const title =
    params.title?.trim() ||
    (params.approved ? `تمت الموافقة على طلبك` : `تم رفض طلبك`);
  let body = params.detail?.trim()
    ? `${kindLabel}: ${params.detail}`
    : kindLabel;
  const reason = params.rejectionReason?.trim();
  if (!params.approved && reason) {
    body = `${body}\nالسبب: ${reason}`;
  }
  await notifyUser({
    companyId,
    userId: employee.userId,
    type: params.approved ? 'request_approved' : 'request_rejected',
    title,
    body,
    data: {
      requestId: params.requestId,
      requestKind: params.requestKind,
      route: '/requests',
    },
  });
}

function requestKindLabel(kind: string): string {
  const map: Record<string, string> = {
    leave: 'طلب إجازة',
    loan: 'طلب سلفة',
    shiftChange: 'طلب تغيير شيفت',
    salary: 'طلب راتب',
    certificate: 'طلب شهادة',
    attendanceEdit: 'طلب تعديل حضور',
    advance: 'طلب سلفة',
  };
  return map[kind] ?? 'طلب';
}

function fmtMoneyAr(n: number): string {
  const v = Math.round(n * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Short FCM body — totals only; full payslip opens in-app. */
function buildPayrollConfirmedBody(params: {
  periodFrom: string;
  periodTo: string;
  excelNet: number;
  excelTotalDeductions: number;
}): string {
  return [
    `الفترة: ${params.periodFrom} → ${params.periodTo} · الاستقطاعات: ${fmtMoneyAr(params.excelTotalDeductions)}`,
    `صافي الراتب: ${fmtMoneyAr(params.excelNet)}`,
  ].join('\n');
}

export async function notifyPayrollConfirmed(payrollId: string): Promise<void> {
  const companyId = requireCompanyId();
  const payroll = await prisma.payroll.findUnique({
    where: { id: payrollId },
    include: {
      shiftGrid: { include: { location: { select: { name: true } } } },
      lines: {
        include: {
          employee: {
            select: {
              userId: true,
              name: true,
              code: true,
              jobTitle: true,
              basicSalary: true,
              employeeInsuranceShare: true,
              medicalInsuranceSalary: true,
              department: { select: { name: true } },
              workLocation: { select: { name: true } },
            },
          },
        },
        orderBy: { sequence: 'asc' },
      },
    },
  });
  if (!payroll) return;

  const periodFrom = payroll.dateFrom.toISOString().slice(0, 10);
  const periodTo = payroll.dateTo.toISOString().slice(0, 10);
  const { getPayslipValues } = await import('./payrollExport.service');
  const payrollForValues = {
    id: payroll.id,
    name: payroll.name,
    dateFrom: payroll.dateFrom,
    dateTo: payroll.dateTo,
    shiftGridId: payroll.shiftGridId,
    shiftGrid: payroll.shiftGrid,
    lines: payroll.lines,
  };

  for (const [idx, line] of payroll.lines.entries()) {
    const userId = line.employee?.userId;
    if (!userId) continue;

    // Only push when the employee has registered an FCM device token.
    const user = await prismaBase.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true },
    });
    if (!user?.fcmToken?.trim()) continue;

    let body: string;
    let net = line.netSalary ?? 0;
    try {
      const values = getPayslipValues(line as never, payrollForValues as never, line.sequence || idx + 1);
      net = values.excelNet;
      body = buildPayrollConfirmedBody({
        periodFrom,
        periodTo,
        excelNet: values.excelNet,
        excelTotalDeductions: values.excelTotalDeductions,
      });
    } catch (err) {
      logger.warn({ err, payrollId, lineId: line.id }, 'Payslip body for FCM failed; using summary');
      body = `الفترة: ${periodFrom} → ${periodTo}\nصافي الراتب: ${fmtMoneyAr(net)}`;
    }

    await notifyUser({
      companyId,
      userId,
      type: 'payroll_confirmed',
      title: 'تم اعتماد راتبك',
      body,
      data: {
        payrollId,
        payrollLineId: line.id,
        periodFrom,
        periodTo,
        netPay: String(net),
        route: '/payroll/my',
      },
    });
  }
}
