import { describe, it, expect } from 'vitest';
import {
  compareShiftsForDisplay,
  computeIsOvernight,
  computeTotalHours,
  floatToTimeString,
  isRamadanShift,
  parseTimeToFloat,
  shiftJsonExtras,
  shiftTimesFromParams,
  sortShiftsForDisplay,
  validateShiftTimes,
} from '../../src/services/shiftCalculations.service';

describe('parseTimeToFloat', () => {
  it('passes through an in-range float hour', () => {
    expect(parseTimeToFloat(8.5)).toBe(8.5);
    expect(parseTimeToFloat(0)).toBe(0);
    expect(parseTimeToFloat(23.99)).toBe(23.99);
  });

  it('parses HH:MM strings', () => {
    expect(parseTimeToFloat('08:30')).toBe(8.5);
    expect(parseTimeToFloat('17:00')).toBe(17);
    expect(parseTimeToFloat('00:15')).toBe(0.25);
  });

  it('uses the fallback for null and empty input', () => {
    expect(parseTimeToFloat(null)).toBe(8);
    expect(parseTimeToFloat('')).toBe(8);
    expect(parseTimeToFloat(undefined, 17)).toBe(17);
  });

  it('treats a sub-1 number as an hour count, not an Excel day fraction', () => {
    // Documents the live behaviour: 0.5 is 00:30, never 12:00.
    expect(parseTimeToFloat(0.5)).toBe(0.5);
  });
});

describe('floatToTimeString', () => {
  it('formats whole and half hours', () => {
    expect(floatToTimeString(8)).toBe('08:00');
    expect(floatToTimeString(8.5)).toBe('08:30');
    expect(floatToTimeString(17.25)).toBe('17:15');
    expect(floatToTimeString(0)).toBe('00:00');
  });

  it('never emits a 60-minute value when rounding up', () => {
    expect(floatToTimeString(8.999)).toBe('09:00');
  });

  it('clamps a near-midnight value instead of wrapping it to 00:00', () => {
    // Wrapping would render a late end time as midnight while isOvernight
    // stayed false, which collapses the shift's expected hours to zero.
    expect(floatToTimeString(23.999)).toBe('23:59');
    expect(floatToTimeString(24)).toBe('23:59');
  });

  it('clamps a negative or non-finite value to 00:00', () => {
    expect(floatToTimeString(-5)).toBe('00:00');
    expect(floatToTimeString(NaN)).toBe('00:00');
  });

  it('keeps a near-midnight shift end usable end to end', () => {
    const out = shiftTimesFromParams({ startTime: 8, endTime: 23.999 });
    expect(out.endTime).toBe('23:59');
    expect(out.isOvernight).toBe(false);
    // Re-parsing the stored string must still yield a full working day, not zero.
    expect(parseTimeToFloat(out.endTime) - parseTimeToFloat(out.startTime)).toBeGreaterThan(15);
  });

  it('round-trips with parseTimeToFloat', () => {
    for (const v of [0, 6.25, 8.5, 13.75, 22]) {
      expect(parseTimeToFloat(floatToTimeString(v))).toBeCloseTo(v, 5);
    }
  });
});

describe('computeIsOvernight', () => {
  it('is true only when the end time is before the start time', () => {
    expect(computeIsOvernight(22, 6)).toBe(true);
    expect(computeIsOvernight(8, 17)).toBe(false);
    expect(computeIsOvernight(8, 8)).toBe(false);
  });
});

describe('computeTotalHours', () => {
  it('computes a normal day shift', () => {
    expect(computeTotalHours(8, 17)).toBe(9);
  });

  it('computes a 09:00 → 18:00 morning shift as nine hours', () => {
    expect(computeTotalHours(9, 18)).toBe(9);
    const times = shiftTimesFromParams({ startTime: '09:00', endTime: '18:00' });
    expect(times.startTime).toBe('09:00');
    expect(times.endTime).toBe('18:00');
    expect(times.isOvernight).toBe(false);
    expect(computeTotalHours(parseTimeToFloat(times.startTime), parseTimeToFloat(times.endTime))).toBe(9);
  });

  it('subtracts the break duration', () => {
    expect(computeTotalHours(8, 17, 1)).toBe(8);
  });

  it('wraps midnight for overnight shifts', () => {
    expect(computeTotalHours(22, 6)).toBe(8);
    expect(computeTotalHours(22, 6, 0.5)).toBe(7.5);
  });

  it('honours an explicit isOvernight override', () => {
    expect(computeTotalHours(8, 17, 0, true)).toBe(24 - 8 + 17);
  });

  it('never returns a negative total', () => {
    expect(computeTotalHours(8, 17, 100)).toBe(0);
  });

  it('rounds to two decimals', () => {
    expect(computeTotalHours(8.333, 17)).toBe(8.67);
  });
});

