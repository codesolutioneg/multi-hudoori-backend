import type { Request } from 'express';
import { prisma } from '../prisma/client';
import {
  absenceNotificationId,
  getNoPunchAlerts,
  NO_PUNCH_WINDOW_DAYS,
  type NoPunchAlert,
} from './noPunchAlerts.service';
import { getHrLocationScopeFromReq } from './userLocationScope.service';

export type AbsenceAlertItem = {
  id: string;
  employeeId: string;
  name: string;
  code: string;
  locationId: string | null;
  locationName: string;
  firstAbsentDate: Date;
  absentDays: number;
  isRead: boolean;
};

async function visibleCandidates(req: Request): Promise<NoPunchAlert[]> {
  const hrScope = await getHrLocationScopeFromReq(req);
  return getNoPunchAlerts(hrScope);
}

export async function listAbsenceAlerts(req: Request): Promise<{
  items: AbsenceAlertItem[];
  totalCount: number;
  unreadCount: number;
  windowDays: number;
}> {
  const rows = await visibleCandidates(req);
  const ids = rows.map((row) => absenceNotificationId(row.employeeId, row.firstAbsentDate));
  const readRows = ids.length
    ? await prisma.dashboardNotificationRead.findMany({
        where: {
          readerKey: req.user!.id,
          notificationId: { in: ids },
        },
        select: { notificationId: true },
      })
    : [];
  const readIds = new Set(readRows.map((row) => row.notificationId));
  const items = rows.map((row) => {
    const id = absenceNotificationId(row.employeeId, row.firstAbsentDate);
    return { id, ...row, isRead: readIds.has(id) };
  });

  return {
    items,
    totalCount: items.length,
    unreadCount: items.filter((item) => !item.isRead).length,
    windowDays: NO_PUNCH_WINDOW_DAYS,
  };
}

export async function markAbsenceAlertsRead(req: Request): Promise<{ readCount: number }> {
  const rows = await visibleCandidates(req);
  if (rows.length === 0) return { readCount: 0 };

  const result = await prisma.dashboardNotificationRead.createMany({
    data: rows.map((row) => ({
      readerKey: req.user!.id,
      notificationId: absenceNotificationId(row.employeeId, row.firstAbsentDate),
    })),
    skipDuplicates: true,
  });
  return { readCount: result.count };
}
