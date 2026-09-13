import { describe, it, expect } from 'vitest';
import {
  computeEmployeeSummary,
  computeSummaryWorkMetrics,
  formatTimeAmPm,
  formatTimeShortAmPm,
  getIgnoredLateLineIds,
  getSummaryPeriodDays,
  pairPunchesByExpectedTimes,
  resolveDayPunches,
  type PunchReportExportLine,
} from '../../src/services/punchReportLine.service';
import {
  calculateEmployeePayrollFromLines,
  earnedLeaveFromBaseDays,
  exportLineToPayrollLine,
  lateDayFraction,
} from '../../src/services/punchReport.service';
import {
  cappedPermissionCount,
  DEFAULT_LATE_POLICY,
  effectiveGraceMinutes,
  latePolicyFromConfig,
  splitForgivenLateDays,
  type LatePolicy,
} from '../../src/services/latePolicy.service';

let seq = 1;

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * The report emits one line per employee per date, and the work-days base is
 * derived from the dates a summary covers, so each generated line lands on its
 * own day of June unless the test pins the date itself.
 */
function nextDay(): Date {
  const dayOfMonth = ((seq - 1) % 30) + 1;
  return day(`2026-06-${String(dayOfMonth).padStart(2, '0')}`);
}

function exportLine(overrides: Partial<PunchReportExportLine> = {}): PunchReportExportLine {
  return {
    id: seq++,
    employeeId: 'emp1',
    employeeCode: 'E1001',
    employeeName: 'Test',
    jobTitle: '',
    punchDate: nextDay(),
    deviceName: '',
    deviceSn: '',
    firstCheckIn: new Date('2026-06-01T08:00:00.000Z'),
    lastCheckOut: new Date('2026-06-01T17:00:00.000Z'),
    punchCount: 2,
    checkInCount: 1,
    checkOutCount: 1,
    shiftId: 'shift1',
    shiftName: 'Morning',
    expectedCheckIn: null,
    expectedCheckOut: null,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    netWorkedHours: 9,
    overtimeHours: 0,
    isOffDay: false,
    isAbsent: false,
    isAnnualLeave: false,
    isBusDelay: false,
    basicSalary: 3000,
    ...overrides,
  };
}

describe('getSummaryPeriodDays', () => {
  it('counts days inclusively', () => {
    expect(getSummaryPeriodDays(day('2026-06-01'), day('2026-06-01'))).toBe(1);
    expect(getSummaryPeriodDays(day('2026-06-01'), day('2026-06-30'))).toBe(30);
  });

  it('never returns less than one day', () => {
    expect(getSummaryPeriodDays(day('2026-06-10'), day('2026-06-01'))).toBe(1);
  });
});

describe('earnedLeaveFromBaseDays', () => {
  it('follows the banded leave accrual table', () => {
    expect(earnedLeaveFromBaseDays(0)).toBe(0);
    expect(earnedLeaveFromBaseDays(5)).toBe(0);
    expect(earnedLeaveFromBaseDays(6)).toBe(1);
    expect(earnedLeaveFromBaseDays(12)).toBe(1);
    expect(earnedLeaveFromBaseDays(13)).toBe(2);
    expect(earnedLeaveFromBaseDays(19)).toBe(2);
    expect(earnedLeaveFromBaseDays(20)).toBe(3);
    expect(earnedLeaveFromBaseDays(23)).toBe(3);
    expect(earnedLeaveFromBaseDays(24)).toBe(4);
    expect(earnedLeaveFromBaseDays(31)).toBe(4);
  });
});

