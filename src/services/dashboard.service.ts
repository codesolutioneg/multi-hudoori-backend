import { RequestState } from '@prisma/client';
import { prisma } from '../prisma/client';
import {
  addUtcDays,
  cairoDateOnly,
  utcCalendarKey,
  utcDateOnly,
  utcEndOfDay,
} from '../utils/payrollPeriod';
import { BioTimeConnector, BioTimeTerminal } from './biotime/biotimeConnector.service';
import { logger } from '../utils/logger';

const DEVICE_FETCH_TIMEOUT_MS = 4000;

export interface ChartSlice {
  label: string;
  labelAr?: string;
  count: number;
  color: string;
}

export interface TrendPoint {
  date: string;
  absent: number;
  late: number;
  earlyLeave: number;
}

export interface RecentPunch {
  employeeName: string;
  deviceName: string;
  punchType: string;
  punchTime: string;
  punchDate: string;
  isToday: boolean;
}

function startOfDay(d: Date): Date {
  return utcDateOnly(d);
}

function endOfDay(d: Date): Date {
  return utcEndOfDay(d);
}

function addDays(d: Date, days: number): Date {
  return addUtcDays(d, days);
}

/** UTC calendar date key — matches @db.Date / wall-clock-as-UTC punches. */
function formatUtcDate(d: Date): string {
  return utcCalendarKey(d);
}

