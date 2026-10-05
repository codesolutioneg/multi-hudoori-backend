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

const emp = (
  jobTitle: string | null,
  department: string | null,
  name = 'x',
  code = '',
) => ({
  jobTitle,
  department: department == null ? null : { name: department },
  name,
  code,
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
  it('sorts by the grouping key then by employee code ascending', () => {
    const rows = [
      emp('Cook', 'kitchen', 'زياد', '11028'),
      emp('Waiter', 'operation', 'أحمد', '8017'),
      emp('Cook', 'kitchen', 'باسم', '11019'),
    ];
    const byDepartment = [...rows].sort((a, b) => compareForGrouping(a, b, 'department'));
    expect(byDepartment.map((r) => `${r.department?.name}:${r.code}`)).toEqual([
      'kitchen:11019',
      'kitchen:11028',
      'operation:8017',
    ]);
  });

  it('uses numeric-aware code order within a section', () => {
    const rows = [
      emp('استيوارد', 'operation', 'أ', '11028'),
      emp('استيوارد', 'operation', 'ب', '11019'),
      emp('استيوارد', 'operation', 'ج', '11031'),
      emp('بار مان', 'operation', 'د', '11027'),
      emp('بار مان', 'operation', 'ه', '11006'),
      emp('بار مان', 'operation', 'و', '11023'),
    ];
    const sorted = [...rows].sort((a, b) => compareForGrouping(a, b, 'job'));
    // أقسام الوظائف بترتيب أبجدي عربي: استيوارد ثم بار مان؛ داخل كل قسم بالكود.
    expect(sorted.map((r) => r.code)).toEqual([
      '11019',
      '11028',
      '11031',
      '11006',
      '11023',
      '11027',
    ]);
  });

  it('prefers biotimeEmpCode over profile code when sorting', () => {
    const rows = [
      { jobTitle: 'Cook', name: 'أ', code: '99999', mapping: { biotimeEmpCode: '11028' } },
      { jobTitle: 'Cook', name: 'ب', code: '1', mapping: { biotimeEmpCode: '11019' } },
    ];
    const sorted = [...rows].sort((a, b) => compareForGrouping(a, b, 'job'));
    expect(sorted.map((r) => r.mapping.biotimeEmpCode)).toEqual(['11019', '11028']);
  });

  it('pushes the ungrouped bucket to the end', () => {
    const rows = [emp('Cook', null, 'ب', '2'), emp('Cook', 'kitchen', 'ج', '1')];
    const sorted = [...rows].sort((a, b) => compareForGrouping(a, b, 'department'));
    expect(sorted.map((r) => r.department?.name ?? 'none')).toEqual(['kitchen', 'none']);
  });

  it('produces a stable order regardless of input order', () => {
    const rows = [
      emp('Waiter', 'operation', 'ج', '3'),
      emp('Cook', 'kitchen', 'أ', '1'),
      emp('Cook', null, 'ب', '2'),
    ];
    const forward = [...rows].sort((a, b) => compareForGrouping(a, b, 'department'));
    const backward = [...rows].reverse().sort((a, b) => compareForGrouping(a, b, 'department'));
    expect(forward.map((r) => r.name)).toEqual(backward.map((r) => r.name));
  });
});