describe('lateDayFraction', () => {
  it('forgives up to 20 minutes', () => {
    expect(lateDayFraction(0)).toBe(0);
    expect(lateDayFraction(20)).toBe(0);
  });

  it('escalates in bands', () => {
    expect(lateDayFraction(21)).toBe(0.25);
    expect(lateDayFraction(30)).toBe(0.25);
    expect(lateDayFraction(31)).toBe(0.5);
    expect(lateDayFraction(59)).toBe(0.5);
    // Band boundaries are inclusive: "31 to an hour" is half a day, and only
    // "more than an hour" costs the full day.
    expect(lateDayFraction(60)).toBe(0.5);
    expect(lateDayFraction(61)).toBe(1);
    expect(lateDayFraction(600)).toBe(1);
  });

  it('follows a reconfigured ladder', () => {
    const policy: LatePolicy = {
      ...DEFAULT_LATE_POLICY,
      graceMinutes: 10,
      quarterDayMaxMinutes: 20,
      halfDayMaxMinutes: 40,
    };
    expect(lateDayFraction(10, policy)).toBe(0);
    expect(lateDayFraction(11, policy)).toBe(0.25);
    expect(lateDayFraction(20, policy)).toBe(0.25);
    expect(lateDayFraction(21, policy)).toBe(0.5);
    expect(lateDayFraction(40, policy)).toBe(0.5);
    expect(lateDayFraction(41, policy)).toBe(1);
  });
});

describe('latePolicyFromConfig', () => {
  it('falls back to the default policy when unconfigured', () => {
    expect(latePolicyFromConfig(null)).toEqual(DEFAULT_LATE_POLICY);
  });

  it('clamps an inverted ladder so bands stay ordered', () => {
    const policy = latePolicyFromConfig({
      lateGraceMinutes: 45,
      lateQuarterDayMaxMinutes: 30,
      lateHalfDayMaxMinutes: 10,
    } as Parameters<typeof latePolicyFromConfig>[0]);
    expect(policy.graceMinutes).toBe(45);
    expect(policy.quarterDayMaxMinutes).toBe(45);
    expect(policy.halfDayMaxMinutes).toBe(45);
    // A fully collapsed ladder still behaves sanely: free, then a full day.
    expect(lateDayFraction(45, policy)).toBe(0);
    expect(lateDayFraction(46, policy)).toBe(1);
  });

  it('rejects an unknown selection mode', () => {
    const policy = latePolicyFromConfig({
      lateForgivenDaysSelection: 'nonsense',
    } as Parameters<typeof latePolicyFromConfig>[0]);
    expect(policy.forgivenDaysSelection).toBe('oldest');
  });
});

