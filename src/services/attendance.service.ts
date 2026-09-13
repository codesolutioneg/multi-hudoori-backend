import { Prisma, Shift } from '@prisma/client';
import { prisma } from '../prisma/client';
import {
  generatePunchReportLines,
  type PunchReportExportLine,
} from './punchReportLine.service';
import {
  calculateAttendanceStatus,
  getExpectedTimesForDate,
  isRestDay,
  roundHours,
} from './shiftTime.service';
import { cairoMonthRange } from '../utils/payrollPeriod';

async function assertAssignmentsExist(dateFrom: Date, dateTo: Date, employeeIds?: string[]) {
  const where: Prisma.ShiftAssignmentWhereInput = {
    active: true,
    dateFrom: { lte: dateTo },
    OR: [{ dateTo: null }, { dateTo: { gte: dateFrom } }],
  };
  if (employeeIds?.length) where.employeeId = { in: employeeIds };

  const assignmentCount = await prisma.shiftAssignment.count({ where });
  if (assignmentCount > 0) return;

  const gridWhere: Prisma.ShiftGridLineWhereInput = {
    date: { gte: dateFrom, lte: dateTo },
  };
  if (employeeIds?.length) gridWhere.employeeId = { in: employeeIds };

  const gridCount = await prisma.shiftGridLine.count({ where: gridWhere });
  if (gridCount > 0) return;

  throw new Error(
    'لا يمكن توليد سجلات الحضور! لا توجد شيفتات معينة للموظفين في الفترة المحددة. يرجى تعيين الشيفتات أولاً.',
  );
}

function workedHoursFromLine(line: PunchReportExportLine): number {
  if (line.firstCheckIn && line.lastCheckOut && line.lastCheckOut > line.firstCheckIn) {
    return roundHours((line.lastCheckOut.getTime() - line.firstCheckIn.getTime()) / 3600000);
  }
  return roundHours(line.netWorkedHours);
}

function statusFromPunchLine(line: PunchReportExportLine, shift: Shift | null): string {
  if (line.isAnnualLeave) return 'leave';
  if (line.isOffDay && line.shiftName.includes('مرض')) return 'sick';
  if (line.isOffDay) return 'off';
  if (line.shiftName === 'عدم احتساب يوم') return 'excluded';
  if (line.punchCount === 0) {
    if (shift && isRestDay(shift, line.punchDate)) return 'rest_day';
    if (line.isAbsent) return 'absent';
    return 'absent';
  }

  return calculateAttendanceStatus(line.firstCheckIn, line.lateMinutes, line.earlyLeaveMinutes);
}

function attendanceDataFromLine(
  line: PunchReportExportLine,
  shiftsById: Map<string, Shift>,
): {
  shiftId: string | null;
  expectedCheckIn: string | null;
  expectedCheckOut: string | null;
  firstCheckIn: Date | null;
  lastCheckOut: Date | null;
  workedHours: number;
  netWorkedHours: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeHours: number;
  status: string;
} {
  const shift = line.shiftId ? shiftsById.get(line.shiftId) ?? null : null;
  const expected = shift ? getExpectedTimesForDate(shift, line.punchDate) : null;

  return {
    shiftId: line.shiftId,
    expectedCheckIn: (expected?.checkIn ?? line.expectedCheckIn)?.toISOString() ?? null,
    expectedCheckOut: (expected?.checkOut ?? line.expectedCheckOut)?.toISOString() ?? null,
    firstCheckIn: line.firstCheckIn,
    lastCheckOut: line.lastCheckOut,
    workedHours: workedHoursFromLine(line),
    netWorkedHours: roundHours(line.netWorkedHours),
    lateMinutes: Math.round(line.lateMinutes),
    earlyLeaveMinutes: Math.round(line.earlyLeaveMinutes),
    overtimeHours: roundHours(line.overtimeHours),
    status: statusFromPunchLine(line, shift),
  };
}

function shouldIncludeLine(line: PunchReportExportLine, generateAbsences: boolean): boolean {
  if (!line.employeeId) return false;
  if (line.punchCount > 0) return true;
  if (!generateAbsences) return false;
  return line.isOffDay || line.isAnnualLeave || line.isAbsent || line.shiftName === 'عدم احتساب يوم';
}

