import { describe, it, expect } from 'vitest';
import {
  compareForGrouping,
  DEFAULT_GRID_GROUPING,
  groupKeyFor,
  parseGridGrouping,
  UNGROUPED_DEPARTMENT_LABEL,
  UNGROUPED_JOB_LABEL,
  ungroupedLabelFor,
} from '../../src/services/shiftGridGrouping.service';

const emp = (jobTitle: string | null, department: string | null, name = 'x') => ({
  jobTitle,
  department: department == null ? null : { name: department },
  name,
});

describe('parseGridGrouping', () => {
  it('accepts the known groupings', () => {
    expect(parseGridGrouping('job')).toBe('job');
    expect(parseGridGrouping('department')).toBe('department');
  });

  it('falls back to job for anything else', () => {
    expect(parseGridGrouping('nonsense')).toBe(DEFAULT_GRID_GROUPING);
    expect(parseGridGrouping(undefined)).toBe('job');
    expect(parseGridGrouping(null)).toBe('job');
  });
});

describe('groupKeyFor', () => {
  it('groups by job title by default', () => {
    expect(groupKeyFor(emp('Cook', 'kitchen'), 'job')).toBe('Cook');
  });

  it('groups by department when asked', () => {
    expect(groupKeyFor(emp('Cook', 'kitchen'), 'department')).toBe('kitchen');
  });

  it('falls back to the ungrouped label per grouping', () => {
    expect(groupKeyFor(emp(null, 'kitchen'), 'job')).toBe(UNGROUPED_JOB_LABEL);
    expect(groupKeyFor(emp('Cook', null), 'department')).toBe(UNGROUPED_DEPARTMENT_LABEL);
    // Whitespace is not a department name.
    expect(groupKeyFor(emp('Cook', '   '), 'department')).toBe(UNGROUPED_DEPARTMENT_LABEL);
  });

  it('reports the matching ungrouped label', () => {
    expect(ungroupedLabelFor('job')).toBe(UNGROUPED_JOB_LABEL);
    expect(ungroupedLabelFor('department')).toBe(UNGROUPED_DEPARTMENT_LABEL);
  });
});

describe('compareForGrouping', () => {
  it('sorts by the grouping key then by name', () => {
    const rows = [
      emp('Cook', 'kitchen', 'زياد'),
      emp('Waiter', 'operation', 'أحمد'),
      emp('Cook', 'kitchen', 'باسم'),
    ];
    const byDepartment = [...rows].sort((a, b) => compareForGrouping(a, b, 'department'));
    expect(byDepartment.map((r) => `${r.department?.name}:${r.name}`)).toEqual([
      'kitchen:باسم',
      'kitchen:زياد',
      'operation:أحمد',
    ]);
  });

  it('pushes the ungrouped bucket to the end', () => {
    const rows = [emp('Cook', null, 'ب'), emp('Cook', 'kitchen', 'ج')];
    const sorted = [...rows].sort((a, b) => compareForGrouping(a, b, 'department'));
    expect(sorted.map((r) => r.department?.name ?? 'none')).toEqual(['kitchen', 'none']);
  });

  it('produces a stable order regardless of input order', () => {
    const rows = [
      emp('Waiter', 'operation', 'ج'),
      emp('Cook', 'kitchen', 'أ'),
      emp('Cook', null, 'ب'),
    ];
    const forward = [...rows].sort((a, b) => compareForGrouping(a, b, 'department'));
    const backward = [...rows].reverse().sort((a, b) => compareForGrouping(a, b, 'department'));
    expect(forward.map((r) => r.name)).toEqual(backward.map((r) => r.name));
  });
});