describe('computeSummaryWorkMetrics', () => {
  it('subtracts leave days and no-punch absences from the period', () => {
    const lines = [
      exportLine({ isOffDay: true, shiftName: 'إجازة', punchCount: 0 }),
      exportLine({ isAbsent: true, punchCount: 0, checkInCount: 0, checkOutCount: 0 }),
      ...Array.from({ length: 8 }, () => exportLine()),
    ];
    const metrics = computeSummaryWorkMetrics(lines, 10);
    // 10 period days - (1 leave + 1 absent) = 8 base days → 1 earned leave day
    expect(metrics.earnedLeaveCapped).toBe(1);
    // 10 − (1 leave + 1 absent) = 8 working + 1 earned = 9
    expect(metrics.actualWorkingDays).toBe(9);
  });

  it('actual working days = working days + earned leave (capped at period)', () => {
    const lines = [
      ...Array.from({ length: 3 }, () =>
        exportLine({ isAbsent: true, punchCount: 0, checkInCount: 0, checkOutCount: 0 }),
      ),
      ...Array.from({ length: 25 }, () => exportLine()),
    ];
    const metrics = computeSummaryWorkMetrics(lines, 30);
    expect(metrics.workingDays).toBe(27);
    expect(metrics.earnedLeaveCapped).toBe(4);
    expect(metrics.actualWorkingDays).toBe(30);
  });

  it('deducts one actual day when calendar has 31 rows vs 30-day payable month', () => {
    const abs = (iso: string) =>
      exportLine({
        punchDate: day(iso),
        isAbsent: true,
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
        firstCheckIn: null,
        lastCheckOut: null,
        netWorkedHours: 0,
      });
    const work = (iso: string) => exportLine({ punchDate: day(iso) });
    const lines: PunchReportExportLine[] = [];
    for (let d = 26; d <= 31; d++) lines.push(work(`2026-07-${d}`));
    for (let d = 1; d <= 25; d++) {
      lines.push(work(`2026-08-${String(d).padStart(2, '0')}`));
    }
    for (const iso of ['2026-08-09', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25']) {
      const idx = lines.findIndex((l) => l.punchDate.toISOString().startsWith(iso));
      if (idx >= 0) lines[idx] = abs(iso);
    }
    const metrics = computeSummaryWorkMetrics(lines, 30);
    expect(metrics.workingDays).toBe(25);
    expect(metrics.earnedLeaveCapped).toBe(4);
    expect(metrics.actualWorkingDays).toBe(28);
  });

  it('returns zero actual days when there are no lines', () => {
    expect(computeSummaryWorkMetrics([], 30).actualWorkingDays).toBe(0);
  });

  it('caps earned leave at four days', () => {
    const metrics = computeSummaryWorkMetrics(
      Array.from({ length: 30 }, () => exportLine()),
      30,
    );
    expect(metrics.earnedLeaveCapped).toBe(4);
    expect(metrics.actualWorkingDays).toBe(30);
  });

  it('excludes resignation days from the base', () => {
    const lines = [
      exportLine({
        shiftName: 'استقالة',
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
      }),
    ];
    expect(computeSummaryWorkMetrics(lines, 10).actualWorkingDays).toBe(10);
  });

  it('never goes negative when exclusions exceed the period', () => {
    const lines = Array.from({ length: 20 }, () =>
      exportLine({ isOffDay: true, shiftName: 'إجازة', punchCount: 0 }),
    );
    expect(computeSummaryWorkMetrics(lines, 5).actualWorkingDays).toBe(0);
  });
});

describe('resolveDayPunches', () => {
  // C.4-style overnight shift: 14:00 → 02:00, two hours of early check-in.
  const expectedIn = new Date('2026-06-01T14:00:00.000Z');
  const expectedOut = new Date('2026-06-02T02:00:00.000Z');
  const at = (iso: string) => new Date(iso);

  it('pairs a normal check-in and check-out', () => {
    const paired = resolveDayPunches(
      [at('2026-06-01T14:32:00.000Z'), at('2026-06-02T01:17:00.000Z')],
      expectedIn,
      expectedOut,
      2,
    );
    expect(paired.checkIn?.toISOString()).toBe('2026-06-01T14:32:00.000Z');
    expect(paired.checkOut?.toISOString()).toBe('2026-06-02T01:17:00.000Z');
  });

  it('reads the same event punched twice as one punch', () => {
    // Both land on the checkout; earliest/latest pairing read this as a
    // 15-minute working day.
    const paired = resolveDayPunches(
      [at('2026-06-02T02:00:00.000Z'), at('2026-06-02T02:15:00.000Z')],
      expectedIn,
      expectedOut,
      2,
    );
    expect(paired.checkIn).toBeNull();
    expect(paired.checkOut?.toISOString()).toBe('2026-06-02T02:00:00.000Z');
  });

  it('drops a punch left over from a previous shift', () => {
    // 07:15 is the previous night's checkout, not a check-in nine hours early.
    const paired = resolveDayPunches(
      [at('2026-06-01T07:15:00.000Z'), at('2026-06-01T17:21:00.000Z')],
      expectedIn,
      expectedOut,
      2,
    );
    expect(paired.checkIn?.toISOString()).toBe('2026-06-01T17:21:00.000Z');
    expect(paired.checkOut).toBeNull();
  });

  it('keeps a real early leave, not a missing punch', () => {
    const paired = resolveDayPunches(
      [at('2026-06-01T14:00:00.000Z'), at('2026-06-01T20:00:00.000Z')],
      expectedIn,
      expectedOut,
      2,
    );
    expect(paired.checkIn?.toISOString()).toBe('2026-06-01T14:00:00.000Z');
    expect(paired.checkOut?.toISOString()).toBe('2026-06-01T20:00:00.000Z');
  });

  it('keeps the latest checkout so overtime survives an extra punch', () => {
    const paired = resolveDayPunches(
      [
        at('2026-06-01T14:00:00.000Z'),
        at('2026-06-02T01:50:00.000Z'),
        at('2026-06-02T02:40:00.000Z'),
      ],
      expectedIn,
      expectedOut,
      2,
    );
    expect(paired.checkIn?.toISOString()).toBe('2026-06-01T14:00:00.000Z');
    expect(paired.checkOut?.toISOString()).toBe('2026-06-02T02:40:00.000Z');
  });

  it('classifies a lone punch by the side it is closest to', () => {
    expect(
      resolveDayPunches([at('2026-06-02T01:50:00.000Z')], expectedIn, expectedOut, 2).checkIn,
    ).toBeNull();
    expect(
      resolveDayPunches([at('2026-06-01T14:10:00.000Z')], expectedIn, expectedOut, 2).checkOut,
    ).toBeNull();
  });

  it('still reports a punched day when every punch predates the window', () => {
    const paired = resolveDayPunches(
      [at('2026-06-01T05:00:00.000Z')],
      expectedIn,
      expectedOut,
      2,
    );
    expect(paired.checkIn?.toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });
});

describe('getIgnoredLateLineIds', () => {
  it('forgives the two chronologically earliest late days', () => {
    const l1 = exportLine({ punchDate: day('2026-06-01'), lateMinutes: 90 });
    const l2 = exportLine({ punchDate: day('2026-06-02'), lateMinutes: 25 });
    const l3 = exportLine({ punchDate: day('2026-06-03'), lateMinutes: 45 });
    const ignored = getIgnoredLateLineIds([l3, l1, l2]);
    expect([...ignored].sort()).toEqual([l1.id, l2.id].sort());
  });

  it('ignores off days and absences', () => {
    const off = exportLine({ isOffDay: true, lateMinutes: 60 });
    const absent = exportLine({ isAbsent: true, lateMinutes: 60 });
    expect(getIgnoredLateLineIds([off, absent]).size).toBe(0);
  });

  it('returns an empty set when nothing is late', () => {
    expect(getIgnoredLateLineIds([exportLine()]).size).toBe(0);
  });
});

describe('computeEmployeeSummary', () => {
  it('counts working days from punched, non-absent days', () => {
    const lines = [exportLine(), exportLine(), exportLine({ isAbsent: true, punchCount: 0 })];
    expect(computeEmployeeSummary(lines, 3).workingDays).toBe(2);
  });

  it('forgives the first N absences for غياب بدون إذن penalty only', () => {
    const abs = (iso: string) =>
      exportLine({
        punchDate: day(iso),
        isAbsent: true,
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
        shiftName: 'C.S',
        firstCheckIn: null,
        lastCheckOut: null,
        netWorkedHours: 0,
      });
    // Mon–Thu absences (weight 1 each). Forgive 4 → penalty 0; 5th would charge.
    const four = [
      abs('2026-06-01'),
      abs('2026-06-02'),
      abs('2026-06-03'),
      abs('2026-06-04'),
    ];
    expect(computeEmployeeSummary(four, 30, 0, DEFAULT_LATE_POLICY, 4).absentCount).toBe(0);
    const five = [...four, abs('2026-06-05')];
    // 2026-06-05 is Friday → weight 2
    expect(computeEmployeeSummary(five, 30, 0, DEFAULT_LATE_POLICY, 4).absentCount).toBe(2);
    expect(computeSummaryWorkMetrics(five, 30).actualWorkingDays).toBe(29);
  });

  it('treats every إجازة سنوية day as attendance, even beyond four', () => {
    const annual = (iso: string) =>
      exportLine({
        punchDate: day(iso),
        isAnnualLeave: true,
        shiftName: 'إجازة سنوية',
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
        isAbsent: false,
        isOffDay: false,
        firstCheckIn: null,
        lastCheckOut: null,
        netWorkedHours: 0,
      });
    const punched = Array.from({ length: 24 }, (_, i) =>
      exportLine({ punchDate: day(`2026-06-${String(i + 1).padStart(2, '0')}`) }),
    );
    const leave = [
      annual('2026-07-06'),
      annual('2026-07-07'),
      annual('2026-07-08'),
      annual('2026-07-09'),
      annual('2026-07-10'),
    ];
    const summary = computeEmployeeSummary(
      [...punched, ...leave],
      30,
      0,
      DEFAULT_LATE_POLICY,
      0,
    );
    expect(summary.earnedLeaveCapped).toBe(4);
    expect(summary.workingDays).toBe(30);
    expect(summary.absentCount).toBe(0);
  });

  it('keeps regular إجازة past the entitlement out of غياب بدون إذن', () => {
    const regularLeave = (iso: string) =>
      exportLine({
        punchDate: day(iso),
        isOffDay: true,
        shiftName: 'إجازة',
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
        firstCheckIn: null,
        lastCheckOut: null,
        netWorkedHours: 0,
      });
    const leaves = [
      regularLeave('2026-06-01'),
      regularLeave('2026-06-02'),
      regularLeave('2026-06-03'),
      regularLeave('2026-06-04'),
      regularLeave('2026-06-05'),
    ];
    // «غياب بدون إذن» means the employee never showed up; a fifth leave day is
    // reported on its own so only the payslip deducts it.
    expect(computeEmployeeSummary(leaves.slice(0, 4), 30).excessLeaveDays).toBe(0);
    const summary = computeEmployeeSummary(leaves, 30);
    expect(summary.absentCount).toBe(0);
    expect(summary.excessLeaveDays).toBe(1);
  });

  it('deducts excess leave on the payslip without weekend weighting', () => {
    const leave = (iso: string) =>
      exportLine({
        punchDate: day(iso),
        isOffDay: true,
        shiftName: 'إجازة',
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
        firstCheckIn: null,
        lastCheckOut: null,
        netWorkedHours: 0,
      });
    // 2026-06-05 is a Friday: an absence there would count double, leave does not.
    const lines = [
      leave('2026-06-01'),
      leave('2026-06-02'),
      leave('2026-06-03'),
      leave('2026-06-04'),
      leave('2026-06-05'),
      leave('2026-06-06'),
    ].map(exportLineToPayrollLine);
    const calc = calculateEmployeePayrollFromLines(lines, 3000, 30);
    expect(calc.excessLeaveDays).toBe(2);
    expect(calc.absentDays).toBe(0);
    expect(calc.excessLeaveDeduction).toBe(0);
    expect(calc.totalDeductions).toBe(0);
  });

  it('subtracts قبل التعيين days from أيام العمل الفعلية', () => {
    // Hire mid-period: 17 قبل التعيين + some attendance → must not yield 30+4=34
    const beforeDays = [
      ...Array.from({ length: 6 }, (_, i) =>
        exportLine({
          punchDate: day(`2026-07-${String(26 + i).padStart(2, '0')}`),
          shiftName: 'قبل التعيين',
          punchCount: 0,
          checkInCount: 0,
          checkOutCount: 0,
          firstCheckIn: null,
          lastCheckOut: null,
          netWorkedHours: 0,
          isAbsent: false,
        }),
      ),
      ...Array.from({ length: 11 }, (_, i) =>
        exportLine({
          punchDate: day(`2026-08-${String(1 + i).padStart(2, '0')}`),
          shiftName: 'قبل التعيين',
          punchCount: 0,
          checkInCount: 0,
          checkOutCount: 0,
          firstCheckIn: null,
          lastCheckOut: null,
          netWorkedHours: 0,
          isAbsent: false,
        }),
      ),
      exportLine({ punchDate: day('2026-08-13'), punchCount: 2 }),
    ];
    // 17 قبل التعيين → 13 working + 2 earned = 15 (not the full 30-day period)
    expect(computeSummaryWorkMetrics(beforeDays, 30).actualWorkingDays).toBe(15);
  });

  it('counts grid «حاضر» days as working days even with no punch', () => {
    const lines = [
      exportLine({ punchCount: 2 }),
      exportLine({
        shiftName: 'حاضر',
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
        firstCheckIn: null,
        lastCheckOut: null,
        isAbsent: false,
        netWorkedHours: 0,
      }),
      exportLine({
        shiftName: 'حاضر - C3',
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
        firstCheckIn: null,
        lastCheckOut: null,
        isAbsent: false,
        netWorkedHours: 0,
      }),
      exportLine({ isAbsent: true, punchCount: 0, checkInCount: 0, checkOutCount: 0 }),
    ];
    const summary = computeEmployeeSummary(lines, 4);
    expect(summary.workingDays).toBe(3);
    // Period 4 − 1 absent = 3 working + 0 earned = 3
    expect(summary.actualWorkingDays).toBe(3);
  });

  it('does not treat mis-flagged حاضر as unpaid absence in actual working days', () => {
    const lines = [
      exportLine({
        shiftName: 'حاضر',
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
        isAbsent: true,
        firstCheckIn: null,
        lastCheckOut: null,
        netWorkedHours: 0,
      }),
    ];
    expect(computeSummaryWorkMetrics(lines, 1).actualWorkingDays).toBe(1);
  });

  it('counts sick days and applies a quarter-day deduction each', () => {
    const lines = [exportLine({ isOffDay: true, shiftName: 'إجازة مرضية', punchCount: 0 })];
    const summary = computeEmployeeSummary(lines, 1);
    expect(summary.sickDayCount).toBe(1);
    expect(summary.sickDeduction).toBe(0.25);
  });

  it('forgives the first missing check-out and charges a quarter day after', () => {
    const missingOut = () => exportLine({ punchCount: 1, checkInCount: 1, checkOutCount: 0 });
    expect(computeEmployeeSummary([missingOut()], 1).punchDeduction).toBe(0);
    expect(computeEmployeeSummary([missingOut(), missingOut()], 2).punchDeduction).toBe(0.25);
  });

  it('forgives the first missing check-in and charges half a day after', () => {
    const missingIn = () => exportLine({ punchCount: 1, checkInCount: 0, checkOutCount: 1 });
    expect(computeEmployeeSummary([missingIn(), missingIn()], 2).punchDeduction).toBe(0.5);
  });

  it('double-weights absences on Thursday, Friday and Saturday', () => {
    // 2026-06-04 is a Thursday → Odoo weekday 3
    const thursday = exportLine({ punchDate: day('2026-06-04'), isAbsent: true, punchCount: 0 });
    // 2026-06-01 is a Monday → Odoo weekday 0
    const monday = exportLine({ punchDate: day('2026-06-01'), isAbsent: true, punchCount: 0 });
    // forgivenCount 0 → every absence is charged
    expect(computeEmployeeSummary([thursday], 1, 0, DEFAULT_LATE_POLICY, 0).absentCount).toBe(2);
    expect(computeEmployeeSummary([monday], 1, 0, DEFAULT_LATE_POLICY, 0).absentCount).toBe(1);
  });

  it('skips the two forgiven late days when totalling the late deduction', () => {
    const late = (iso: string, mins: number) =>
      exportLine({ punchDate: day(iso), lateMinutes: mins });
    const summary = computeEmployeeSummary(
      [late('2026-06-01', 90), late('2026-06-02', 90), late('2026-06-03', 90)],
      3,
    );
    // only the third late day is charged, at a full day
    expect(summary.lateDeduction).toBe(1);
  });

  it('sums overtime from worked days and punched off days', () => {
    const lines = [
      exportLine({ overtimeHours: 1.5 }),
      exportLine({ isOffDay: true, punchCount: 2, overtimeHours: 2 }),
    ];
    expect(computeEmployeeSummary(lines, 2).overtime).toBe(3.5);
  });

  it('rolls the admin penalty into total penalties', () => {
    const summary = computeEmployeeSummary([exportLine()], 1, 3);
    expect(summary.adminPenalty).toBe(3);
    expect(summary.totalPenalties).toBe(3);
  });

  it('returns an all-zero summary for an empty period', () => {
    const summary = computeEmployeeSummary([], 0);
    expect(summary.workingDays).toBe(0);
    expect(summary.totalPenalties).toBe(0);
  });
});

describe('the report and payroll agree on late deductions', () => {
  /**
   * Payroll used to forgive the two SMALLEST late days by minutes while the
   * report forgave the two EARLIEST by date, so the payslip could disagree with
   * the report handed to the employee. Both now read the same policy.
   */
  const lines = [
    exportLine({ punchDate: day('2026-06-01'), lateMinutes: 90 }),
    exportLine({ punchDate: day('2026-06-02'), lateMinutes: 25 }),
    exportLine({ punchDate: day('2026-06-03'), lateMinutes: 45 }),
  ];

  const payrollDays = (policy?: LatePolicy) =>
    calculateEmployeePayrollFromLines(lines.map(exportLineToPayrollLine), 3000, 3, policy)
      .lateDeductibleDays;

  it('charges the same days under the default policy', () => {
    // Forgives 06-01 (90m) and 06-02 (25m) as إذن, charges 45m = 0.5 day.
    expect(computeEmployeeSummary(lines, 3).lateDeduction).toBe(0.5);
    expect(payrollDays()).toBe(0.5);
  });

  it('stays in step when the allowance is switched off', () => {
    const policy: LatePolicy = { ...DEFAULT_LATE_POLICY, forgivenDaysCount: 0 };
    // 90m = 1 day, 25m = 0.25, 45m = 0.5.
    expect(computeEmployeeSummary(lines, 3, 0, policy).lateDeduction).toBe(1.75);
    expect(payrollDays(policy)).toBe(1.75);
  });

  it('stays in step when the allowance forgives the largest days', () => {
    const policy: LatePolicy = { ...DEFAULT_LATE_POLICY, forgivenDaysSelection: 'largest' };
    // Forgives 90m and 45m, charges 25m = 0.25 day.
    expect(computeEmployeeSummary(lines, 3, 0, policy).lateDeduction).toBe(0.25);
    expect(payrollDays(policy)).toBe(0.25);
  });

  it('stays in step when the allowance forgives the smallest days', () => {
    const policy: LatePolicy = { ...DEFAULT_LATE_POLICY, forgivenDaysSelection: 'smallest' };
    // Forgives 25m and 45m, charges 90m = 1 day. This was payroll's old rule.
    expect(computeEmployeeSummary(lines, 3, 0, policy).lateDeduction).toBe(1);
    expect(payrollDays(policy)).toBe(1);
  });
});

describe('splitForgivenLateDays', () => {
  it('never forgives off days or absences', () => {
    const off = exportLine({ isOffDay: true, lateMinutes: 90 });
    const absent = exportLine({ isAbsent: true, lateMinutes: 90 });
    const result = splitForgivenLateDays([off, absent]);
    expect(result.forgiven).toHaveLength(0);
    expect(result.charged).toHaveLength(0);
  });

  it('forgives every late day when the allowance exceeds the count', () => {
    const lines = [exportLine({ lateMinutes: 90 })];
    const result = splitForgivenLateDays(lines, { ...DEFAULT_LATE_POLICY, forgivenDaysCount: 5 });
    expect(result.forgiven).toHaveLength(1);
    expect(result.charged).toHaveLength(0);
  });

  it('breaks same-day ties on check-in time', () => {
    const early = exportLine({
      punchDate: day('2026-06-01'),
      lateMinutes: 30,
      firstCheckIn: new Date('2026-06-01T08:30:00.000Z'),
    });
    const later = exportLine({
      punchDate: day('2026-06-01'),
      lateMinutes: 90,
      firstCheckIn: new Date('2026-06-01T09:30:00.000Z'),
    });
    const result = splitForgivenLateDays([later, early], {
      ...DEFAULT_LATE_POLICY,
      forgivenDaysCount: 1,
    });
    expect(result.forgiven[0].id).toBe(early.id);
  });
});

describe('calculateEmployeePayrollFromLines', () => {
  it('does not invent payable days when there are no attendance lines', () => {
    const calc = calculateEmployeePayrollFromLines([], 3000);
    expect(calc.actualWorkingDays).toBe(0);
    expect(calc.workDaysSalary).toBe(0);
  });

  it('uses full payable period for salary when attendance exists', () => {
    const lines = Array.from({ length: 13 }, () => exportLine()).map(exportLineToPayrollLine);
    const calc = calculateEmployeePayrollFromLines(lines, 3000, 15);
    expect(calc.actualWorkingDays).toBe(15);
    expect(calc.workDaysSalary).toBe(1500);
  });

  it('pays overtime at the daily rate', () => {
    const calc = calculateEmployeePayrollFromLines(
      [exportLine({ overtimeHours: 3 })].map(exportLineToPayrollLine),
      3000,
      1,
    );
    expect(calc.overtimeHours).toBe(3);
    expect(calc.overtimeAmount).toBe(300);
  });

  it('caps the permission count at two', () => {
    const lines = Array.from({ length: 5 }, () => exportLine({ isBusDelay: true }));
    expect(calculateEmployeePayrollFromLines(lines.map(exportLineToPayrollLine), 3000).permissionCount).toBe(2);
  });

  it('never returns NaN for a zero basic salary', () => {
    const calc = calculateEmployeePayrollFromLines([], 0);
    expect(calc.netSalary).toBe(0);
  });
});

describe('time formatting', () => {
  it('formats 12-hour times with seconds', () => {
    expect(formatTimeAmPm(new Date('2026-06-01T08:05:09.000Z'))).toBe('08:05:09 AM');
    expect(formatTimeAmPm(new Date('2026-06-01T17:30:00.000Z'))).toBe('05:30:00 PM');
    expect(formatTimeAmPm(new Date('2026-06-01T00:00:00.000Z'))).toBe('12:00:00 AM');
    expect(formatTimeAmPm(new Date('2026-06-01T12:00:00.000Z'))).toBe('12:00:00 PM');
  });

  it('formats short 12-hour times', () => {
    expect(formatTimeShortAmPm(new Date('2026-06-01T08:05:09.000Z'))).toBe('08:05 AM');
  });

  it('returns an empty string for null', () => {
    expect(formatTimeAmPm(null)).toBe('');
    expect(formatTimeShortAmPm(null)).toBe('');
  });
});

describe('effectiveGraceMinutes', () => {
  const policy = { ...DEFAULT_LATE_POLICY, graceMinutes: 20 };

  it('falls back to the policy when the shift sets no grace', () => {
    expect(effectiveGraceMinutes(policy, null)).toBe(20);
    expect(effectiveGraceMinutes(policy, undefined)).toBe(20);
  });

  it('takes the more generous value by default', () => {
    expect(effectiveGraceMinutes(policy, 30)).toBe(30);
    expect(effectiveGraceMinutes(policy, 10)).toBe(20);
  });

  it('lets the policy win when configured to', () => {
    const p: LatePolicy = { ...policy, gracePrecedence: 'policy' };
    expect(effectiveGraceMinutes(p, 30)).toBe(20);
    expect(effectiveGraceMinutes(p, 10)).toBe(20);
  });

  it('lets the shift win when configured to, even when shorter', () => {
    const p: LatePolicy = { ...policy, gracePrecedence: 'shift' };
    expect(effectiveGraceMinutes(p, 30)).toBe(30);
    expect(effectiveGraceMinutes(p, 10)).toBe(10);
    // A negative shift value would otherwise make every arrival late.
    expect(effectiveGraceMinutes(p, -5)).toBe(0);
  });
});

describe('cappedPermissionCount', () => {
  it('caps at the configured number', () => {
    expect(cappedPermissionCount(5, { ...DEFAULT_LATE_POLICY, permissionCap: 2 })).toBe(2);
    expect(cappedPermissionCount(1, { ...DEFAULT_LATE_POLICY, permissionCap: 2 })).toBe(1);
  });

  it('reports the raw count when the cap is lifted', () => {
    expect(cappedPermissionCount(5, { ...DEFAULT_LATE_POLICY, permissionCap: null })).toBe(5);
  });

  it('reads the cap and its enable flag from config', () => {
    const capped = latePolicyFromConfig({
      latePermissionCap: 3,
      latePermissionCapEnabled: true,
    } as Parameters<typeof latePolicyFromConfig>[0]);
    expect(capped.permissionCap).toBe(3);

    const lifted = latePolicyFromConfig({
      latePermissionCap: 3,
      latePermissionCapEnabled: false,
    } as Parameters<typeof latePolicyFromConfig>[0]);
    expect(lifted.permissionCap).toBeNull();
  });

  it('defaults an unknown grace precedence to longest', () => {
    const policy = latePolicyFromConfig({
      lateGracePrecedence: 'nonsense',
    } as Parameters<typeof latePolicyFromConfig>[0]);
    expect(policy.gracePrecedence).toBe('longest');
  });
});
