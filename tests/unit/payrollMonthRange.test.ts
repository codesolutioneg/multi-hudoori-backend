import { describe, it, expect } from 'vitest';
import { payrollMonthRange } from '../../src/services/shiftGridMerge.service';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('payrollMonthRange', () => {
  it('matches the calendar month when the period starts on the 1st', () => {
    const range = payrollMonthRange(day('2026-06-15'), 1);
    expect(iso(range.dateFrom)).toBe('2026-06-01');
    expect(iso(range.dateTo)).toBe('2026-06-30');
  });

  it('spans two calendar months when the period starts mid-month', () => {
    // The branch closes on the 25th, so 26 June to 25 July is one period.
    const range = payrollMonthRange(day('2026-06-30'), 26);
    expect(iso(range.dateFrom)).toBe('2026-06-26');
    expect(iso(range.dateTo)).toBe('2026-07-25');
  });

  it('reaches back a month for a date before the start day', () => {
    const range = payrollMonthRange(day('2026-07-03'), 26);
    expect(iso(range.dateFrom)).toBe('2026-06-26');
    expect(iso(range.dateTo)).toBe('2026-07-25');
  });

  it('includes the start day itself in the new period', () => {
    const range = payrollMonthRange(day('2026-06-26'), 26);
    expect(iso(range.dateFrom)).toBe('2026-06-26');
  });

  it('handles a February period without losing days', () => {
    const range = payrollMonthRange(day('2026-02-10'), 26);
    expect(iso(range.dateFrom)).toBe('2026-01-26');
    expect(iso(range.dateTo)).toBe('2026-02-25');
  });

  it('crosses a year boundary', () => {
    const range = payrollMonthRange(day('2027-01-05'), 26);
    expect(iso(range.dateFrom)).toBe('2026-12-26');
    expect(iso(range.dateTo)).toBe('2027-01-25');
  });

  it('uses a month-end start day where the month has one', () => {
    // A branch closing on the 31st wants the 31st, not a value capped to 28.
    const march = payrollMonthRange(day('2026-04-10'), 31);
    expect(iso(march.dateFrom)).toBe('2026-03-31');
    expect(iso(march.dateTo)).toBe('2026-04-29');
  });

  it('falls back to the last day in shorter months', () => {
    // February has no 31st, so the period starts on the 28th that year.
    const range = payrollMonthRange(day('2026-03-10'), 31);
    expect(iso(range.dateFrom)).toBe('2026-02-28');
    expect(iso(range.dateTo)).toBe('2026-03-30');
  });

  it('handles a 30-day month for a 31st start day', () => {
    const range = payrollMonthRange(day('2026-05-05'), 31);
    expect(iso(range.dateFrom)).toBe('2026-04-30');
    expect(iso(range.dateTo)).toBe('2026-05-30');
  });

  it('uses the real last day of a leap February', () => {
    const range = payrollMonthRange(day('2028-03-10'), 31);
    expect(iso(range.dateFrom)).toBe('2028-02-29');
  });

  it('clamps a nonsense start day rather than producing an invalid range', () => {
    const zero = payrollMonthRange(day('2026-06-15'), 0);
    expect(iso(zero.dateFrom)).toBe('2026-06-01');
    const negative = payrollMonthRange(day('2026-06-15'), -5);
    expect(iso(negative.dateFrom)).toBe('2026-06-01');
  });

  it('always produces a from before its to', () => {
    for (const startDay of [1, 5, 15, 26, 28, 29, 30, 31]) {
      for (const date of ['2026-01-01', '2026-02-28', '2026-06-15', '2026-12-31']) {
        const range = payrollMonthRange(day(date), startDay);
        expect(range.dateFrom.getTime()).toBeLessThan(range.dateTo.getTime());
      }
    }
  });

  it('covers exactly 30 inclusive days for a 26→25 June/July period', () => {
    const range = payrollMonthRange(day('2026-07-10'), 26);
    expect(iso(range.dateFrom)).toBe('2026-06-26');
    expect(iso(range.dateTo)).toBe('2026-07-25');
    const days =
      Math.floor((range.dateTo.getTime() - range.dateFrom.getTime()) / 86400000) + 1;
    expect(days).toBe(30);
  });

  it('keeps four weekly buckets inside the 26→25 period without overlapping starts', () => {
    const range = payrollMonthRange(day('2026-07-01'), 26);
    const weeks = [
      ['2026-06-26', '2026-07-02'],
      ['2026-07-03', '2026-07-09'],
      ['2026-07-10', '2026-07-16'],
      ['2026-07-17', '2026-07-23'],
    ];
    for (const [from, to] of weeks) {
      expect(day(from).getTime()).toBeGreaterThanOrEqual(range.dateFrom.getTime());
      expect(day(to).getTime()).toBeLessThanOrEqual(range.dateTo.getTime());
    }
  });
});
