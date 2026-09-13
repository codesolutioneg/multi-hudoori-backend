import { describe, it, expect } from 'vitest';
import type { Shift } from '@prisma/client';
import {
  CHECK_IN_STATES,
  CHECK_OUT_STATES,
  calculateAttendanceStatus,
  computeAttendanceMetrics,
  computeOvertimeHours,
  finalizeOvertimeHours,
  getExpectedTimesForDate,
  getWorkDateForPunch,
  isCheckInState,
  isCheckOutState,
  isRestDay,
  jsToOdooWeekday,
  parseRestDays,
  roundHours,
  shiftEndFloat,
  shiftExpectedHours,
  shiftStartFloat,
} from '../../src/services/shiftTime.service';

/** Wall-clock instant stored as UTC (matches BioTime punch encoding). */
function wall(y: number, m: number, d: number, h = 0, min = 0, s = 0): Date {
  return new Date(Date.UTC(y, m, d, h, min, s));
}

function shift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: 'shift-1',
    name: 'Morning',
    code: 'M1',
    startTime: '08:00',
    endTime: '17:00',
    isOvernight: false,
    breakDuration: 0,
    gracePeriodIn: 20,
    gracePeriodOut: 15,
    workDateReference: 'start',
    earlyCheckinThreshold: 2,
    lateCheckoutThreshold: 2,
    restDays: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Shift;
}

describe('punch state classification', () => {
  it('classifies BioTime check-in states', () => {
    for (const s of CHECK_IN_STATES) expect(isCheckInState(s)).toBe(true);
    for (const s of CHECK_OUT_STATES) expect(isCheckInState(s)).toBe(false);
  });

  it('classifies BioTime check-out states', () => {
    for (const s of CHECK_OUT_STATES) expect(isCheckOutState(s)).toBe(true);
  });

  it('treats null and unknown states as neither', () => {
    expect(isCheckInState(null)).toBe(false);
    expect(isCheckOutState(undefined)).toBe(false);
    expect(isCheckInState('9')).toBe(false);
  });
});

describe('jsToOdooWeekday', () => {
  it('maps Monday..Sunday to 0..6', () => {
    // 2026-06-01 is a Monday (UTC calendar day)
    expect(jsToOdooWeekday(wall(2026, 5, 1))).toBe(0);
    expect(jsToOdooWeekday(wall(2026, 5, 6))).toBe(5);
    expect(jsToOdooWeekday(wall(2026, 5, 7))).toBe(6);
  });
});

describe('shift hour helpers', () => {
  it('reads start and end as floats', () => {
    expect(shiftStartFloat(shift({ startTime: '08:30' }))).toBe(8.5);
    expect(shiftEndFloat(shift({ endTime: '17:15' }))).toBe(17.25);
  });

  it('computes expected hours net of break', () => {
    expect(shiftExpectedHours(shift())).toBe(9);
    expect(shiftExpectedHours(shift({ breakDuration: 1 }))).toBe(8);
  });

  it('computes expected hours for overnight shifts', () => {
    expect(shiftExpectedHours(shift({ startTime: '22:00', endTime: '06:00', isOvernight: true }))).toBe(8);
  });
});

describe('overtime rounding', () => {
  it('rounds hours to two decimals', () => {
    expect(roundHours(8.126)).toBe(8.13);
  });

  it('drops overtime below the 15-minute floor', () => {
    expect(finalizeOvertimeHours(0.2)).toBe(0);
    expect(finalizeOvertimeHours(0.25)).toBe(0.25);
    expect(finalizeOvertimeHours(1.333)).toBe(1.33);
  });

  it('returns zero when the shift has no expected hours', () => {
    expect(computeOvertimeHours(10, 0)).toBe(0);
  });

  it('returns zero when worked hours do not exceed expected', () => {
    expect(computeOvertimeHours(8, 9)).toBe(0);
    expect(computeOvertimeHours(9, 9)).toBe(0);
  });

  it('returns the excess above expected hours', () => {
    expect(computeOvertimeHours(11, 9)).toBe(2);
  });

  it('ignores an excess under 15 minutes', () => {
    expect(computeOvertimeHours(9.1, 9)).toBe(0);
  });
});