describe('validateShiftTimes', () => {
  it('accepts a valid range', () => {
    expect(validateShiftTimes(8, 17)).toBeNull();
    expect(validateShiftTimes(22, 6)).toBeNull();
  });

  it('rejects out-of-range hours', () => {
    expect(validateShiftTimes(-1, 17)).toBeTruthy();
    expect(validateShiftTimes(24, 17)).toBeTruthy();
    expect(validateShiftTimes(8, 24)).toBeTruthy();
  });

  it('rejects identical start and end', () => {
    expect(validateShiftTimes(8, 8)).toBeTruthy();
  });
});

describe('shiftTimesFromParams', () => {
  it('derives display strings, overnight flag and totals', () => {
    const out = shiftTimesFromParams({ startTime: '22:00', endTime: '06:00', breakDuration: 1 });
    expect(out).toMatchObject({
      startFloat: 22,
      endFloat: 6,
      startTime: '22:00',
      endTime: '06:00',
      isOvernight: true,
      totalHours: 7,
    });
  });

  it('applies grace-period defaults and aliases', () => {
    expect(shiftTimesFromParams({})).toMatchObject({ gracePeriodIn: 20, gracePeriodOut: 15 });
    expect(shiftTimesFromParams({ checkInGrace: 5, checkOutGrace: 3 })).toMatchObject({
      gracePeriodIn: 5,
      gracePeriodOut: 3,
    });
  });

  it('parses string booleans for isOvernight rather than coercing them', () => {
    expect(shiftTimesFromParams({ startTime: '08:00', endTime: '17:00', isOvernight: 'true' }).isOvernight).toBe(true);
    expect(shiftTimesFromParams({ startTime: '22:00', endTime: '06:00', isOvernight: 'false' }).isOvernight).toBe(false);
  });

  it('normalises workDateReference to start|end', () => {
    expect(shiftTimesFromParams({ workDateReference: 'end' }).workDateReference).toBe('end');
    expect(shiftTimesFromParams({ workDateReference: 'nonsense' }).workDateReference).toBe('start');
    expect(shiftTimesFromParams({}).workDateReference).toBe('start');
  });

  it('defaults the times to 08:00–17:00', () => {
    expect(shiftTimesFromParams({})).toMatchObject({ startTime: '08:00', endTime: '17:00' });
  });
});

describe('shiftJsonExtras', () => {
  it('exposes floats plus display strings', () => {
    expect(shiftJsonExtras('08:00', '17:00', 1)).toEqual({
      startTime: 8,
      endTime: 17,
      startTimeDisplay: '08:00',
      endTimeDisplay: '17:00',
      isOvernight: false,
      totalHours: 8,
    });
  });
});

describe('isRamadanShift', () => {
  it('detects Arabic and English names', () => {
    expect(isRamadanShift({ name: 'شيفت رمضان' })).toBe(true);
    expect(isRamadanShift({ name: 'Ramadan Morning' })).toBe(true);
  });

  it('detects an R-prefixed code', () => {
    expect(isRamadanShift({ code: 'R 1' })).toBe(true);
    expect(isRamadanShift({ code: 'R.2' })).toBe(true);
    expect(isRamadanShift({ code: 'R3' })).toBe(true);
  });

  it('does not fire on unrelated shifts', () => {
    expect(isRamadanShift({ name: 'Morning', code: 'M1' })).toBe(false);
    expect(isRamadanShift({})).toBe(false);
  });
});

describe('shift display ordering', () => {
  it('places midnight 12am after C.11', () => {
    const shifts = [
      { name: 'شيفت 12 صباحاً', code: 'SH 12 M', startTime: 0 },
      { name: 'C.11', code: 'C.11', startTime: 23 },
      { name: 'Morning', code: 'M', startTime: 8 },
    ];
    expect(sortShiftsForDisplay(shifts).map((s) => s.code)).toEqual([
      'M',
      'C.11',
      'SH 12 M',
    ]);
  });

  it('does not mutate the input array', () => {
    const shifts = [{ name: 'B', startTime: 16 }, { name: 'A', startTime: 8 }];
    sortShiftsForDisplay(shifts);
    expect(shifts.map((s) => s.name)).toEqual(['B', 'A']);
  });

  it('falls back to startTimeStored when startTime is not numeric', () => {
    const a = { name: 'A', startTimeStored: '14:00' };
    const b = { name: 'B', startTimeStored: '07:00' };
    expect(compareShiftsForDisplay(a, b)).toBeGreaterThan(0);
  });

  it('breaks ties on name', () => {
    expect(compareShiftsForDisplay({ name: 'A', startTime: 8 }, { name: 'B', startTime: 8 })).toBeLessThan(0);
  });
});
