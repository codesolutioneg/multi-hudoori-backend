import { describe, it, expect } from 'vitest';
import {
  mergePayrollExcludedIds,
  shouldSkipPunchRebuild,
} from '../../src/services/payrollExclusion.service';

describe('mergePayrollExcludedIds', () => {
  it('adds deleted employees and drops them when re-added', () => {
    expect(mergePayrollExcludedIds(['a'], ['b'], [])).toEqual(['a', 'b']);
    expect(mergePayrollExcludedIds(['a', 'b'], [], ['b'])).toEqual(['a']);
    expect(mergePayrollExcludedIds(undefined, ['x'], ['x'])).toEqual([]);
  });
});

describe('shouldSkipPunchRebuild', () => {
  it('skips manual and excluded employees', () => {
    const manual = new Set(['m1']);
    const excluded = new Set(['e1']);
    expect(shouldSkipPunchRebuild('m1', manual, excluded)).toBe(true);
    expect(shouldSkipPunchRebuild('e1', manual, excluded)).toBe(true);
    expect(shouldSkipPunchRebuild('ok', manual, excluded)).toBe(false);
  });
});
