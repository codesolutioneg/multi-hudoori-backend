/**
 * Mobile GPS punches → same `transactions` table as BioTime.
 * Geofence math mirrors logic-d365-erm-main AttendanceGeofenceValidator.
 */
import { prisma } from '../prisma/client';
import { prismaBase } from '../prisma/client';
import { AppError, ForbiddenError, NotFoundError } from '../utils/errors';
import { getCompanyId } from '../tenant/context';
import { cairoDateOnly } from '../utils/payrollPeriod';
import {
  isCheckInState as punchIsCheckIn,
  isCheckOutState as punchIsCheckOut,
  roundHours,
} from './shiftTime.service';

export const MOBILE_GEO_TERMINAL_SN = 'MOBILE_GEO';
export const PUNCH_SOURCE_MOBILE = 'mobile_geo';
/** BioTime-compatible punch states used across reports. */
export const PUNCH_STATE_CHECK_IN = '0';
export const PUNCH_STATE_CHECK_OUT = '1';

const EARTH_RADIUS_METERS = 6371000;

export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const radLat1 = toRad(lat1);
  const radLat2 = toRad(lat2);
  const radLon1 = toRad(lon1);
  const radLon2 = toRad(lon2);
  let val =
    Math.cos(radLat1) * Math.cos(radLat2) * Math.cos(radLon2 - radLon1) +
    Math.sin(radLat1) * Math.sin(radLat2);
  val = Math.min(1, Math.max(-1, val));
  return EARTH_RADIUS_METERS * Math.acos(val);
}

export function isWithinGeofence(opts: {
  userLat: number;
  userLng: number;
  locationLat: number;
  locationLng: number;
  radiusMeters: number;
}): boolean {
  if (opts.radiusMeters <= 0) return false;
  return (
    distanceMeters(opts.userLat, opts.userLng, opts.locationLat, opts.locationLng) <=
    opts.radiusMeters
  );
}

function isCheckInState(state: string | null | undefined): boolean {
  if (punchIsCheckIn(state)) return true;
  const s = String(state ?? '').toLowerCase();
  return s.includes('check_in') || s === 'in';
}

function isCheckOutState(state: string | null | undefined): boolean {
  if (punchIsCheckOut(state)) return true;
  const s = String(state ?? '').toLowerCase();
  return s.includes('check_out') || s === 'out';
}

function cairoDayKey(d: Date): number {
  return cairoDateOnly(d).getTime();
}

type PunchJson = {
  id: string;
  punchTime: string;
  punchState: string | null;
  isCheckIn: boolean;
};

function punchJson(row: { id: string; punchTime: Date; punchState: string | null }): PunchJson {
  return {
    id: row.id,
    punchTime: row.punchTime.toISOString(),
    punchState: row.punchState,
    isCheckIn: isCheckInState(row.punchState),
  };
}

/** Employee "حضوري" reads `attendances`, not raw punches — keep a day row in sync. */
export async function upsertAttendanceFromMobilePunches(opts: {
  companyId: string;
  employeeId: string;
  punchTime: Date;
}) {
  const workDate = cairoDateOnly(opts.punchTime);
  const windowFrom = new Date(workDate.getTime() - 12 * 3600_000);
  const windowTo = new Date(workDate.getTime() + 36 * 3600_000);

  const punches = (
    await prisma.transaction.findMany({
      where: {
        employeeId: opts.employeeId,
        isDuplicate: false,
        punchTime: { gte: windowFrom, lte: windowTo },
      },
      orderBy: { punchTime: 'asc' },
    })
  ).filter((t) => cairoDayKey(t.punchTime) === workDate.getTime());

  const firstIn = punches.find((t) => isCheckInState(t.punchState)) ?? null;
  const outs = punches.filter((t) => isCheckOutState(t.punchState));
  const lastOut = outs.length ? outs[outs.length - 1] : null;

  let workedHours = 0;
  if (firstIn && lastOut && lastOut.punchTime > firstIn.punchTime) {
    workedHours = roundHours((lastOut.punchTime.getTime() - firstIn.punchTime.getTime()) / 3600000);
  }

  const data = {
    firstCheckIn: firstIn?.punchTime ?? null,
    lastCheckOut: lastOut?.punchTime ?? null,
    workedHours,
    netWorkedHours: workedHours,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeHours: 0,
    status: firstIn ? 'present' : 'absent',
  };

  const existing = await prisma.attendance.findUnique({
    where: { employeeId_date: { employeeId: opts.employeeId, date: workDate } },
  });
  if (existing) {
    await prisma.attendance.update({ where: { id: existing.id }, data });
    return;
  }
  await prisma.attendance.create({
    data: {
      companyId: opts.companyId,
      employeeId: opts.employeeId,
      date: workDate,
      ...data,
    },
  });
}

