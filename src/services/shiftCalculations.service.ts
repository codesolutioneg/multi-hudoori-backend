import { normalizeShiftTime } from './shiftsExcel.service';

/** Odoo biotime.shift float time (8.5 = 08:30). */
export function parseTimeToFloat(value: unknown, fallback = 8): number {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && !Number.isNaN(value)) {
    if (value >= 0 && value < 24) return value;
    if (value >= 0 && value < 1) {
      const totalMins = Math.round(value * 24 * 60);
      return totalMins / 60;
    }
  }
  const normalized = normalizeShiftTime(value);
  const [h, m] = normalized.split(':').map((x) => parseInt(x, 10));
  return (h || 0) + (m || 0) / 60;
}

/** Last representable minute of a day, so a near-24 value never wraps to midnight. */
const MAX_TIME_MINUTES = 23 * 60 + 59;

export function floatToTimeString(floatTime: number): string {
  // Round to whole minutes first: 8.999 must render 09:00, never 08:60.
  // Clamp rather than wrap: 23.999 must stay a late end time, because rendering
  // it as 00:00 would make the shift look like it ends at midnight while
  // isOvernight stays false, collapsing expected hours to zero downstream.
  const rounded = Number.isFinite(floatTime) ? Math.round(floatTime * 60) : 0;
  const totalMinutes = Math.min(MAX_TIME_MINUTES, Math.max(0, rounded));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Odoo: is_overnight when end_time < start_time */
export function computeIsOvernight(startFloat: number, endFloat: number): boolean {
  return endFloat < startFloat;
}

/** Odoo _compute_total_hours */
export function computeTotalHours(
  startFloat: number,
  endFloat: number,
  breakDurationHours = 0,
  isOvernight?: boolean,
): number {
  const overnight = isOvernight ?? computeIsOvernight(startFloat, endFloat);
  const total = overnight ? 24 - startFloat + endFloat : endFloat - startFloat;
  return Math.max(0, Math.round((total - breakDurationHours) * 100) / 100);
}

export function validateShiftTimes(startFloat: number, endFloat: number): string | null {
  if (startFloat < 0 || startFloat >= 24) return 'وقت البداية يجب أن يكون بين 0 و 24';
  if (endFloat < 0 || endFloat >= 24) return 'وقت النهاية يجب أن يكون بين 0 و 24';
  if (startFloat === endFloat) return 'وقت البداية والنهاية لا يمكن أن يكونا متطابقين';
  return null;
}

export function shiftTimesFromParams(params: Record<string, unknown>) {
  const startFloat = parseTimeToFloat(params.startTime, 8);
  const endFloat = parseTimeToFloat(params.endTime, 17);
  const breakDuration = Number(params.breakDuration ?? 0);
  const isOvernight =
    params.isOvernight === true || params.isOvernight === 'true'
      ? true
      : params.isOvernight === false || params.isOvernight === 'false'
        ? false
        : computeIsOvernight(startFloat, endFloat);

  return {
    startFloat,
    endFloat,
    startTime: floatToTimeString(startFloat),
    endTime: floatToTimeString(endFloat),
    isOvernight,
    breakDuration,
    totalHours: computeTotalHours(startFloat, endFloat, breakDuration, isOvernight),
    gracePeriodIn: Math.round(Number(params.gracePeriodIn ?? params.checkInGrace ?? 20)),
    gracePeriodOut: Math.round(Number(params.gracePeriodOut ?? params.checkOutGrace ?? 15)),
    workDateReference: String(params.workDateReference ?? 'start') === 'end' ? 'end' : 'start',
    earlyCheckinThreshold: Number(params.earlyCheckinThreshold ?? 2),
    lateCheckoutThreshold: Number(params.lateCheckoutThreshold ?? 4),
    restDays: params.restDays != null ? String(params.restDays) : null,
  };
}

export function shiftJsonExtras(startTime: string, endTime: string, breakDuration = 0, isOvernight?: boolean) {
  const startFloat = parseTimeToFloat(startTime);
  const endFloat = parseTimeToFloat(endTime);
  const overnight = isOvernight ?? computeIsOvernight(startFloat, endFloat);
  return {
    startTime: startFloat,
    endTime: endFloat,
    startTimeDisplay: floatToTimeString(startFloat),
    endTimeDisplay: floatToTimeString(endFloat),
    isOvernight: overnight,
    totalHours: computeTotalHours(startFloat, endFloat, breakDuration, overnight),
  };
}

export function isRamadanShift(shift: { name?: string | null; code?: string | null }): boolean {
  const name = (shift.name ?? '').toLowerCase();
  const code = (shift.code ?? '').trim().toLowerCase();
  return name.includes('رمضان') || name.includes('ramadan') || /^r[\s.\d]/.test(code);
}

export function shiftStartSortKey(shift: {
  name?: string | null;
  code?: string | null;
  startTime?: unknown;
  startTimeStored?: unknown;
}): number {
  const name = shift.name ?? '';
  const code = (shift.code ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  // Midnight "12 صباحا" belongs after 11pm (C.11), not at the top of the day.
  if (
    /12\s*صباح/.test(name) ||
    /^sh\s*12(\.0)?\s*m$/.test(code)
  ) {
    return 24;
  }

  let start = 8;
  if (typeof shift.startTime === 'number' && !Number.isNaN(shift.startTime)) {
    start = shift.startTime;
  } else if (shift.startTimeStored != null && shift.startTimeStored !== '') {
    start = parseTimeToFloat(shift.startTimeStored);
  } else {
    start = parseTimeToFloat(shift.startTime);
  }
  if (start < 1) return start + 24;
  return start;
}

export function compareShiftsForDisplay(
  a: { name?: string | null; code?: string | null; startTime?: unknown; startTimeStored?: unknown },
  b: { name?: string | null; code?: string | null; startTime?: unknown; startTimeStored?: unknown },
): number {
  const aRamadan = isRamadanShift(a);
  const bRamadan = isRamadanShift(b);
  if (aRamadan !== bRamadan) return aRamadan ? 1 : -1;

  const startDiff = shiftStartSortKey(a) - shiftStartSortKey(b);
  if (startDiff !== 0) return startDiff;

  return (a.name ?? '').localeCompare(b.name ?? '', 'ar');
}

export function sortShiftsForDisplay<T extends {
  name?: string | null;
  code?: string | null;
  startTime?: unknown;
  startTimeStored?: unknown;
}>(shifts: T[]): T[] {
  return [...shifts].sort(compareShiftsForDisplay);
}
