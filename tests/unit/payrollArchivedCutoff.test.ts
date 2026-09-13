import { describe, expect, it } from 'vitest';
import { calculateEmployeePayrollFromLines } from '../../src/services/punchReport.service';
import {
  effectivePayrollEnd,
  periodDays,
  utcDateOnly,
} from '../../src/utils/payrollPeriod';
import type { PunchReportLine } from '../../src/services/punchReport.service';

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function line(partial: Partial<PunchReportLine> & { punchDate: Date }): PunchReportLine {
  return {
    employeeId: 'e1',
    employeeCode: '100',
    employeeName: 'Test',
    punchDate: partial.punchDate,
    shiftName: partial.shiftName ?? 'Morning',
    isOffDay: partial.isOffDay ?? false,
    isAbsent: partial.isAbsent ?? false,
    isPermission: partial.isPermission ?? false,
    punchCount: partial.punchCount ?? 2,
    checkInCount: partial.checkInCount ?? 1,
    checkOutCount: partial.checkOutCount ?? 1,
    lateMinutes: partial.lateMinutes ?? 0,
    earlyLeaveMinutes: partial.earlyLeaveMinutes ?? 0,
    overtimeHours: partial.overtimeHours ?? 0,
    netWorkedHours: partial.netWorkedHours ?? 9,
  };
}

describe('payrollPeriod helpers', () => {
  it('counts inclusive calendar days', () => {
    expect(periodDays(day('2026-07-01'), day('2026-07-01'))).toBe(1);
    expect(periodDays(day('2026-07-01'), day('2026-07-15'))).toBe(15);
  });

  it('keeps full period for active employees', () => {
    const end = effectivePayrollEnd(day('2026-07-01'), day('2026-07-31'), {
      active: true,
      archivedAt: null,
      departureDate: null,
    });
    expect(end?.toISOString().slice(0, 10)).toBe('2026-07-31');
  });

  it('cuts at archive day inclusively', () => {
    const end = effectivePayrollEnd(day('2026-07-01'), day('2026-07-31'), {
      active: false,
      archivedAt: day('2026-07-15'),
      departureDate: day('2026-07-15'),
    });
    expect(end?.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  it('skips employees archived before the period', () => {
    const end = effectivePayrollEnd(day('2026-07-01'), day('2026-07-31'), {
      active: false,
      archivedAt: day('2026-06-20'),
      departureDate: day('2026-06-20'),
    });
    expect(end).toBeNull();
  });

  it('normalizes to UTC date only', () => {
    expect(utcDateOnly(new Date('2026-07-15T18:30:00.000Z')).toISOString()).toBe(
      '2026-07-15T00:00:00.000Z',
    );
  });
});

describe('calculateEmployeePayrollFromLines periodBaseDays', () => {
  it('prorates salary when periodBaseDays is shorter than 30', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      line({ punchDate: day(`2026-07-${String(i + 1).padStart(2, '0')}`), punchCount: 2 }),
    );
    const full = calculateEmployeePayrollFromLines(lines, 3000);
    const cut = calculateEmployeePayrollFromLines(lines, 3000, 15);
    expect(cut.workDaysSalary).toBeLessThan(full.workDaysSalary);
    // 20 attendance rows + 3 earned leave = 23 payable days, clamped to the 15
    // days the employee was still on payroll for.
    expect(full.actualWorkingDays).toBe(30);
    expect(cut.workDaysSalary).toBeCloseTo(15 * (3000 / 30), 0);
  });

  it('uses full payable period base for salary', () => {
    const lines = [
      line({ punchDate: day('2026-07-01'), punchCount: 2 }),
      line({ punchDate: day('2026-07-02'), punchCount: 2 }),
    ];
    expect(calculateEmployeePayrollFromLines(lines, 3000).actualWorkingDays).toBe(30);
  });
});