async function resolveEmployeeForUser(userId: string) {
  const profile = await prisma.employeeProfile.findFirst({
    where: { userId, active: true },
    include: {
      workLocation: true,
      company: { select: { id: true, code: true, name: true } },
    },
  });
  if (!profile) {
    throw new NotFoundError('Employee profile not found', 'EMPLOYEE_NOT_FOUND');
  }
  return profile;
}

export type MobilePunchContext = {
  enabled: boolean;
  reason?: string;
  company: { id: string; code: string; name: string } | null;
  location: {
    id: string;
    name: string;
    latitude: number | null;
    longitude: number | null;
    geofenceRadiusMeters: number;
  } | null;
  lastPunch: PunchJson | null;
  todayPunches: PunchJson[];
  nextAction: 'check_in' | 'check_out' | null;
  /** Approved field mission covering Cairo today — home geofence skipped on punch. */
  activeMission: {
    id: string;
    details: string;
    dateFrom: string;
    dateTo: string;
  } | null;
  geofenceRelaxed: boolean;
};

export async function getMobilePunchContext(userId: string): Promise<MobilePunchContext> {
  const employee = await resolveEmployeeForUser(userId);
  const company =
    employee.company != null
      ? {
          id: employee.company.id,
          code: employee.company.code,
          name: employee.company.name,
        }
      : null;

  const { findApprovedMissionForEmployeeDay } = await import(
    './fieldMissionRequest.service'
  );
  const today = cairoDateOnly();
  const mission = await findApprovedMissionForEmployeeDay(employee.id, today);
  const activeMission = mission
    ? {
        id: mission.id,
        details: mission.details,
        dateFrom: mission.dateFrom.toISOString().slice(0, 10),
        dateTo: mission.dateTo.toISOString().slice(0, 10),
      }
    : null;
  const geofenceRelaxed = Boolean(activeMission);

  if (!employee.locationId || !employee.workLocation) {
    return {
      enabled: false,
      reason: 'NO_LOCATION',
      company,
      location: null,
      lastPunch: null,
      todayPunches: [],
      nextAction: null,
      activeMission,
      geofenceRelaxed,
    };
  }

  const loc = employee.workLocation;
  const locationPayload = {
    id: loc.id,
    name: loc.name,
    latitude: loc.latitude,
    longitude: loc.longitude,
    geofenceRadiusMeters: loc.geofenceRadiusMeters ?? 200,
  };

  if (!loc.locationPunchEnabled) {
    return {
      enabled: false,
      reason: 'LOCATION_PUNCH_DISABLED',
      company,
      location: locationPayload,
      lastPunch: null,
      todayPunches: [],
      nextAction: null,
      activeMission,
      geofenceRelaxed,
    };
  }

  if (loc.latitude == null || loc.longitude == null) {
    return {
      enabled: false,
      reason: 'LOCATION_COORDS_MISSING',
      company,
      location: locationPayload,
      lastPunch: null,
      todayPunches: [],
      nextAction: null,
      activeMission,
      geofenceRelaxed,
    };
  }

  const windowFrom = new Date(today.getTime() - 12 * 3600_000);
  const punches = await prisma.transaction.findMany({
    where: {
      employeeId: employee.id,
      isDuplicate: false,
      punchTime: { gte: windowFrom },
    },
    orderBy: { punchTime: 'desc' },
  });

  const last = punches[0] ?? null;
  const lastPunch = last ? punchJson(last) : null;
  const todayPunches = punches
    .filter((t) => cairoDayKey(t.punchTime) === today.getTime())
    .map(punchJson)
    .reverse();

  const nextAction: 'check_in' | 'check_out' =
    lastPunch && lastPunch.isCheckIn ? 'check_out' : 'check_in';

  return {
    enabled: true,
    company,
    location: locationPayload,
    lastPunch,
    todayPunches,
    nextAction,
    activeMission,
    geofenceRelaxed,
  };
}

