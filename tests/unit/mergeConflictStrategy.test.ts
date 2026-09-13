import { describe, it, expect } from 'vitest';
import { parseMergeConflictStrategy } from '../../src/services/shiftGridMerge.service';

describe('parseMergeConflictStrategy', () => {
  it('defaults to latest_grid', () => {
    expect(parseMergeConflictStrategy(undefined)).toBe('latest_grid');
    expect(parseMergeConflictStrategy('')).toBe('latest_grid');
    expect(parseMergeConflictStrategy('nope')).toBe('latest_grid');
  });

  it('accepts known strategies', () => {
    expect(parseMergeConflictStrategy('latest_grid')).toBe('latest_grid');
    expect(parseMergeConflictStrategy('earliest_grid')).toBe('earliest_grid');
    expect(parseMergeConflictStrategy('fail')).toBe('fail');
  });
});
