import { describe, expect, it } from 'vitest';

/**
 * Incomplete documents filter is always OR: an employee appears if they miss
 * at least one of the selected types (never only when they miss all).
 */
function decideInclude(args: {
  missingCount: number;
  requiredCount: number;
  filter: 'incomplete' | 'complete' | 'all';
}): boolean {
  const complete = args.missingCount === 0;
  if (args.filter === 'incomplete') return !complete;
  if (args.filter === 'complete') return complete;
  return true;
}

describe('documents report incomplete = OR', () => {
  it('includes employee missing only 1 of 9 selected', () => {
    expect(
      decideInclude({ missingCount: 1, requiredCount: 9, filter: 'incomplete' }),
    ).toBe(true);
  });

  it('includes employee missing all 9', () => {
    expect(
      decideInclude({ missingCount: 9, requiredCount: 9, filter: 'incomplete' }),
    ).toBe(true);
  });

  it('excludes fully complete employees from incomplete filter', () => {
    expect(
      decideInclude({ missingCount: 0, requiredCount: 9, filter: 'incomplete' }),
    ).toBe(false);
  });
});
