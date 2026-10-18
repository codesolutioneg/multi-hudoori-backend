import type { AttendanceEditRequest, LeaveRequest, ShiftChangeRequest } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { utcDateOnly } from '../utils/payrollPeriod';
import { flagsToLineData, parseCellFlags } from './shiftGridData.service';
import {
  PUNCH_STATE_CHECK_IN,
  PUNCH_STATE_CHECK_OUT,
  upsertAttendanceFromMobilePunches,
} from './mobileLocationPunch.service';
import { enumerateUtcDates } from './payrollCycleGuard.service';

export const PUNCH_SOURCE_REQUEST_FIX = 'request_fix';

function isSickLeaveType(leaveType: string): boolean {
  const t = leaveType.toLowerCase();
  return t.includes('sick') || t.includes('مرض');
}

/** Unpaid leave uses the existing grid «إجازة» (isOff) marker — not annual balance. */
function isUnpaidLeaveType(leaveType: string): boolean {
  const t = leaveType.toLowerCase();
  return (
    t.includes('unpaid') ||
    t.includes('بدون راتب') ||
    t.includes('بدون أجر') ||
    t.includes('غير مدفوع')
  );
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

function noGridCoverageError(dates: Date[]): AppError {
  const keys = dates.map((d) => d.toISOString().slice(0, 10));
  const from = keys[0] ?? '';
  const to = keys[keys.length - 1] ?? from;
  const period = !from ? '' : from === to ? from : `${from} → ${to}`;
  const periodPart = period ? `فترة الطلب (${period})` : 'أيام هذا الطلب';
  return new AppError(
    `لا يوجد جدول شيفت يغطي ${periodPart} لهذا الموظف — أنشئ جدول الشيفت لهذه الفترة أولاً ثم أعد الموافقة`,
    400,
    'NO_GRID_COVERAGE',
  );
}

/** Fail fast when any day has no shift-grid coverage for the employee. */
export async function assertEmployeeGridCoverage(employeeId: string, dates: Date[]): Promise<void> {
  if (!dates.length) return;
  const missing: Date[] = [];
  for (const day of dates) {
    const grid = await findGridForEmployeeDay(employeeId, day);
    if (!grid) missing.push(day);
  }
  if (missing.length) throw noGridCoverageError(missing);
}

async function upsertGridLineForDay(opts: {
  gridId: string;
  companyId: string;
  employeeId: string;
  day: Date;
  params: Record<string, unknown>;
}) {
  const { gridId, companyId, employeeId, day, params } = opts;
  const existing = await prisma.shiftGridLine.findUnique({
    where: { gridId_employeeId_date: { gridId, employeeId, date: day } },
    include: { shift: true },
  });
  const flags = parseCellFlags(params, existing?.shiftId ?? null);
  // Preserve mission markers unless the caller explicitly sets them (leave/shift
  // fulfill must not wipe an approved field-mission day).
  const lineData = {
    ...flagsToLineData(flags),
    isFieldMission:
      params.isFieldMission != null
        ? Boolean(params.isFieldMission)
        : (existing?.isFieldMission ?? flags.isFieldMission),
    fieldMissionRequestId:
      params.fieldMissionRequestId !== undefined
        ? (params.fieldMissionRequestId
            ? String(params.fieldMissionRequestId)
            : null)
        : (existing?.fieldMissionRequestId ?? flags.fieldMissionRequestId),
  };

  if (existing) {
    await prisma.shiftGridLine.update({ where: { id: existing.id }, data: lineData });
    return;
  }

  await prisma.shiftGridLine.create({
    data: {
      companyId,
      gridId,
      employeeId,
      date: day,
      ...lineData,
    },
  });

  const grid = await prisma.shiftGrid.findUnique({
    where: { id: gridId },
    select: { employeeIds: true },
  });
  if (grid && !grid.employeeIds.includes(employeeId)) {
    await prisma.shiftGrid.update({
      where: { id: gridId },
      data: { employeeIds: { push: employeeId } },
    });
  }
}

export async function fulfillApprovedLeaveRequest(req: LeaveRequest): Promise<void> {
  const employee = await prisma.employeeProfile.findUnique({
    where: { id: req.employeeId },
    select: { id: true, companyId: true },
  });
  if (!employee) throw new AppError('Employee not found', 404, 'NOT_FOUND');

  const sick = isSickLeaveType(req.leaveType);
  const unpaid = !sick && isUnpaidLeaveType(req.leaveType);
  const days = enumerateUtcDates(req.dateFrom, req.dateTo);
  await assertEmployeeGridCoverage(employee.id, days);

  for (const day of days) {
    const grid = await findGridForEmployeeDay(employee.id, day);
    if (!grid) throw noGridCoverageError([day]);

    // sick → مرضية; unpaid → «إجازة»/isOff (not annual balance); else → سنوية
    const cellParams: Record<string, unknown> = sick
      ? { isSick: true, isOff: true, shiftId: null }
      : unpaid
        ? { isOff: true, isAnnualLeave: false, isSick: false, shiftId: null }
        : { isAnnualLeave: true, shiftId: null };

    await upsertGridLineForDay({
      gridId: grid.id,
      companyId: employee.companyId,
      employeeId: employee.id,
      day,
      params: cellParams,
    });
  }
}

export async function fulfillApprovedShiftChangeRequest(req: ShiftChangeRequest): Promise<void> {
  const employee = await prisma.employeeProfile.findUnique({
    where: { id: req.employeeId },
    select: { id: true, companyId: true },
  });
  if (!employee) throw new AppError('Employee not found', 404, 'NOT_FOUND');

  const days = enumerateUtcDates(req.dateFrom, req.dateTo);
  await assertEmployeeGridCoverage(employee.id, days);

  for (const day of days) {
    const grid = await findGridForEmployeeDay(employee.id, day);
    if (!grid) throw noGridCoverageError([day]);

    await upsertGridLineForDay({
      gridId: grid.id,
      companyId: employee.companyId,
      employeeId: employee.id,
      day,
      params: {
        shiftId: req.newShiftId,
        isOff: false,
        isSick: false,
        isAnnualLeave: false,
        isExcluded: false,
      },
    });
  }
}

function parseWallClockOnDate(day: Date, raw: string | null | undefined): Date | null {
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).trim();
  if (s.includes('T')) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const base = utcDateOnly(day);
  return new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate(),
      Number(m[1]),
      Number(m[2]),
      Number(m[3] ?? 0),
    ),
  );
}

