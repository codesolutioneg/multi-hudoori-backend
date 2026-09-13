/**
 * Mobile GPS punches → same `transactions` table as BioTime.
 * Geofence math mirrors logic-d365-erm-main AttendanceGeofenceValidator.
 */
import { prisma } from '../prisma/client';
import { prismaBase } from '../prisma/client';
import { AppError, ForbiddenError, NotFoundError } from '../utils/errors';
import { getCompanyId } from '../tenant/context';

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
  const s = String(state ?? '').toLowerCase();
  return s === '0' || s === '2' || s === '4' || s === 'i' || s.includes('check_in') || s === 'in';
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
  lastPunch: {
    id: string;
    punchTime: string;
    punchState: string | null;
    isCheckIn: boolean;
  } | null;
  nextAction: 'check_in' | 'check_out' | null;
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

  if (!employee.locationId || !employee.workLocation) {
    return {
      enabled: false,
      reason: 'NO_LOCATION',
      company,
      location: null,
      lastPunch: null,
      nextAction: null,
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
      nextAction: null,
    };
  }

  if (loc.latitude == null || loc.longitude == null) {
    return {
      enabled: false,
      reason: 'LOCATION_COORDS_MISSING',
      company,
      location: locationPayload,
      lastPunch: null,
      nextAction: null,
    };
  }

  const last = await prisma.transaction.findFirst({
    where: {
      employeeId: employee.id,
      isDuplicate: false,
    },
    orderBy: { punchTime: 'desc' },
  });

  const lastPunch = last
    ? {
        id: last.id,
        punchTime: last.punchTime.toISOString(),
        punchState: last.punchState,
        isCheckIn: isCheckInState(last.punchState),
      }
    : null;

  const nextAction: 'check_in' | 'check_out' =
    lastPunch && lastPunch.isCheckIn ? 'check_out' : 'check_in';

  return {
    enabled: true,
    company,
    location: locationPayload,
    lastPunch,
    nextAction,
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

  const radius = loc.geofenceRadiusMeters ?? 200;
  if (
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

  const context = await getMobilePunchContext(opts.userId);
  if (opts.isCheckIn && context.nextAction === 'check_out') {
    throw new AppError('Already checked in — use check-out', 400, 'ALREADY_CHECKED_IN');
  }
  if (!opts.isCheckIn && context.nextAction === 'check_in') {
    throw new AppError('Not checked in — use check-in first', 400, 'NOT_CHECKED_IN');
  }

  const punchTime = opts.clientPunchAt ?? new Date();
  const companyId = getCompanyId() ?? employee.companyId;

  const row = await prisma.transaction.create({
    data: {
      companyId,
      employeeId: employee.id,
      empCode: employee.code ?? employee.identificationId ?? null,
      punchTime,
      punchState: opts.isCheckIn ? PUNCH_STATE_CHECK_IN : PUNCH_STATE_CHECK_OUT,
      terminalSn: MOBILE_GEO_TERMINAL_SN,
      terminalAlias: loc.name,
      punchSource: PUNCH_SOURCE_MOBILE,
      latitude: opts.latitude,
      longitude: opts.longitude,
      isDuplicate: false,
    },
  });

  return {
    transaction: {
      id: row.id,
      punchTime: row.punchTime.toISOString(),
      punchState: row.punchState,
      punchSource: row.punchSource,
      latitude: row.latitude,
      longitude: row.longitude,
      terminalSn: row.terminalSn,
      terminalAlias: row.terminalAlias,
      isCheckIn: opts.isCheckIn,
    },
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
