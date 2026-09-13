import type { Shift, ShiftAssignment } from '@prisma/client';
import { utcDateOnly } from '../utils/payrollPeriod';
import { jsToOdooWeekday } from './shiftTime.service';

function inDateRange(target: Date, from: Date, to: Date | null): boolean {
  const t = utcDateOnly(target).getTime();
  const f = utcDateOnly(from).getTime();
  if (t < f) return false;
  if (to && t > utcDateOnly(to).getTime()) return false;
  return true;
}

type WeekdayField = { shiftId: string | null; isOff: boolean };

function weekdayFields(a: ShiftAssignment, odooWeekday: number): WeekdayField {
  const map: WeekdayField[] = [
    { shiftId: a.mondayShiftId, isOff: a.mondayIsOff },
    { shiftId: a.tuesdayShiftId, isOff: a.tuesdayIsOff },
    { shiftId: a.wednesdayShiftId, isOff: a.wednesdayIsOff },
    { shiftId: a.thursdayShiftId, isOff: a.thursdayIsOff },
    { shiftId: a.fridayShiftId, isOff: a.fridayIsOff },
    { shiftId: a.saturdayShiftId, isOff: a.saturdayIsOff },
    { shiftId: a.sundayShiftId, isOff: a.sundayIsOff },
  ];
  return map[odooWeekday] ?? { shiftId: null, isOff: false };
}

function resolveWeeklyPattern(
  a: ShiftAssignment,
  odooWeekday: number,
  shiftsById: Map<string, Shift>,
): { shift: Shift | null; isOff: boolean } {
  const { shiftId, isOff } = weekdayFields(a, odooWeekday);
  if (isOff) return { shift: null, isOff: true };
  if (shiftId) {
    const shift = shiftsById.get(shiftId) ?? null;
    if (shift) return { shift, isOff: false };
  }
  if (a.shiftId) {
    const shift = shiftsById.get(a.shiftId) ?? null;
    if (shift) return { shift, isOff: false };
  }
  return { shift: null, isOff: false };
}

export type ShiftForDateResult = { shift: Shift | null; isOff: boolean };

/** Odoo biotime.shift.assignment.get_employee_shift_for_date */
export function getEmployeeShiftForDate(
  assignments: ShiftAssignment[],
  targetDate: Date,
  shiftsById: Map<string, Shift>,
): ShiftForDateResult {
  const odooWeekday = jsToOdooWeekday(targetDate);
  const active = assignments.filter((a) => a.active);

  const weeklyPeriod = active
    .filter((a) => a.assignmentType === 'weekly_period')
    .filter((a) => inDateRange(targetDate, a.dateFrom, a.dateTo))
    .sort((a, b) => b.dateFrom.getTime() - a.dateFrom.getTime());

  for (const a of weeklyPeriod) {
    return resolveWeeklyPattern(a, odooWeekday, shiftsById);
  }

  const dateRange = active
    .filter((a) => a.assignmentType === 'date_range')
    .filter((a) => inDateRange(targetDate, a.dateFrom, a.dateTo))
    .sort((a, b) => b.dateFrom.getTime() - a.dateFrom.getTime());

  if (dateRange.length > 0) {
    const shift = dateRange[0].shiftId ? shiftsById.get(dateRange[0].shiftId!) ?? null : null;
    return { shift, isOff: false };
  }

  const weekly = active.filter((a) => a.assignmentType === 'weekly');
  for (const a of weekly) {
    return resolveWeeklyPattern(a, odooWeekday, shiftsById);
  }

  const permanent = active.filter((a) => a.assignmentType === 'permanent');
  if (permanent.length > 0 && permanent[0].shiftId) {
    const shift = shiftsById.get(permanent[0].shiftId) ?? null;
    return { shift, isOff: false };
  }

  return { shift: null, isOff: false };
}

export const WEEKDAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type WeeklyPatternInput = Partial<
  Record<(typeof WEEKDAY_KEYS)[number], { shiftId?: string | null; isOff?: boolean }>
>;

export function weeklyPatternToAssignmentFields(
  weekly: WeeklyPatternInput | undefined,
): Partial<ShiftAssignment> {
  if (!weekly) return {};
  const fields: Partial<ShiftAssignment> = {};
  const map: Record<string, { shift: keyof ShiftAssignment; off: keyof ShiftAssignment }> = {
    monday: { shift: 'mondayShiftId', off: 'mondayIsOff' },
    tuesday: { shift: 'tuesdayShiftId', off: 'tuesdayIsOff' },
    wednesday: { shift: 'wednesdayShiftId', off: 'wednesdayIsOff' },
    thursday: { shift: 'thursdayShiftId', off: 'thursdayIsOff' },
    friday: { shift: 'fridayShiftId', off: 'fridayIsOff' },
    saturday: { shift: 'saturdayShiftId', off: 'saturdayIsOff' },
    sunday: { shift: 'sundayShiftId', off: 'sundayIsOff' },
  };
  for (const [day, cfg] of Object.entries(weekly)) {
    const m = map[day];
    if (!m || !cfg) continue;
    (fields as Record<string, unknown>)[m.shift as string] = cfg.shiftId ?? null;
    if (cfg.isOff !== undefined) {
      (fields as Record<string, unknown>)[m.off as string] = cfg.isOff;
    }
  }
  return fields;
}

export function assignmentToWeeklyPattern(a: ShiftAssignment): WeeklyPatternInput {
  return {
    monday: { shiftId: a.mondayShiftId, isOff: a.mondayIsOff },
    tuesday: { shiftId: a.tuesdayShiftId, isOff: a.tuesdayIsOff },
    wednesday: { shiftId: a.wednesdayShiftId, isOff: a.wednesdayIsOff },
    thursday: { shiftId: a.thursdayShiftId, isOff: a.thursdayIsOff },
    friday: { shiftId: a.fridayShiftId, isOff: a.fridayIsOff },
    saturday: { shiftId: a.saturdayShiftId, isOff: a.saturdayIsOff },
    sunday: { shiftId: a.sundayShiftId, isOff: a.sundayIsOff },
  };
}