export async function fulfillApprovedAttendanceEditRequest(req: AttendanceEditRequest): Promise<void> {
  const employee = await prisma.employeeProfile.findUnique({
    where: { id: req.employeeId },
    select: { id: true, companyId: true, code: true, identificationId: true },
  });
  if (!employee) throw new AppError('Employee not found', 404, 'NOT_FOUND');

  const workDate = utcDateOnly(req.date);
  const checkIn = parseWallClockOnDate(workDate, req.requestedCheckIn);
  const checkOut = parseWallClockOnDate(workDate, req.requestedCheckOut);
  if (!checkIn && !checkOut) {
    throw new AppError('يجب تحديد وقت حضور أو انصراف', 400, 'VALIDATION');
  }

  const windowFrom = new Date(workDate.getTime() - 12 * 3600_000);
  const windowTo = new Date(workDate.getTime() + 36 * 3600_000);

  await prisma.transaction.deleteMany({
    where: {
      employeeId: employee.id,
      punchSource: PUNCH_SOURCE_REQUEST_FIX,
      punchTime: { gte: windowFrom, lte: windowTo },
    },
  });

  const empCode = employee.code ?? employee.identificationId ?? null;
  const rows: Array<{ punchTime: Date; isCheckIn: boolean }> = [];
  if (checkIn) rows.push({ punchTime: checkIn, isCheckIn: true });
  if (checkOut) rows.push({ punchTime: checkOut, isCheckIn: false });
  rows.sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());

  for (const row of rows) {
    await prisma.transaction.create({
      data: {
        companyId: employee.companyId,
        employeeId: employee.id,
        empCode,
        punchTime: row.punchTime,
        punchState: row.isCheckIn ? PUNCH_STATE_CHECK_IN : PUNCH_STATE_CHECK_OUT,
        punchSource: PUNCH_SOURCE_REQUEST_FIX,
        terminalSn: 'REQUEST_FIX',
        terminalAlias: 'تصحيح بصمة',
        isDuplicate: false,
      },
    });
  }

  const anchor = checkIn ?? checkOut!;
  await upsertAttendanceFromMobilePunches({
    companyId: employee.companyId,
    employeeId: employee.id,
    punchTime: anchor,
  });
}
