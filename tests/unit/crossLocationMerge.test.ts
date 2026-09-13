import { describe, it, expect } from 'vitest';
import type { ShiftGridLine } from '@prisma/client';
import {
  filterLinesForHomeLocation,
  resolveEmployeeHomeBranchesFromLines,
} from '../../src/services/shiftGridCrossLocationMerge.service';

function line(
  employeeId: string,
  gridId: string,
  date: string,
): Pick<ShiftGridLine, 'employeeId' | 'gridId' | 'date'> {
  return { employeeId, gridId, date: new Date(`${date}T00:00:00.000Z`) };
}

describe('resolveEmployeeHomeBranchesFromLines (Option A)', () => {
  const weeklyGrids = [
    { id: 'w1', locationId: 'loc-a', dateFrom: new Date('2026-06-26T00:00:00.000Z') },
    { id: 'w2', locationId: 'loc-a', dateFrom: new Date('2026-07-03T00:00:00.000Z') },
    { id: 'w3', locationId: 'loc-b', dateFrom: new Date('2026-07-10T00:00:00.000Z') },
    { id: 'w4', locationId: 'loc-b', dateFrom: new Date('2026-07-17T00:00:00.000Z') },
  ];

  it('assigns home branch from the last week with lines in the period', () => {
    const lines = [
      line('emp1', 'w1', '2026-06-26'),
      line('emp1', 'w2', '2026-07-03'),
      line('emp1', 'w3', '2026-07-10'),
      line('emp1', 'w4', '2026-07-17'),
    ];
    const home = resolveEmployeeHomeBranchesFromLines({
      weeklyGrids,
      lines,
      dateFrom: new Date('2026-06-26T00:00:00.000Z'),
      dateTo: new Date('2026-07-25T00:00:00.000Z'),
    });
    expect(home.get('emp1')?.homeLocationId).toBe('loc-b');
    expect(home.get('emp1')?.homeGridId).toBe('w4');
  });

  it('ignores lines outside the payroll period', () => {
    const lines = [
      line('emp1', 'w1', '2026-06-20'),
      line('emp1', 'w4', '2026-07-17'),
    ];
    const home = resolveEmployeeHomeBranchesFromLines({
      weeklyGrids,
      lines,
      dateFrom: new Date('2026-06-26T00:00:00.000Z'),
      dateTo: new Date('2026-07-25T00:00:00.000Z'),
    });
    expect(home.get('emp1')?.homeLocationId).toBe('loc-b');
  });

  it('keeps single-location employees on their only branch', () => {
    const lines = [line('emp2', 'w1', '2026-06-27'), line('emp2', 'w2', '2026-07-04')];
    const home = resolveEmployeeHomeBranchesFromLines({
      weeklyGrids,
      lines,
      dateFrom: new Date('2026-06-26T00:00:00.000Z'),
      dateTo: new Date('2026-07-25T00:00:00.000Z'),
    });
    expect(home.get('emp2')?.homeLocationId).toBe('loc-a');
  });
});

describe('filterLinesForHomeLocation (Option A)', () => {
  const weeklyGrids = [
    { id: 'w1', locationId: 'loc-a', dateFrom: new Date('2026-06-26T00:00:00.000Z') },
    { id: 'w4', locationId: 'loc-b', dateFrom: new Date('2026-07-17T00:00:00.000Z') },
  ];
  const period = {
    dateFrom: new Date('2026-06-26T00:00:00.000Z'),
    dateTo: new Date('2026-07-25T00:00:00.000Z'),
  };

  it('collects all days for employees whose home is the target branch', () => {
    const allLines = [
      line('emp1', 'w1', '2026-06-26'),
      line('emp1', 'w4', '2026-07-17'),
    ] as ShiftGridLine[];
    const home = resolveEmployeeHomeBranchesFromLines({
      weeklyGrids,
      lines: allLines,
      ...period,
    });
    const result = filterLinesForHomeLocation({
      lines: allLines,
      homeByEmployee: home,
      targetLocationId: 'loc-b',
      ...period,
      sourceGridIds: new Set(['w4']),
    });
    expect(result.lines).toHaveLength(2);
    expect(result.importedEmployeeIds).toEqual(['emp1']);
    expect(result.excludedEmployeeIds).toEqual([]);
  });

  it('excludes employees who moved away from the target branch', () => {
    const allLines = [
      line('emp1', 'w1', '2026-06-26'),
      line('emp1', 'w4', '2026-07-17'),
    ] as ShiftGridLine[];
    const home = resolveEmployeeHomeBranchesFromLines({
      weeklyGrids,
      lines: allLines,
      ...period,
    });
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
