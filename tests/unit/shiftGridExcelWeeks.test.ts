import { describe, it, expect } from 'vitest';
import {
  buildWeekGroups,
  DEFAULT_WEEK_START_DAY,
  parseWeekStartDay,
} from '../../src/services/shiftGridExcelWeeks';

/** Consecutive days from an ISO date, as the export passes them. */
function days(startIso: string, count: number): { jsWeekday: number }[] {
  const start = new Date(`${startIso}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => ({
    jsWeekday: new Date(start.getTime() + i * 86400000).getUTCDay(),
  }));
}

describe('parseWeekStartDay', () => {
  it('accepts Sunday through Saturday', () => {
    expect(parseWeekStartDay(0)).toBe(0);
    expect(parseWeekStartDay(6)).toBe(6);
  });

  it('falls back to Sunday for anything out of range', () => {
    expect(parseWeekStartDay(7)).toBe(DEFAULT_WEEK_START_DAY);
    expect(parseWeekStartDay(-1)).toBe(DEFAULT_WEEK_START_DAY);
    expect(parseWeekStartDay('nonsense')).toBe(DEFAULT_WEEK_START_DAY);
    expect(parseWeekStartDay(null)).toBe(0);
  });
});

describe('buildWeekGroups', () => {
  it('returns nothing for an empty range', () => {
    expect(buildWeekGroups([])).toEqual([]);
  });

  it('groups a full Sunday-to-Saturday week as one block', () => {
    // 2026-06-07 is a Sunday.
    const groups = buildWeekGroups(days('2026-06-07', 7), 0);
    expect(groups).toHaveLength(1);
    expect(groups[0].colspan).toBe(7);
    expect(groups[0].label).toBe('الأسبوع الأول');
  });

  it('closes the week on Saturday rather than carrying it forward', () => {
    // Sunday 7 June to Sunday 14 June: 7 days, then a new block for the 14th.
    const groups = buildWeekGroups(days('2026-06-07', 8), 0);
    expect(groups.map((g) => g.colspan)).toEqual([7, 1]);
  });

  it('gives a range that starts mid-week its own leading block', () => {
    // Wednesday 10 June to Tuesday 16 June: 4 days to Saturday, then 3.
    const groups = buildWeekGroups(days('2026-06-10', 7), 0);
    expect(groups.map((g) => g.colspan)).toEqual([4, 3]);
  });

  it('splits four weeks of a month into four blocks', () => {
    const groups = buildWeekGroups(days('2026-06-07', 28), 0);
    expect(groups.map((g) => g.colspan)).toEqual([7, 7, 7, 7]);
    expect(groups.map((g) => g.label)).toEqual([
      'الأسبوع الأول',
      'الأسبوع الثاني',
      'الأسبوع الثالث',
      'الأسبوع الرابع',
    ]);
  });

  it('honours a different start weekday', () => {
    // Starting weeks on Saturday (6) shifts every boundary by one day.
    const groups = buildWeekGroups(days('2026-06-07', 8), 6);
    expect(groups.map((g) => g.colspan)).toEqual([6, 2]);
  });

  it('numbers beyond the named ordinals', () => {
    const groups = buildWeekGroups(days('2026-06-07', 7 * 7), 0);
    expect(groups).toHaveLength(7);
    expect(groups[6].label).toBe('الأسبوع 7');
  });
});