export async function generateAttendance(options: {
  dateFrom: Date;
  dateTo: Date;
  employeeIds?: string[];
  shiftGridId?: string;
  deviceSns?: string[];
  skipExisting?: boolean;
  generateAbsences?: boolean;
  /** Fired periodically while writing attendance rows (for SyncJob progress UI). */
  onProgress?: (update: {
    current: number;
    total: number;
    created: number;
    updated: number;
    skipped: number;
  }) => void | Promise<void>;
}): Promise<{ created: number; updated: number; skipped: number }> {
  await assertAssignmentsExist(options.dateFrom, options.dateTo, options.employeeIds);

  const generateAbsences = options.generateAbsences !== false;
  const lines = await generatePunchReportLines({
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    employeeIds: options.employeeIds,
    shiftGridId: options.shiftGridId,
    deviceSns: options.deviceSns,
  });

  const workLines = lines.filter((line) => shouldIncludeLine(line, generateAbsences));
  const total = workLines.length;

  const shifts = await prisma.shift.findMany();
  const shiftsById = new Map(shifts.map((s) => [s.id, s]));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  const report = async (current: number) => {
    if (!options.onProgress) return;
    await options.onProgress({ current, total, created, updated, skipped });
  };

  await report(0);

  for (let i = 0; i < workLines.length; i++) {
    const line = workLines[i];
    const employeeId = line.employeeId!;
    const workDate = new Date(line.punchDate);
    workDate.setUTCHours(0, 0, 0, 0);

    if (options.skipExisting) {
      const exists = await prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId, date: workDate } },
      });
      if (exists) {
        skipped++;
        if ((i + 1) % 25 === 0 || i + 1 === total) await report(i + 1);
        continue;
      }
    }

    const data = attendanceDataFromLine(line, shiftsById);
    const existing = await prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId, date: workDate } },
    });

    if (existing) {
      await prisma.attendance.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.attendance.create({
        data: { employeeId, date: workDate, ...data },
      });
      created++;
    }

    if ((i + 1) % 25 === 0 || i + 1 === total) await report(i + 1);
  }

  return { created, updated, skipped };
}

export function currentMonthRange(ref = new Date()): { dateFrom: Date; dateTo: Date } {
  return cairoMonthRange(ref);
}

function employeeSearchFilter(search: string): Prisma.EmployeeProfileWhereInput {
  return {
    OR: [
      { name: { contains: search, mode: 'insensitive' } },
      { displayName: { contains: search, mode: 'insensitive' } },
      { code: { contains: search, mode: 'insensitive' } },
      { mapping: { firstName: { contains: search, mode: 'insensitive' } } },
      { mapping: { lastName: { contains: search, mode: 'insensitive' } } },
      { mapping: { biotimeEmpCode: { contains: search, mode: 'insensitive' } } },
    ],
  };
}

export async function listAttendance(filters: {
  dateFrom?: Date;
  dateTo?: Date;
  employeeId?: string;
  departmentId?: string;
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const defaults = currentMonthRange();
  const dateFrom = filters.dateFrom ?? defaults.dateFrom;
  const dateTo = filters.dateTo ?? defaults.dateTo;

  const where: Prisma.AttendanceWhereInput = {
    date: { gte: dateFrom, lte: dateTo },
  };
  if (filters.employeeId) where.employeeId = filters.employeeId;
  if (filters.status) where.status = filters.status;

  const search = filters.search?.trim();
  const employeeWhere: Prisma.EmployeeProfileWhereInput = { active: true };
  if (filters.departmentId) employeeWhere.departmentId = filters.departmentId;
  if (search) Object.assign(employeeWhere, employeeSearchFilter(search));
  where.employee = employeeWhere;

  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
  const offset = Math.max(0, filters.offset ?? 0);

  const [records, total, statusGroups] = await Promise.all([
    prisma.attendance.findMany({
      where,
      include: { employee: { include: { department: true, mapping: true } }, shift: true },
      orderBy: [{ date: 'desc' }, { employee: { name: 'asc' } }],
      skip: offset,
      take: limit,
    }),
    prisma.attendance.count({ where }),
    prisma.attendance.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    }),
  ]);

  const summary = { present: 0, absent: 0, late: 0, off: 0, leave: 0 };
  for (const row of statusGroups) {
    const count = row._count._all;
    if (row.status === 'present') summary.present += count;
    else if (row.status === 'absent') summary.absent += count;
    else if (row.status === 'late') summary.late += count;
    else if (row.status === 'off' || row.status === 'rest_day') summary.off += count;
    else if (row.status === 'leave' || row.status === 'sick') summary.leave += count;
  }

  return { records, total, dateFrom, dateTo, summary };
}
