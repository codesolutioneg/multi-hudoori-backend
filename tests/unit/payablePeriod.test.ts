import { describe, it, expect } from 'vitest';
import {
  calendarPeriodDays,
  payablePeriodPolicyFromConfig,
  resolvePayablePeriodDays,
  resolveFullPayrollPeriodDays,
} from '../../src/services/payablePeriod.service';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('payable period policy', () => {
  it('uses calendar length when fixed mode is off', () => {
    expect(calendarPeriodDays(day('2026-07-26'), day('2026-08-25'))).toBe(31);
    expect(
      resolvePayablePeriodDays(day('2026-07-26'), day('2026-08-25'), {
        fixedMonthDaysEnabled: false,
        fixedMonthDays: 30,
        absentForgivenDaysCount: 4,
      }),
    ).toBe(31);
  });

  it('uses fixed days when the payroll cycle has ended', () => {
    const policy = {
      fixedMonthDaysEnabled: true,
      fixedMonthDays: 30,
      absentForgivenDaysCount: 4,
    };
    expect(
      resolvePayablePeriodDays(day('2026-07-26'), day('2026-08-25'), policy, day('2026-08-30')),
    ).toBe(30);
    expect(resolvePayablePeriodDays(day('2026-02-01'), day('2026-02-28'), policy)).toBe(30);
  });

  it('returns full fixed month days regardless of today', () => {
    const policy = {
      fixedMonthDaysEnabled: true,
      fixedMonthDays: 30,
      absentForgivenDaysCount: 4,
    };
    expect(resolveFullPayrollPeriodDays(day('2026-07-26'), day('2026-08-25'), policy)).toBe(30);
    expect(
      resolvePayablePeriodDays(day('2026-07-26'), day('2026-08-25'), policy, day('2026-08-22')),
    ).toBe(28);
  });

  it('uses elapsed calendar days mid-cycle when fixed mode is on', () => {
    const policy = {
      fixedMonthDaysEnabled: true,
      fixedMonthDays: 30,
      absentForgivenDaysCount: 4,
    };
    expect(
      resolvePayablePeriodDays(day('2026-07-26'), day('2026-08-25'), policy, day('2026-08-22')),
    ).toBe(28);
  });

  it('must not pre-cap dateTo to today (loan-import bug → false full 30)', () => {
    // Punch report / fixed eligibility pass the scheduled month end; asOf=today
    // yields elapsed days. Pre-capping dateTo=today on a mid-cycle window must
    // still return elapsed calendar days — not jump to fixed 30.
    const policy = {
      fixedMonthDaysEnabled: true,
      fixedMonthDays: 30,
      absentForgivenDaysCount: 4,
    };
    const asOf = day('2026-09-14');
    expect(
      resolvePayablePeriodDays(day('2026-08-26'), day('2026-09-25'), policy, asOf),
    ).toBe(20);
    expect(
      resolvePayablePeriodDays(day('2026-08-26'), asOf, policy, asOf),
    ).toBe(20);
  });

  it('weekly punch-report windows use calendar days, not fixed 30', () => {
    const policy = {
      fixedMonthDaysEnabled: true,
      fixedMonthDays: 30,
      absentForgivenDaysCount: 4,
    };
    // Closed week (like Brisk strip 30 Aug → 5 Sep exported after the week ended).
    expect(
      resolvePayablePeriodDays(day('2026-08-30'), day('2026-09-05'), policy, day('2026-09-14')),
    ).toBe(7);
    expect(resolveFullPayrollPeriodDays(day('2026-08-30'), day('2026-09-05'), policy)).toBe(7);
  });

  it('full payroll month still resolves to fixed 30 when the cycle has ended', () => {
    const policy = {
      fixedMonthDaysEnabled: true,
      fixedMonthDays: 30,
      absentForgivenDaysCount: 4,
    };
    expect(
      resolvePayablePeriodDays(day('2026-08-26'), day('2026-09-25'), policy, day('2026-09-26')),
    ).toBe(30);
    expect(resolveFullPayrollPeriodDays(day('2026-08-26'), day('2026-09-25'), policy)).toBe(30);
  });

  it('caps open periods at today when fixed mode is off', () => {
    expect(
      resolvePayablePeriodDays(
        day('2026-07-26'),
        day('2026-08-25'),
        {
          fixedMonthDaysEnabled: false,
          fixedMonthDays: 30,
          absentForgivenDaysCount: 4,
        },
        day('2026-08-22'),
      ),
    ).toBe(28);
  });

  it('reads config defaults', () => {
    expect(payablePeriodPolicyFromConfig(null)).toEqual({
      fixedMonthDaysEnabled: false,
      fixedMonthDays: 30,
      absentForgivenDaysCount: 4,
    });
    expect(
      payablePeriodPolicyFromConfig({
        payrollFixedMonthDaysEnabled: true,
        payrollFixedMonthDays: 30,
        absentForgivenDaysCount: 4,
      } as never),
    ).toMatchObject({ fixedMonthDaysEnabled: true, fixedMonthDays: 30 });
  });
});