export async function submitMobilePunch(opts: {
  userId: string;
  isCheckIn: boolean;
  latitude: number;
  longitude: number;
  clientPunchAt?: Date | null;
}) {
  if (!Number.isFinite(opts.latitude) || !Number.isFinite(opts.longitude)) {
    throw new AppError('GPS coordinates are required', 400, 'GPS_REQUIRED');
  }

  const employee = await resolveEmployeeForUser(opts.userId);
  if (!employee.locationId || !employee.workLocation) {
    throw new ForbiddenError('Employee has no branch', 'NO_LOCATION');
  }

  const loc = employee.workLocation;
  if (!loc.locationPunchEnabled) {
    throw new ForbiddenError('Location punch is disabled for this branch', 'LOCATION_PUNCH_DISABLED');
  }
  if (loc.latitude == null || loc.longitude == null) {
    throw new AppError('Branch coordinates are not configured', 400, 'LOCATION_COORDS_MISSING');
  }

  const context = await getMobilePunchContext(opts.userId);
  const skipHomeGeofence = context.geofenceRelaxed === true;

  const radius = loc.geofenceRadiusMeters ?? 200;
  if (
    !skipHomeGeofence &&
    !isWithinGeofence({
      userLat: opts.latitude,
      userLng: opts.longitude,
      locationLat: loc.latitude,
      locationLng: loc.longitude,
      radiusMeters: radius,
    })
  ) {
    throw new AppError(
      'Attendance location is outside the allowed geofence',
      400,
      'GEOFENCE_VIOLATION',
    );
  }

  if (opts.isCheckIn && context.nextAction === 'check_out') {
    throw new AppError('Already checked in — use check-out', 400, 'ALREADY_CHECKED_IN');
  }
  if (!opts.isCheckIn && context.nextAction === 'check_in') {
    throw new AppError('Not checked in — use check-in first', 400, 'NOT_CHECKED_IN');
  }

  const punchTime = opts.clientPunchAt ?? new Date();
  const companyId = getCompanyId() ?? employee.companyId;

  const { resolveLocationDisplayName } = await import('./locationDisplayName.service');
  const locationDisplayName = await resolveLocationDisplayName({
    companyId,
    latitude: opts.latitude,
    longitude: opts.longitude,
    homeBranchName: loc.name,
  });

  const row = await prisma.transaction.create({
    data: {
      companyId,
      employeeId: employee.id,
      empCode: employee.code ?? employee.identificationId ?? null,
      punchTime,
      punchState: opts.isCheckIn ? PUNCH_STATE_CHECK_IN : PUNCH_STATE_CHECK_OUT,
      terminalSn: MOBILE_GEO_TERMINAL_SN,
      terminalAlias: skipHomeGeofence
        ? locationDisplayName || loc.name
        : loc.name,
      punchSource: PUNCH_SOURCE_MOBILE,
      latitude: opts.latitude,
      longitude: opts.longitude,
      locationDisplayName,
      isDuplicate: false,
    },
  });

  await upsertAttendanceFromMobilePunches({
    companyId,
    employeeId: employee.id,
    punchTime: row.punchTime,
  });

  return {
    transaction: {
      id: row.id,
      punchTime: row.punchTime.toISOString(),
      punchState: row.punchState,
      punchSource: row.punchSource,
      latitude: row.latitude,
      longitude: row.longitude,
      locationDisplayName: row.locationDisplayName,
      terminalSn: row.terminalSn,
      terminalAlias: row.terminalAlias,
      isCheckIn: opts.isCheckIn,
    },
    activeMission: context.activeMission,
    geofenceRelaxed: skipHomeGeofence,
    company: employee.company
      ? { id: employee.company.id, code: employee.company.code, name: employee.company.name }
      : null,
  };
}

/** Load company summary for login branding (unscoped by id). */
export async function getCompanySummary(companyId: string | null | undefined) {
  if (!companyId) return null;
  return prismaBase.company.findUnique({
    where: { id: companyId },
    select: { id: true, code: true, name: true },
  });
}
