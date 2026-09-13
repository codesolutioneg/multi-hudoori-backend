import { RequestState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { generatePunchReportLines } from './punchReportLine.service';
import { computeOvertimeHours, shiftExpectedHours } from './shiftTime.service';
import { NotFoundError } from '../utils/errors';

export function overtimeJson(o: {
  id: string;
  employeeId: string;
  date: Date;
  shiftId: string | null;
  expectedHours: number;
  actualHours: number;
  overtimeHours: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  attendanceStatus: string;
  state: RequestState;
  rejectionReason: string | null;
  createdAt: Date;
  employee?: { id: string; name: string; code: string | null };
}) {
  return {
    id: o.id,
    employeeId: o.employeeId,
    employeeName: o.employee?.name ?? '',
    employeeCode: o.employee?.code ?? '',
    date: o.date.toISOString().slice(0, 10),
    shiftId: o.shiftId,
    expectedHours: o.expectedHours,
    actualHours: o.actualHours,
    overtimeHours: o.overtimeHours,
    lateMinutes: o.lateMinutes,
    earlyLeaveMinutes: o.earlyLeaveMinutes,
    attendanceStatus: o.attendanceStatus,
    state: o.state,
    rejectionReason: o.rejectionReason,
    createdAt: o.createdAt.toISOString(),
  };
}

function attendanceStatusFromMetrics(opts: {
  shiftId: string | null;
  firstCheckIn: Date | null;
  lastCheckOut: Date | null;
  expectedHours: number;
  actualHours: number;
  overtimeHours: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  graceIn: number;
  graceOut: number;
  isAbsent: boolean;
}): string {
  if (!opts.shiftId) return 'no_shift';
  if (!opts.firstCheckIn || opts.isAbsent) return 'absent';
  if (opts.overtimeHours >= 0.5) return 'overtime';
  if (opts.lateMinutes > opts.graceIn) return 'late';
  if (opts.earlyLeaveMinutes > opts.graceOut && opts.lastCheckOut) return 'early_leave';
  return 'on_time';
}

export async function generateOvertimeAnalysis(dateFrom: Date, dateTo: Date, employeeIds?: string[]) {
  const lines = await generatePunchReportLines({ dateFrom, dateTo, employeeIds });
  let created = 0;
  let updated = 0;

  const shifts = await prisma.shift.findMany();
  const shiftsById = new Map(shifts.map((s) => [s.id, s]));

  for (const line of lines) {
    if (!line.employeeId) continue;
    if (line.isOffDay && line.punchCount === 0) continue;

    const shift = line.shiftId ? shiftsById.get(line.shiftId) ?? null : null;
    const expectedHours = shift ? shiftExpectedHours(shift) : 0;
    const actualHours = line.netWorkedHours;
    const overtimeHours = computeOvertimeHours(actualHours, expectedHours);

    const graceIn = shift?.gracePeriodIn ?? 20;
    const graceOut = shift?.gracePeriodOut ?? 15;

    const attendanceStatus = attendanceStatusFromMetrics({
      shiftId: line.shiftId,
      firstCheckIn: line.firstCheckIn,
      lastCheckOut: line.lastCheckOut,
      expectedHours,
      actualHours,
      overtimeHours,
      lateMinutes: line.lateMinutes,
      earlyLeaveMinutes: line.earlyLeaveMinutes,
      graceIn,
      graceOut,
      isAbsent: line.isAbsent,
    });

    const data = {
      shiftId: line.shiftId,
      expectedHours,
      actualHours,
      overtimeHours,
      lateMinutes: line.lateMinutes,
      earlyLeaveMinutes: line.earlyLeaveMinutes,
      attendanceStatus,
    };

    const existing = await prisma.overtimeAnalysis.findUnique({
      where: { employeeId_date: { employeeId: line.employeeId, date: line.punchDate } },
    });

    if (existing) {
      await prisma.overtimeAnalysis.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.overtimeAnalysis.create({
        data: { employeeId: line.employeeId, date: line.punchDate, ...data, state: RequestState.pending },
      });
      created++;
    }
  }

  return { created, updated };
}

export async function listOvertime(state?: RequestState) {
  return prisma.overtimeAnalysis.findMany({
    where: state ? { state } : undefined,
    include: { employee: true },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function approveOvertime(id: string, approverId: string) {
  const row = await prisma.overtimeAnalysis.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Overtime record not found');
  return prisma.overtimeAnalysis.update({
    where: { id },
    data: { state: RequestState.approved, approvedById: approverId, rejectionReason: null },
    include: { employee: true },
  });
}

export async function rejectOvertime(id: string, approverId: string, reason: string) {
  const row = await prisma.overtimeAnalysis.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Overtime record not found');
  return prisma.overtimeAnalysis.update({
    where: { id },
    data: { state: RequestState.rejected, approvedById: approverId, rejectionReason: reason },
    include: { employee: true },
  });
}