describe('parseRestDays', () => {
  it('parses comma, semicolon and space separated lists', () => {
    expect([...parseRestDays('4,5')]).toEqual([4, 5]);
    expect([...parseRestDays('4;5')]).toEqual([4, 5]);
    expect([...parseRestDays('4 5')]).toEqual([4, 5]);
  });

  it('returns an empty set for blank input', () => {
    expect(parseRestDays(null).size).toBe(0);
    expect(parseRestDays('   ').size).toBe(0);
  });

  it('discards out-of-range and non-numeric entries', () => {
    expect([...parseRestDays('0,6,7,-1,abc')]).toEqual([0, 6]);
  });

  it('deduplicates', () => {
    expect([...parseRestDays('5,5,5')]).toEqual([5]);
  });
});

describe('isRestDay', () => {
  it('is false when the shift declares no rest days', () => {
    expect(isRestDay(shift(), wall(2026, 5, 5))).toBe(false);
    expect(isRestDay(null, wall(2026, 5, 5))).toBe(false);
  });

  it('matches the configured weekday', () => {
    // 2026-06-06 is a Saturday → Odoo weekday 5
    expect(isRestDay(shift({ restDays: '5' }), wall(2026, 5, 6))).toBe(true);
    expect(isRestDay(shift({ restDays: '5' }), wall(2026, 5, 5))).toBe(false);
  });
});

describe('getWorkDateForPunch', () => {
  it('returns the punch day for a day shift', () => {
    const d = getWorkDateForPunch(shift(), wall(2026, 5, 10, 8, 5));
    expect(d.getUTCDate()).toBe(10);
  });

  it('assigns an early-morning punch to the previous day for a start-referenced overnight shift', () => {
    const s = shift({ startTime: '22:00', endTime: '06:00', isOvernight: true, workDateReference: 'start' });
    const d = getWorkDateForPunch(s, wall(2026, 5, 10, 2, 0));
    expect(d.getUTCDate()).toBe(9);
  });

  it('keeps a late-evening punch on the same day for a start-referenced overnight shift', () => {
    const s = shift({ startTime: '22:00', endTime: '06:00', isOvernight: true, workDateReference: 'start' });
    const d = getWorkDateForPunch(s, wall(2026, 5, 10, 22, 30));
    expect(d.getUTCDate()).toBe(10);
  });

  it('shifts a late-evening punch forward for an end-referenced overnight shift', () => {
    const s = shift({ startTime: '22:00', endTime: '06:00', isOvernight: true, workDateReference: 'end' });
    const d = getWorkDateForPunch(s, wall(2026, 5, 10, 22, 30));
    expect(d.getUTCDate()).toBe(11);
  });
});

describe('getExpectedTimesForDate', () => {
  it('puts both ends on the work date for a day shift', () => {
    const { checkIn, checkOut } = getExpectedTimesForDate(shift(), wall(2026, 5, 10));
    expect(checkIn.getUTCHours()).toBe(8);
    expect(checkOut.getUTCHours()).toBe(17);
    expect(checkIn.getUTCDate()).toBe(10);
    expect(checkOut.getUTCDate()).toBe(10);
  });

  it('rolls check-out to the next day for a start-referenced overnight shift', () => {
    const s = shift({ startTime: '22:00', endTime: '06:00', isOvernight: true });
    const { checkIn, checkOut } = getExpectedTimesForDate(s, wall(2026, 5, 10));
    expect(checkIn.getUTCDate()).toBe(10);
    expect(checkOut.getUTCDate()).toBe(11);
  });

  it('rolls check-in to the previous day for an end-referenced overnight shift', () => {
    const s = shift({
      startTime: '22:00',
      endTime: '06:00',
      isOvernight: true,
      workDateReference: 'end',
    });
    const { checkIn, checkOut } = getExpectedTimesForDate(s, wall(2026, 5, 10));
    expect(checkIn.getUTCDate()).toBe(9);
    expect(checkOut.getUTCDate()).toBe(10);
  });

  it('handles half-hour boundaries', () => {
    const { checkIn } = getExpectedTimesForDate(shift({ startTime: '08:30' }), wall(2026, 5, 10));
    expect(checkIn.getUTCMinutes()).toBe(30);
  });
});

