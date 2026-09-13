/**
 * Alerts for active employees with no punches during the last N days.
 * A cron job recomputes the snapshot periodically; the dashboard
 * notifications endpoint reads from the cached snapshot.
 */
import { prisma } from '../prisma/client';
import { logger } from '../utils/logger';

export const NO_PUNCH_WINDOW_DAYS = 7;

export function absenceNotificationId(employeeId: string, firstAbsentDate: Date): string {
  return `absence-${employeeId}-${firstAbsentDate.toISOString().slice(0, 10)}`;
}

export type NoPunchAlert = {
  employeeId: string;
  name: string;
  code: string;
  locationId: string | null;
  locationName: string;
  firstAbsentDate: Date;
  absentDays: number;
};

let cache: { computedAt: Date; items: NoPunchAlert[] } | null = null;
let computing = false;

/** Drops the snapshot so the next read recomputes (e.g. after archiving an employee). */
export function invalidateNoPunchCache(): void {
  cache = null;
}

export function invalidateNoPunchAlertsCache(): void {
  cache = null;
}

export async function computeNoPunchAlerts(): Promise<NoPunchAlert[]> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (NO_PUNCH_WINDOW_DAYS - 1));

  // Attendance must be generated first. This deliberately excludes employees
  // with no shift/attendance rows, which were false positives in the old
  // transaction-only check.
  const rows = await prisma.attendance.findMany({
    where: {
      date: { gte: since },
      employee: { active: true },
    },
    select: {
      date: true,
      status: true,
      firstCheckIn: true,
      employee: {
        select: {
          id: true,
          name: true,
          displayName: true,
          code: true,
          identificationId: true,
          locationId: true,
          workLocation: { select: { name: true } },
        },
      },
    },
  });

  type Group = {
    employee: (typeof rows)[number]['employee'];
    absentDates: Date[];
    hasAttendance: boolean;
  };
  const grouped = new Map<string, Group>();
  for (const row of rows) {
    const group = grouped.get(row.employee.id) ?? {
      employee: row.employee,
      absentDates: [],
      hasAttendance: false,
    };
    if (row.status === 'absent') group.absentDates.push(row.date);
    if (
      row.firstCheckIn !== null ||
      row.status === 'present' ||
      row.status === 'late' ||
      row.status === 'early_leave' ||
      row.status === 'late_early'
    ) {
      group.hasAttendance = true;
    }
    grouped.set(row.employee.id, group);
  }

  const items: NoPunchAlert[] = [...grouped.values()]
    .filter((group) => group.absentDates.length > 0 && !group.hasAttendance)
    .map((group) => {
      const emp = group.employee;
      const firstAbsentDate = group.absentDates.reduce(
        (earliest, date) => (date < earliest ? date : earliest),
        group.absentDates[0],
      );
      return {
        employeeId: emp.id,
        name: emp.displayName?.trim() || emp.name,
        code: emp.code?.trim() || emp.identificationId?.trim() || '',
        locationId: emp.locationId,
        locationName: emp.workLocation?.name ?? '',
        firstAbsentDate,
        absentDays: group.absentDates.length,
      };
    });

  items.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  cache = { computedAt: new Date(), items };
  logger.info(
    { count: items.length, windowDays: NO_PUNCH_WINDOW_DAYS },
    'No-punch alerts snapshot computed',
  );
  return items;
}

const STALE_MS = 15 * 60 * 1000;

/** Cached snapshot; recomputes if missing or older than 15 minutes. */
export async function getNoPunchAlerts(locationId?: string | null): Promise<NoPunchAlert[]> {
  const stale = !cache || Date.now() - cache.computedAt.getTime() > STALE_MS;
  if (stale && !computing) {
    computing = true;
    try {
      await computeNoPunchAlerts();
    } finally {
      computing = false;
    }
  }
  const items = cache?.items ?? [];
  if (locationId) return items.filter((i) => i.locationId === locationId);
  return items;
}
