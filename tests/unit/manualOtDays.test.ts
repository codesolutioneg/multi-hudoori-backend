import { describe, it, expect } from 'vitest';
import { computeManualOtDays, computeOvertimeHours } from '../../src/services/shiftTime.service';

describe('manual OT days (÷9)', () => {
  it('converts excess hours to day fractions', () => {
    // net 12h, shift 9h → 3h / 9 = 0.33 days
    expect(computeManualOtDays(12, 9)).toBe(0.33);
  });

  it('returns 0 when not over shift length', () => {
    expect(computeManualOtDays(9, 9)).toBe(0);
    expect(computeManualOtDays(8, 9)).toBe(0);
  });

  it('keeps hour-based OT for non-manual path', () => {
    expect(computeOvertimeHours(12, 9)).toBe(3);
  });
});
