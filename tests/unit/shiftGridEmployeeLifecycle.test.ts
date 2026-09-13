import { describe, expect, it } from 'vitest';
import {
  isActiveShiftCellFlags,
  isDepartureCellFlags,
  lifecycleActionFromFlags,
  mergeLifecycleActions,
} from '../../src/services/shiftGridEmployeeLifecycle.service';
import type { CellFlags } from '../../src/services/shiftGridData.service';

function flags(partial: Partial<CellFlags>): CellFlags {
  return {
    shiftId: null,
    isOff: false,
    isSick: false,
    isAnnualLeave: false,
    isExcluded: false,
    isBusDelay: false,
    isPresent: false,
    isFinished: false,
    isResignation: false,
    isWorkAbsence: false,
    isWorkInjury: false,
    isMarriageLeave: false,
    ...partial,
  };
}

describe('shiftGridEmployeeLifecycle helpers', () => {
  it('detects departure statuses', () => {
    expect(isDepartureCellFlags(flags({ isFinished: true }))).toBe(true);
    expect(isDepartureCellFlags(flags({ isResignation: true }))).toBe(true);
    expect(isDepartureCellFlags(flags({ isWorkAbsence: true }))).toBe(true);
    expect(isDepartureCellFlags(flags({ isSick: true }))).toBe(false);
    expect(isDepartureCellFlags(flags({ isOff: true }))).toBe(false);
  });

  it('detects real shift assignments', () => {
    expect(isActiveShiftCellFlags(flags({ shiftId: 'sh1' }))).toBe(true);
    expect(isActiveShiftCellFlags(flags({ isPresent: true }))).toBe(false);
    expect(isActiveShiftCellFlags(flags({ isFinished: true }))).toBe(false);
  });

  it('restore wins over archive in lifecycleActionFromFlags', () => {
    expect(lifecycleActionFromFlags(flags({ isFinished: true }))).toBe('archive');
    expect(lifecycleActionFromFlags(flags({ shiftId: 'sh1' }))).toBe('restore');
    // Combined shouldn't happen often; shiftId takes precedence
    expect(
      lifecycleActionFromFlags(flags({ shiftId: 'sh1', isFinished: true })),
    ).toBe('restore');
  });

  it('mergeLifecycleActions prefers restore', () => {
    expect(mergeLifecycleActions(['archive', 'none', 'restore'])).toBe('restore');
    expect(mergeLifecycleActions(['archive', 'none'])).toBe('archive');
    expect(mergeLifecycleActions(['none'])).toBe('none');
  });
});
