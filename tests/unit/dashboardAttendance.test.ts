import { describe, it, expect } from 'vitest';
import { attendanceDonutCounts } from '../../src/services/dashboard.service';

describe('attendanceDonutCounts', () => {
  it('counts only scheduled workers as present or absent', () => {
    const scheduled = ['a', 'b', 'c', 'd'];
    const present = new Set(['a', 'c', 'outsider']);
    expect(attendanceDonutCounts(scheduled, present)).toEqual({ present: 2, absent: 2 });
  });

  it('does not invent absents when nobody is scheduled', () => {
    expect(attendanceDonutCounts([], new Set(['a', 'b']))).toEqual({ present: 0, absent: 0 });
  });

  it('treats every scheduled id without a punch as absent', () => {
    expect(attendanceDonutCounts(['a', 'b', 'c'], new Set())).toEqual({ present: 0, absent: 3 });
  });
});