function parseBioTimeDate(value?: string | null): Date | null {
  if (!value) return null;
  const normalized = value.replace('T', ' ').replace('Z', '').slice(0, 19);
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function classifyDevice(terminal: BioTimeTerminal): 'online' | 'offline' | 'unauthorized' {
  const state = terminal.state;
  if (state === 2 || state === '2' || state === 'unauthorized') return 'unauthorized';

  const now = Date.now();
  const lastAct = parseBioTimeDate(terminal.last_activity ?? terminal.push_time);
  if (lastAct && now - lastAct.getTime() < 5 * 60 * 1000) return 'online';
  return 'offline';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function countRequestsByState(state: RequestState): Promise<number> {
  const [leave, loan, shift] = await Promise.all([
    prisma.leaveRequest.count({ where: { state } }),
    prisma.loanRequest.count({ where: { state } }),
    prisma.shiftChangeRequest.count({ where: { state } }),
  ]);
  return leave + loan + shift;
}

async function fetchLiveDeviceCounts(): Promise<{ online: number; offline: number; unauthorized: number }> {
  const connector = await BioTimeConnector.fromDb();
  let online = 0;
  let offline = 0;
  let unauthorized = 0;
  let page = 1;

  while (page <= 5) {
    const response = await connector.getDevices(page, 200);
    const rows = response.data ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const status = classifyDevice(row);
      if (status === 'online') online++;
      else if (status === 'unauthorized') unauthorized++;
      else offline++;
    }
    if (!response.next) break;
    page++;
  }

  return { online, offline, unauthorized };
}

async function getDeviceStatusSlices(): Promise<ChartSlice[]> {
  let online = 0;
  let offline = 0;
  let unauthorized = 0;

  try {
    const counts = await withTimeout(fetchLiveDeviceCounts(), DEVICE_FETCH_TIMEOUT_MS);
    online = counts.online;
    offline = counts.offline;
    unauthorized = counts.unauthorized;
  } catch (err) {
    logger.warn({ err }, 'Dashboard: live device status unavailable, using DB fallback');
    const total = await prisma.device.count();
    offline = total;
  }

  return [
    { label: 'Online', labelAr: 'متصل', count: online, color: '#22C55E' },
    { label: 'Offline', labelAr: 'غير متصل', count: offline, color: '#F59E0B' },
    { label: 'Unauthorized', labelAr: 'غير مصرح', count: unauthorized, color: '#3B82F6' },
  ];
}

function attendanceSlices(
  present: number,
  absent: number,
): ChartSlice[] {
  return [
    { label: 'Present', labelAr: 'حاضر', count: present, color: '#22C55E' },
    { label: 'Absent', labelAr: 'غائب', count: absent, color: '#F59E0B' },
  ];
}

export function attendanceDonutCounts(
  scheduledIds: Iterable<string>,
  presentIds: Set<string>,
): { present: number; absent: number } {
  let present = 0;
  let absent = 0;
  for (const id of scheduledIds) {
    if (presentIds.has(id)) present++;
    else absent++;
  }
  return { present, absent };
}

async function scheduledWorkEmployeeIds(day: Date): Promise<string[]> {
  const lines = await prisma.shiftGridLine.findMany({
    where: {
      date: day,
      isOff: false,
      isExcluded: false,
      isAnnualLeave: false,
      isSick: false,
      isResignation: false,
      employee: { active: true },
      OR: [
        { shiftId: { not: null } },
        { isPresent: true },
        { isWorkAbsence: true },
        { isMarriageLeave: true },
      ],
    },
    select: { employeeId: true },
    distinct: ['employeeId'],
  });
  return lines.map((line) => line.employeeId);
}

async function presentEmployeeIdsFromTransactions(day: Date): Promise<Set<string>> {
  const dayStart = startOfDay(day);
  const dayEnd = endOfDay(day);
  const byEmployee = await prisma.transaction.groupBy({
    by: ['employeeId'],
    where: {
      punchTime: { gte: dayStart, lte: dayEnd },
      employeeId: { not: null },
    },
  });
  const ids = new Set(
    byEmployee
      .map((row) => row.employeeId)
      .filter((id): id is string => Boolean(id)),
  );
  if (ids.size > 0) return ids;

  const byCode = await prisma.transaction.findMany({
    where: {
      punchTime: { gte: dayStart, lte: dayEnd },
      empCode: { not: null },
      employeeId: null,
    },
    select: { empCode: true },
    distinct: ['empCode'],
  });
  const codes = byCode
    .map((row) => row.empCode)
    .filter((code): code is string => Boolean(code));
  if (!codes.length) return ids;
  const employees = await prisma.employeeProfile.findMany({
    where: { active: true, code: { in: codes } },
    select: { id: true },
  });
  for (const employee of employees) ids.add(employee.id);
  return ids;
}

async function getAttendanceSlices(
  today: Date,
): Promise<{ slices: ChartSlice[]; fromTransactions: boolean }> {
  const scheduledIds = await scheduledWorkEmployeeIds(today);
  const punchPresentIds = await presentEmployeeIdsFromTransactions(today);
  const records = await prisma.attendance.findMany({
    where: { date: today, employee: { active: true } },
    select: { employeeId: true, status: true },
  });
  const attendancePresentIds = new Set(
    records
      .filter((row) => row.status === 'present' || row.status === 'late')
      .map((row) => row.employeeId),
  );
  const presentIds = new Set([...punchPresentIds, ...attendancePresentIds]);
  if (scheduledIds.length > 0) {
    const marriageLines = await prisma.shiftGridLine.findMany({
      where: {
        date: today,
        isMarriageLeave: true,
        employee: { active: true },
      },
      select: { employeeId: true },
    });
    for (const line of marriageLines) presentIds.add(line.employeeId);
  }

  if (scheduledIds.length > 0) {
    const counts = attendanceDonutCounts(scheduledIds, presentIds);
    return {
      fromTransactions: punchPresentIds.size > 0,
      slices: attendanceSlices(counts.present, counts.absent),
    };
  }

  const attendanceAbsent = records.filter((row) => row.status === 'absent').length;
  const present = presentIds.size;
  return {
    fromTransactions: punchPresentIds.size > 0,
    slices: attendanceSlices(present, attendanceAbsent),
  };
}

async function getExceptionsTrend(days = 7): Promise<TrendPoint[]> {
  const today = cairoDateOnly();
  const from = addDays(today, -(days - 1));
  const todayKey = formatUtcDate(today);

  const records = await prisma.attendance.findMany({
    where: { date: { gte: from, lte: today }, employee: { active: true } },
    select: { date: true, status: true, lateMinutes: true, earlyLeaveMinutes: true },
  });

  const byDate = new Map<string, { absent: number; late: number; earlyLeave: number }>();
  for (let i = days - 1; i >= 0; i--) {
    byDate.set(formatUtcDate(addDays(today, -i)), { absent: 0, late: 0, earlyLeave: 0 });
  }

  for (const r of records) {
    const key = formatUtcDate(r.date);
    const bucket = byDate.get(key);
    if (!bucket) continue;
    if (r.status === 'absent') bucket.absent++;
    if (r.lateMinutes > 0) bucket.late++;
    if (r.earlyLeaveMinutes > 0) bucket.earlyLeave++;
  }

  const todayBucket = byDate.get(todayKey);
  if (todayBucket) {
    const scheduledIds = await scheduledWorkEmployeeIds(today);
    if (scheduledIds.length > 0) {
      const presentIds = await presentEmployeeIdsFromTransactions(today);
      todayBucket.absent = attendanceDonutCounts(scheduledIds, presentIds).absent;
    }
  }

  return [...byDate.entries()].map(([date, v]) => ({ date, ...v }));
}

async function getRecentPunches(limit = 20): Promise<RecentPunch[]> {
  const rows = await prisma.transaction.findMany({
    orderBy: { punchTime: 'desc' },
    take: limit,
    include: { employee: { select: { name: true } } },
  });

  const today = cairoDateOnly();
  return rows.map((t) => {
    const punchDt = t.punchTime;
    const isCheckIn = ['0', '2', '4'].includes(String(t.punchState ?? ''));
    return {
      employeeName: t.employee?.name ?? t.empCode ?? '—',
      deviceName: t.terminalAlias ?? t.terminalSn ?? '—',
      punchType: isCheckIn ? 'Check In' : 'Check Out',
      // punchTime is device wall-clock stored as UTC digits; read it back in UTC so the
      // displayed time is server-timezone-independent (no double offset).
      punchTime: punchDt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
      punchDate: formatUtcDate(punchDt),
      isToday: punchDt >= today,
    };
  });
}

export async function getDashboardCharts() {
  const today = cairoDateOnly();

  const [totalEmployees, scheduledCount, approved, pending, rejected] = await Promise.all([
    prisma.employeeProfile.count({ where: { active: true } }),
    prisma.shiftAssignment.findMany({
      where: {
        active: true,
        dateFrom: { lte: today },
        OR: [{ dateTo: null }, { dateTo: { gte: today } }],
      },
      select: { employeeId: true },
      distinct: ['employeeId'],
    }).then((rows) => rows.length),
    countRequestsByState(RequestState.approved),
    countRequestsByState(RequestState.pending),
    countRequestsByState(RequestState.rejected),
  ]);

  const notScheduled = Math.max(0, totalEmployees - scheduledCount);

  const attendanceResult = await getAttendanceSlices(today);

  const [approvals, schedule, deviceStatus, exceptionsTrend, recentPunches] = await Promise.all([
    Promise.resolve([
      { label: 'Approved', labelAr: 'موافق', count: approved, color: '#22C55E' },
      { label: 'Pending', labelAr: 'معلق', count: pending, color: '#3B82F6' },
      { label: 'Rejected', labelAr: 'مرفوض', count: rejected, color: '#F59E0B' },
    ] satisfies ChartSlice[]),
    Promise.resolve([
      { label: 'Scheduled', labelAr: 'مجدول', count: scheduledCount, color: '#22C55E' },
      { label: 'Not Scheduled', labelAr: 'غير مجدول', count: notScheduled, color: '#F59E0B' },
    ] satisfies ChartSlice[]),
    getDeviceStatusSlices(),
    getExceptionsTrend(7),
    getRecentPunches(20),
  ]);

  return {
    totalEmployees,
    approvals,
    schedule,
    deviceStatus,
    attendance: attendanceResult.slices,
    exceptionsTrend,
    recentPunches,
    dataSource: {
      attendanceFromTransactions: attendanceResult.fromTransactions,
      deviceStatusLive: true,
    },
  };
}