describe('computeAttendanceMetrics', () => {
  it('returns zeroes when a punch is missing', () => {
    const m = computeAttendanceMetrics(shift(), null, null);
    expect(m).toMatchObject({ workedHours: 0, netWorkedHours: 0, lateMinutes: 0, overtimeHours: 0 });
    expect(m.expectedHours).toBe(9);
  });

  it('computes worked hours net of break', () => {
    const m = computeAttendanceMetrics(
      shift({ breakDuration: 1 }),
      wall(2026, 5, 10, 8, 0),
      wall(2026, 5, 10, 17, 0),
    );
    expect(m.workedHours).toBe(9);
    expect(m.netWorkedHours).toBe(8);
  });

  it('forgives lateness inside the grace window', () => {
    const m = computeAttendanceMetrics(
      shift({ gracePeriodIn: 20 }),
      wall(2026, 5, 10, 8, 15),
      wall(2026, 5, 10, 17, 0),
    );
    expect(m.lateMinutes).toBe(0);
  });

  it('counts full lateness once the grace window is exceeded', () => {
    const m = computeAttendanceMetrics(
      shift({ gracePeriodIn: 20 }),
      wall(2026, 5, 10, 8, 45),
      wall(2026, 5, 10, 17, 0),
    );
    expect(m.lateMinutes).toBe(45);
  });

  it('enforces a 20-minute floor on the check-in grace period', () => {
    const m = computeAttendanceMetrics(
      shift({ gracePeriodIn: 5 }),
      wall(2026, 5, 10, 8, 10),
      wall(2026, 5, 10, 17, 0),
    );
    expect(m.lateMinutes).toBe(0);
  });

  it('skips the late calculation when ignoreLate is set', () => {
    const m = computeAttendanceMetrics(
      shift(),
      wall(2026, 5, 10, 10, 0),
      wall(2026, 5, 10, 17, 0),
      { ignoreLate: true },
    );
    expect(m.lateMinutes).toBe(0);
  });

  it('records early leave beyond the check-out grace period', () => {
    const m = computeAttendanceMetrics(
      shift({ gracePeriodOut: 15 }),
      wall(2026, 5, 10, 8, 0),
      wall(2026, 5, 10, 16, 0),
    );
    expect(m.earlyLeaveMinutes).toBe(60);
  });

  it('forgives early leave inside the check-out grace period', () => {
    const m = computeAttendanceMetrics(
      shift({ gracePeriodOut: 15 }),
      wall(2026, 5, 10, 8, 0),
      wall(2026, 5, 10, 16, 50),
    );
    expect(m.earlyLeaveMinutes).toBe(0);
  });

  it('computes overtime past the expected hours', () => {
    const m = computeAttendanceMetrics(
      shift(),
      wall(2026, 5, 10, 8, 0),
      wall(2026, 5, 10, 19, 0),
    );
    expect(m.overtimeHours).toBe(2);
  });

  it('reports no expected hours and no overtime without a shift', () => {
    const m = computeAttendanceMetrics(
      null,
      wall(2026, 5, 10, 8, 0),
      wall(2026, 5, 10, 17, 0),
    );
    expect(m.expectedHours).toBe(0);
    expect(m.overtimeHours).toBe(0);
    expect(m.workedHours).toBe(9);
  });

  it('never produces negative net hours when the break exceeds time on site', () => {
    const m = computeAttendanceMetrics(
      shift({ breakDuration: 10 }),
      wall(2026, 5, 10, 8, 0),
      wall(2026, 5, 10, 12, 0),
    );
    expect(m.netWorkedHours).toBe(0);
  });
});

describe('calculateAttendanceStatus', () => {
  it('passes grid statuses straight through', () => {
    for (const s of ['leave', 'sick', 'off', 'excluded', 'rest_day']) {
      expect(calculateAttendanceStatus(new Date(), 0, 0, s)).toBe(s);
    }
  });

  it('marks a missing check-in absent', () => {
    expect(calculateAttendanceStatus(null, 0, 0)).toBe('absent');
  });

  it('classifies late, early and both', () => {
    const t = new Date();
    expect(calculateAttendanceStatus(t, 10, 0)).toBe('late');
    expect(calculateAttendanceStatus(t, 0, 10)).toBe('early_leave');
    expect(calculateAttendanceStatus(t, 10, 10)).toBe('late_early');
    expect(calculateAttendanceStatus(t, 0, 0)).toBe('present');
  });

  it('ignores an unrecognised grid status', () => {
    expect(calculateAttendanceStatus(new Date(), 0, 0, 'whatever')).toBe('present');
  });
});
