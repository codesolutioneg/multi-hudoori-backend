import { describe, it, expect } from 'vitest';
import { effectivePayrollEnd } from '../../src/utils/payrollPeriod';

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

const FROM = day('2026-07-01');
const TO = day('2026-07-31');

describe('effectivePayrollEnd', () => {
  it('pays an active employee for the whole period', () => {
    const end = effectivePayrollEnd(FROM, TO, { active: true });
    expect(end?.toISOString()).toBe(TO.toISOString());
  });

  it('truncates the period at the archive date', () => {
    const end = effectivePayrollEnd(FROM, TO, {
      active: false,
      archivedAt: day('2026-07-15'),
      departureDate: day('2026-07-15'),
    });
    expect(end?.toISOString()).toBe(day('2026-07-15').toISOString());
  });

  it('skips an employee archived before the period starts', () => {
    const end = effectivePayrollEnd(FROM, TO, {
      active: false,
      archivedAt: day('2026-06-10'),
      departureDate: day('2026-06-10'),
    });
    expect(end).toBeNull();
  });

  it('truncates on departureDate alone', () => {
    const end = effectivePayrollEnd(FROM, TO, { active: false, departureDate: day('2026-07-20') });
    expect(end?.toISOString()).toBe(day('2026-07-20').toISOString());
  });

  it('keeps the full period when the archive date is after the period', () => {
    const end = effectivePayrollEnd(FROM, TO, {
      active: false,
      archivedAt: day('2026-08-15'),
      departureDate: day('2026-08-15'),
    });
    expect(end?.toISOString()).toBe(TO.toISOString());
  });

  /**
   * restoreEmployee() keeps archivedAt on purpose as an audit trail and only
   * clears departureDate, so a restored (rehired) employee must be paid in
   * full: the stale archive stamp must not truncate or skip their payroll.
   */
  it('pays a restored employee for the whole period despite a stale archivedAt', () => {
    const end = effectivePayrollEnd(FROM, TO, {
      active: true,
      archivedAt: day('2026-07-10'),
      departureDate: null,
    });
    expect(end?.toISOString()).toBe(TO.toISOString());
  });

  it('does not skip a restored employee whose old archive predates the period', () => {
    const end = effectivePayrollEnd(FROM, TO, {
      active: true,
      archivedAt: day('2026-05-01'),
      departureDate: null,
    });
    expect(end).not.toBeNull();
    expect(end?.toISOString()).toBe(TO.toISOString());
  });
});
