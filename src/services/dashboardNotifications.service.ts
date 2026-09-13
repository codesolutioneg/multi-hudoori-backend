import { HiringAppointmentStatus } from '@prisma/client';
import type { Request } from 'express';
import { listHealthCertificateAlerts } from './healthCertificate.service';
import { NO_PUNCH_WINDOW_DAYS } from './noPunchAlerts.service';
import { listAbsenceAlerts, markAbsenceAlertsRead } from './absenceAlerts.service';
import * as requestsService from './requests.service';
import { prisma } from '../prisma/client';

export type DashboardNotificationItem = {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  routeKey: string;
};

export type DashboardNotificationSection = {
  key: string;
  label: string;
  routeKey: string;
  count: number;
  items: DashboardNotificationItem[];
};

function empName(employee?: { name?: string | null; code?: string | null } | null): string {
  return employee?.name?.trim() || employee?.code?.trim() || '—';
}

function buildPendingRequestItems(data: Awaited<ReturnType<typeof requestsService.listPendingRequests>>): DashboardNotificationItem[] {
  const items: DashboardNotificationItem[] = [];

  for (const r of data.leave) {
    items.push({
      id: `leave-${r.id}`,
      kind: 'leave',
      title: `إجازة — ${empName(r.employee)}`,
      subtitle: `${r.dateFrom.toISOString().slice(0, 10)} → ${r.dateTo.toISOString().slice(0, 10)}`,
      routeKey: 'requests',
    });
  }
  for (const r of data.loan) {
    items.push({
      id: `loan-${r.id}`,
      kind: 'loan',
      title: `سلفة — ${empName(r.employee)}`,
      subtitle: `${r.amount} جنيه`,
      routeKey: 'requests',
    });
  }
  for (const r of data.shiftChange) {
    items.push({
      id: `shift-${r.id}`,
      kind: 'shift_change',
      title: `تغيير شيفت — ${empName(r.employee)}`,
      subtitle: r.newShift?.name ?? '',
      routeKey: 'requests',
    });
  }
  for (const r of data.salary) {
    items.push({
      id: `salary-${r.id}`,
      kind: 'salary',
      title: `طلب راتب — ${empName(r.employee)}`,
      subtitle: r.reason?.trim() || 'بانتظار الموافقة',
      routeKey: 'requests',
    });
  }
  for (const r of data.certificate) {
    items.push({
      id: `cert-${r.id}`,
      kind: 'certificate',
      title: `شهادة — ${empName(r.employee)}`,
      subtitle: r.reason?.trim() || 'بانتظار الموافقة',
      routeKey: 'requests',
    });
  }
  for (const r of data.attendanceEdit) {
    items.push({
      id: `att-${r.id}`,
      kind: 'attendance_edit',
      title: `تعديل حضور — ${empName(r.employee)}`,
      subtitle: r.reason?.trim() || 'بانتظار الموافقة',
      routeKey: 'requests',
    });
  }

  return items.sort((a, b) => a.title.localeCompare(b.title, 'ar'));
}

async function listHiringNotificationItems(
  isBranchManager: boolean,
  locationId?: string | null,
): Promise<DashboardNotificationItem[]> {
  if (isBranchManager) {
    const rows = await prisma.hiringAppointment.findMany({
      where: {
        status: HiringAppointmentStatus.pending,
        ...(locationId ? { locationId } : {}),
      },
      include: { location: true, createdBy: true },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    return rows.map((row) => ({
      id: `hiring-${row.id}`,
      kind: 'hiring_pending',
      title: row.employeeName,
      subtitle: `${row.jobTitle} — ${row.location?.name ?? ''}`.trim(),
      routeKey: 'hiring',
    }));
  }

  const rows = await prisma.hiringAppointment.findMany({
    where: {
      status: {
        in: [
          HiringAppointmentStatus.approved,
          HiringAppointmentStatus.rejected,
          HiringAppointmentStatus.cancelled,
        ],
      },
      hrSeenAt: null,
      ...(locationId ? { locationId } : {}),
    },
    include: { location: true, createdBy: true },
    orderBy: { updatedAt: 'desc' },
    take: 25,
  });

  const statusLabel: Record<string, string> = {
    approved: 'تمت الموافقة',
    rejected: 'مرفوض',
    cancelled: 'ملغي',
  };

  return rows.map((row) => ({
    id: `hiring-${row.id}`,
    kind: 'hiring_update',
    title: row.employeeName,
    subtitle: `${statusLabel[row.status] ?? row.status} — ${row.jobTitle}`,
    routeKey: 'hiring',
  }));
}

export async function getDashboardNotifications(req: Request): Promise<{
  totalCount: number;
  sections: DashboardNotificationSection[];
}> {
  const sections: DashboardNotificationSection[] = [];
  const absenceAlerts = await listAbsenceAlerts(req);
  const noPunchItems: DashboardNotificationItem[] = absenceAlerts.items
    .filter((row) => !row.isRead)
    .map((row) => ({
      id: row.id,
      kind: 'no_punch',
      title: `${row.name}${row.code ? ` (${row.code})` : ''}`,
      subtitle: [
        row.locationName || null,
        `غياب ${row.absentDays} يوم`,
        `منذ ${row.firstAbsentDate.toISOString().slice(0, 10)}`,
      ]
        .filter(Boolean)
        .join(' — '),
      routeKey: 'absent_employees',
    }));

  if (noPunchItems.length > 0) {
    sections.push({
      key: 'no_punch',
      label: `غياب آخر ${NO_PUNCH_WINDOW_DAYS} أيام`,
      routeKey: 'absent_employees',
      count: noPunchItems.length,
      items: noPunchItems,
    });
  }

  const totalCount = sections.reduce((sum, s) => sum + s.count, 0);
  return { totalCount, sections };
}

export async function markDashboardNotificationsRead(req: Request): Promise<{ readCount: number }> {
  return markAbsenceAlertsRead(req);
}
