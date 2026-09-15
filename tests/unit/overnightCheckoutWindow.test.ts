import { describe, it, expect } from 'vitest';
import {
  isWithinOvernightCheckoutWindow,
  isWithinDayShiftPastMidnightCheckoutWindow,
  getWorkDateForPunch,
  resolveLateCheckoutHours,
  resolveOvernightMorningAttribution,
} from '../../src/services/shiftTime.service';
import type { Shift } from '@prisma/client';

function shiftStub(partial: Partial<Shift> & Pick<Shift, 'startTime' | 'endTime'>): Shift {
  return {
    id: 's1',
    name: 'test',
    code: null,
    startTime: partial.startTime,
    endTime: partial.endTime,
    breakDuration: 0,
    isOvernight: partial.isOvernight ?? true,
    workDateReference: partial.workDateReference ?? 'start',
    earlyCheckinThreshold: partial.earlyCheckinThreshold ?? 2,
    lateCheckoutThreshold: partial.lateCheckoutThreshold ?? 4,
    restDays: null,
    gracePeriodIn: 20,
    gracePeriodOut: 15,
    sequence: 10,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

describe('dynamic overnight checkout window', () => {
  it('uses per-shift lateCheckoutThreshold (4h) for 02:00 end → keeps 05:00', () => {
    expect(
      isWithinOvernightCheckoutWindow(5, { endTime: '02:00', lateCheckoutThreshold: 4 }),
    ).toBe(true);
  });

  it('uses 5h threshold when configured on the shift', () => {
    expect(
      isWithinOvernightCheckoutWindow(6.5, { endTime: '02:00', lateCheckoutThreshold: 5 }),
    ).toBe(true);
    expect(
      isWithinOvernightCheckoutWindow(7.5, { endTime: '02:00', lateCheckoutThreshold: 5 }),
    ).toBe(false);
  });

  it('does not steal punches in the next day-shift early-check-in zone', () => {
    // Overnight ended 01:00 + 5h would reach 06:00, but next shift starts 09:00 with early 2h → bound 07:00.
    // Punch at 07:30 must NOT stay on overnight.
    expect(
      isWithinOvernightCheckoutWindow(7.5, { endTime: '01:00', lateCheckoutThreshold: 5 }, {
        lateCheckoutHours: 5,
        nextShiftStartHour: 9,
        nextShiftEarlyCheckinHours: 2,
      }),
    ).toBe(false);

    // Punch at 05:00 is still before early zone (07:00) and within 5h of 01:00 → overnight.
    expect(
      isWithinOvernightCheckoutWindow(5, { endTime: '01:00', lateCheckoutThreshold: 5 }, {
        lateCheckoutHours: 5,
        nextShiftStartHour: 9,
        nextShiftEarlyCheckinHours: 2,
      }),
    ).toBe(true);
  });

  it('keeps 03:03 on shift ending 01:00 with default 4h window', () => {
    expect(
      isWithinOvernightCheckoutWindow(3 + 3 / 60, {
        endTime: '01:00',
        lateCheckoutThreshold: 4,
      }),
    ).toBe(true);
  });

  it('resolveLateCheckoutHours falls back to company default', () => {
    expect(resolveLateCheckoutHours(null, 5)).toBe(5);
    expect(resolveLateCheckoutHours({ lateCheckoutThreshold: 3 }, 5)).toBe(3);
  });

  it('getWorkDateForPunch maps 05:00 calendar day → previous day for 16:00–02:00 @ 4h', () => {
    const shift = shiftStub({
      startTime: '16:00',
      endTime: '02:00',
      isOvernight: true,
      lateCheckoutThreshold: 4,
    });
    const punch = new Date(Date.UTC(2026, 6, 11, 5, 0, 0));
    expect(getWorkDateForPunch(shift, punch).toISOString().slice(0, 10)).toBe('2026-07-10');
  });

  it('day-shift past-midnight window keeps 00:28 after 21:30 end + 4h', () => {
    expect(
      isWithinDayShiftPastMidnightCheckoutWindow(0 + 28 / 3600, {
        endTime: '21:30',
        lateCheckoutThreshold: 4,
      }, { lateCheckoutHours: 4 }),
    ).toBe(true);
    expect(
      isWithinDayShiftPastMidnightCheckoutWindow(3, {
        endTime: '21:30',
        lateCheckoutThreshold: 4,
      }, { lateCheckoutHours: 4 }),
    ).toBe(false);
  });
});

describe('resolveOvernightMorningAttribution', () => {
  const overnight = {
    shift: {
      startTime: '16:00',
      endTime: '01:00',
      isOvernight: true,
      lateCheckoutThreshold: 4,
    },
    isOff: false,
  };
  const leaveDay = {
    shift: null,
    isOff: true,
  };
  const morningShift = {
    shift: {
      startTime: '09:00',
      endTime: '18:00',
      isOvernight: false,
      lateCheckoutThreshold: 4,
    },
    isOff: false,
  };

  it('keeps 00:11 checkout on previous C.3 overnight (15:00→00:00)', () => {
    const prev = {
      shift: {
        startTime: '15:00',
        endTime: '00:00',
        isOvernight: true,
        lateCheckoutThreshold: 4,
      },
      isOff: false,
    };
    const today = {
      shift: {
        startTime: '15:00',
        endTime: '00:00',
        isOvernight: true,
        lateCheckoutThreshold: 4,
      },
      isOff: false,
    };
    const r = resolveOvernightMorningAttribution({
      punchHour: 0 + 11 / 60 + 49 / 3600,
      prev,
      today,
      lateCheckoutHours: 4,
      earlyCheckinHours: 2,
      isCheckIn: false,
    });
    expect(r.handled).toBe(true);
    expect(r.usePreviousDay).toBe(true);
    expect(r.reason).toBe('overnight_window');
  });

  it('keeps 07:20 on previous overnight when the follow day is إجازة', () => {
    const r = resolveOvernightMorningAttribution({
      punchHour: 7 + 20 / 60,
      prev: overnight,
      today: leaveDay,
      lateCheckoutHours: 4,
      earlyCheckinHours: 2,
    });
    expect(r.handled).toBe(true);
    expect(r.usePreviousDay).toBe(true);
    expect(r.reason).toBe('leave_or_empty_follow_day');
  });

  it('uses proximity: 07:30 nearer to 09:00 day-shift than to 01:00 overnight end', () => {
    const r = resolveOvernightMorningAttribution({
      punchHour: 7.5,
      prev: overnight,
      today: morningShift,
      lateCheckoutHours: 4,
      earlyCheckinHours: 2,
    });
    expect(r.handled).toBe(true);
    expect(r.usePreviousDay).toBe(false);
    expect(r.reason).toBe('proximity_today');
  });

  it('uses proximity: 03:00 nearer to overnight end than to 09:00 start', () => {
    const r = resolveOvernightMorningAttribution({
      punchHour: 3,
      prev: overnight,
      today: morningShift,
      lateCheckoutHours: 4,
      earlyCheckinHours: 2,
    });
    expect(r.handled).toBe(true);
    expect(r.usePreviousDay).toBe(true);
  });

  it('keeps punches inside the formal late window on the overnight day', () => {
    const r = resolveOvernightMorningAttribution({
      punchHour: 4.5,
      prev: overnight,
      today: leaveDay,
      lateCheckoutHours: 4,
      earlyCheckinHours: 2,
    });
    expect(r.usePreviousDay).toBe(true);
    expect(r.reason).toBe('overnight_window');
  });

  const afternoonShift = {
    shift: {
      startTime: '16:00',
      endTime: '00:00',
      isOvernight: false,
      lateCheckoutThreshold: 4,
    },
    isOff: false,
  };

  it('keeps 06:00 check-in on today when shift starts at 16:00 (same calendar day)', () => {
    const r = resolveOvernightMorningAttribution({
      punchHour: 6,
      prev: overnight,
      today: afternoonShift,
      lateCheckoutHours: 4,
      earlyCheckinHours: 2,
      isCheckIn: true,
    });
    expect(r.handled).toBe(true);
    expect(r.usePreviousDay).toBe(false);
    expect(r.reason).toBe('early_checkin');
  });

  it('still attributes 06:00 check-out to overnight when nearer prev end', () => {
    const r = resolveOvernightMorningAttribution({
      punchHour: 6,
      prev: overnight,
      today: afternoonShift,
      lateCheckoutHours: 4,
      earlyCheckinHours: 2,
      isCheckIn: false,
    });
    expect(r.handled).toBe(true);
    expect(r.usePreviousDay).toBe(true);
  });

  it('keeps 00:00 checkout on previous day shift B.12.5 (12:30→21:30)', () => {
    const dayShift = {
      shift: {
        startTime: '12:30',
        endTime: '21:30',
        isOvernight: false,
        lateCheckoutThreshold: 4,
      },
      isOff: false,
    };
    const r = resolveOvernightMorningAttribution({
      punchHour: 0 + 28 / 3600,
      prev: dayShift,
      today: dayShift,
      lateCheckoutHours: 4,
      earlyCheckinHours: 2,
      isCheckIn: false,
    });
    expect(r.handled).toBe(true);
    expect(r.usePreviousDay).toBe(true);
    expect(r.reason).toBe('overnight_window');
  });

  it('does not steal 11:00 check-in for next day B.12.5 after previous day spill window', () => {
    const dayShift = {
      shift: {
        startTime: '12:30',
        endTime: '21:30',
        isOvernight: false,
        lateCheckoutThreshold: 4,
      },
      isOff: false,
    };
    const r = resolveOvernightMorningAttribution({
      punchHour: 11,
      prev: dayShift,
      today: dayShift,
      lateCheckoutHours: 4,
      earlyCheckinHours: 2,
      isCheckIn: true,
    });
    expect(r.handled).toBe(true);
    expect(r.usePreviousDay).toBe(false);
    expect(r.reason).toBe('early_checkin');
  });
});
