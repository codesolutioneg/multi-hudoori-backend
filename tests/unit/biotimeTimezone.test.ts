import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  calendarDateKey,
  formatBioTimeDateTime,
  formatBioTimeRange,
  parseBioTimePunchTime,
  punchInstantToWallClock,
  wallClockHour,
} from '../../src/utils/biotimeTimezone';

describe('parseBioTimePunchTime', () => {
  it('parses the BioTime "YYYY-MM-DD HH:MM:SS" form as wall clock', () => {
    const d = parseBioTimePunchTime('2026-06-01 08:05:00');
    expect(d?.toISOString()).toBe('2026-06-01T08:05:00.000Z');
  });

  it('accepts an ISO T separator', () => {
    expect(parseBioTimePunchTime('2026-06-01T08:05:00')?.toISOString()).toBe(
      '2026-06-01T08:05:00.000Z',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(parseBioTimePunchTime('  2026-06-01 08:05:00  ')?.toISOString()).toBe(
      '2026-06-01T08:05:00.000Z',
    );
  });

  it('returns null for unparseable input', () => {
    expect(parseBioTimePunchTime('not a date')).toBeNull();
    expect(parseBioTimePunchTime('')).toBeNull();
  });
});

describe('punchInstantToWallClock', () => {
  it('shifts a UTC instant into Cairo wall-clock encoded as UTC', () => {
    // Cairo is UTC+3 in June (DST)
    const wall = punchInstantToWallClock(new Date('2026-06-01T05:00:00.000Z'));
    expect(wall.toISOString()).toBe('2026-06-01T08:00:00.000Z');
  });

  it('accepts an explicit timezone', () => {
    const wall = punchInstantToWallClock(new Date('2026-06-01T05:00:00.000Z'), 'UTC');
    expect(wall.toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });

  it('normalises hour 24 at local midnight to 00:xx on the same day', () => {
    const wall = punchInstantToWallClock(new Date('2026-06-01T21:00:00.000Z'));
    expect(wall.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });

  it('defaults to Africa/Cairo', () => {
    expect(DEFAULT_TIMEZONE).toBe('Africa/Cairo');
  });
});

describe('wallClockHour', () => {
  it('returns a fractional hour from a wall-clock date', () => {
    expect(wallClockHour(new Date('2026-06-01T08:30:00.000Z'))).toBe(8.5);
    expect(wallClockHour(new Date('2026-06-01T00:00:00.000Z'))).toBe(0);
    expect(wallClockHour(new Date('2026-06-01T23:59:59.000Z'))).toBeCloseTo(24, 2);
  });
});

describe('calendarDateKey', () => {
  it('returns the UTC calendar day', () => {
    expect(calendarDateKey(new Date('2026-06-01T23:59:59.000Z'))).toBe('2026-06-01');
  });
});

describe('formatBioTimeRange', () => {
  it('spans full days for the BioTime API filter', () => {
    expect(
      formatBioTimeRange(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T00:00:00Z')),
    ).toEqual({
      start_time: '2026-06-01 00:00:00',
      end_time: '2026-06-30 23:59:59',
    });
  });

  it('omits absent bounds', () => {
    expect(formatBioTimeRange()).toEqual({});
    expect(formatBioTimeRange(new Date('2026-06-01T00:00:00Z'))).toEqual({
      start_time: '2026-06-01 00:00:00',
    });
  });
});

describe('formatBioTimeDateTime', () => {
  it('renders a Cairo wall-clock string', () => {
    expect(formatBioTimeDateTime(new Date('2026-06-01T05:00:00.000Z'))).toBe('2026-06-01 08:00:00');
  });

  it('honours an explicit timezone', () => {
    expect(formatBioTimeDateTime(new Date('2026-06-01T05:00:00.000Z'), 'UTC')).toBe(
      '2026-06-01 05:00:00',
    );
  });

  it('round-trips through parseBioTimePunchTime', () => {
    const instant = new Date('2026-06-01T05:00:00.000Z');
    const str = formatBioTimeDateTime(instant, 'UTC');
    expect(parseBioTimePunchTime(str)?.toISOString()).toBe(instant.toISOString());
  });
});
