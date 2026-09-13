import { describe, it, expect } from 'vitest';
import {
  addUtcDays,
  cairoDateOnly,
  cairoMonthRange,
  utcCalendarKey,
  utcDateOnly,
  utcEndOfDay,
} from '../../src/utils/payrollPeriod';

describe('UTC calendar-day helpers', () => {
  it('strips the time to UTC midnight', () => {
    // Instant that is still 9 June in UTC but already 10 June in UTC+2
    const localEvening = new Date('2026-06-09T22:30:00.000Z');
    const day = utcDateOnly(localEvening);
    expect(day.toISOString()).toBe('2026-06-09T00:00:00.000Z');
    expect(utcCalendarKey(localEvening)).toBe('2026-06-09');
  });

  it('does not shift when the server is east of UTC', () => {
    // new Date(y, m, d) would become the previous UTC day on Europe/Berlin.
    const constructedLocal = new Date(2026, 5, 10); // local midnight
    // utcDateOnly must read UTC components of whatever instant it receives.
    const fromUtc = utcDateOnly(new Date(Date.UTC(2026, 5, 10, 15, 0)));
    expect(fromUtc.toISOString()).toBe('2026-06-10T00:00:00.000Z');
    // Document the hazard: local construction is not a calendar day.
    expect(constructedLocal.toISOString()).not.toBe('2026-06-10T00:00:00.000Z');
  });

  it('adds whole UTC days across month boundaries', () => {
    const end = addUtcDays(new Date(Date.UTC(2026, 0, 31)), 1);
    expect(utcCalendarKey(end)).toBe('2026-02-01');
  });

  it('builds an inclusive UTC end of day', () => {
    const end = utcEndOfDay(new Date(Date.UTC(2026, 5, 10, 8, 0)));
    expect(end.toISOString()).toBe('2026-06-10T23:59:59.999Z');
  });
});

describe('Cairo business calendar day', () => {
  it('uses Africa/Cairo after UTC midnight while Egypt is still on the previous calendar day', () => {
    // 18 Aug 2026 00:30 Cairo = 17 Aug 21:30 UTC (EEST, UTC+3).
    const justAfterCairoMidnight = new Date('2026-08-17T21:30:00.000Z');
    expect(cairoDateOnly(justAfterCairoMidnight).toISOString()).toBe('2026-08-18T00:00:00.000Z');
    expect(utcDateOnly(justAfterCairoMidnight).toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  it('stays on the Cairo day until the next Cairo midnight', () => {
    const lateCairoEvening = new Date('2026-08-18T20:59:00.000Z'); // 23:59 Cairo
    expect(cairoDateOnly(lateCairoEvening).toISOString()).toBe('2026-08-18T00:00:00.000Z');
  });

  it('builds the Cairo month containing the instant', () => {
    const range = cairoMonthRange(new Date('2026-08-17T21:30:00.000Z'));
    expect(range.dateFrom.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(range.dateTo.toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });
});
