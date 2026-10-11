import { describe, it, expect } from 'vitest';
import type { ShiftGridLine } from '@prisma/client';
import {
  filterLinesForHomeLocation,
  resolveEmployeeHomeBranchesFromCards,
} from '../../src/services/shiftGridCrossLocationMerge.service';

function line(
  employeeId: string,
  gridId: string,
  date: string,
): Pick<ShiftGridLine, 'employeeId' | 'gridId' | 'date'> {
  return { employeeId, gridId, date: new Date(`${date}T00:00:00.000Z`) };
}

describe('resolveEmployeeHomeBranchesFromCards (Option A)', () => {
  it('assigns home branch from the employee card, not the last week', () => {
    const home = resolveEmployeeHomeBranchesFromCards([
      { id: 'emp1', locationId: 'loc-a' },
    ]);
    expect(home.get('emp1')?.homeLocationId).toBe('loc-a');
  });

  it('skips employees with no card location', () => {
    const home = resolveEmployeeHomeBranchesFromCards([
      { id: 'emp1', locationId: null },
      { id: 'emp2', locationId: '  ' },
    ]);
    expect(home.has('emp1')).toBe(false);
    expect(home.has('emp2')).toBe(false);
  });

  it('keeps archived employees when the card location is still set', () => {
    const home = resolveEmployeeHomeBranchesFromCards([
      { id: 'archived', locationId: 'loc-bri-mad' },
    ]);
    expect(home.get('archived')?.homeLocationId).toBe('loc-bri-mad');
  });
});

describe('filterLinesForHomeLocation (Option A)', () => {
  const period = {
    dateFrom: new Date('2026-06-26T00:00:00.000Z'),
    dateTo: new Date('2026-07-25T00:00:00.000Z'),
  };

  it('collects all days when the card belongs to the target branch', () => {
    const allLines = [
      line('emp1', 'w1', '2026-06-26'),
      line('emp1', 'w4', '2026-07-17'),
    ] as ShiftGridLine[];
    const home = resolveEmployeeHomeBranchesFromCards([
      { id: 'emp1', locationId: 'loc-a' },
    ]);
    const result = filterLinesForHomeLocation({
      lines: allLines,
      homeByEmployee: home,
      targetLocationId: 'loc-a',
      ...period,
      sourceGridIds: new Set(['w1']),
    });
    expect(result.lines).toHaveLength(2);
    expect(result.importedEmployeeIds).toEqual(['emp1']);
    expect(result.excludedEmployeeIds).toEqual([]);
  });

  it('excludes employees whose card moved to another branch', () => {
    const allLines = [
      line('emp1', 'w1', '2026-06-26'),
      line('emp1', 'w4', '2026-07-17'),
    ] as ShiftGridLine[];
    const home = resolveEmployeeHomeBranchesFromCards([
      { id: 'emp1', locationId: 'loc-b' },
    ]);
    const result = filterLinesForHomeLocation({
      lines: allLines,
      homeByEmployee: home,
      targetLocationId: 'loc-a',
      ...period,
      sourceGridIds: new Set(['w1']),
    });
    expect(result.lines).toHaveLength(0);
    expect(result.excludedEmployeeIds).toEqual(['emp1']);
  });
});
