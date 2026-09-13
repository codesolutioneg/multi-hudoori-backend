import { describe, it, expect } from 'vitest';
import { parseDateOnly } from '../../src/services/hiringAppointment.service';

describe('hiringAppointment parseDateOnly (UTC calendar day)', () => {
  it('keeps YYYY-MM-DD without timezone day-shift', () => {
    const d = parseDateOnly('2026-08-31', 'firstWorkingDay');
    expect(d.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(d.toISOString().slice(0, 10)).toBe('2026-08-31');
  });

  it('parses ISO datetime using UTC date parts', () => {
    const d = parseDateOnly('2026-08-31T21:00:00.000Z', 'appointmentDate');
    expect(d.toISOString().slice(0, 10)).toBe('2026-08-31');
  });

  it('rejects invalid values', () => {
    expect(() => parseDateOnly('not-a-date', 'appointmentDate')).toThrow(/غير صالح/);
  });
});
