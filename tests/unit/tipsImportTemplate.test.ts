import { describe, expect, it } from 'vitest';
import {
  findImportHeaderColumn,
  LOAN_FILE_AMOUNT_ALIASES,
  LOAN_FILE_DAYS_ALIASES,
  summarizeLoanImportBatch,
  excelCellHasValue,
} from '../../src/services/advanceLoanImport.service';
import { importTemplateSpec, TIP_EXTRA_UNLOCKED_ROWS } from '../../src/services/advancesExcel.service';
import {
  actualWorkingDaysByEmployeeFromPunchLines,
  getSummaryPeriodDays,
  punchFollowUpPeriodDates,
  tipsWorkingDaysFromPunchLines,
  type PunchReportExportLine,
} from '../../src/services/punchReportLine.service';

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function punchLine(
  overrides: Partial<PunchReportExportLine>,
): PunchReportExportLine {
  return {
    id: 1,
    employeeId: 'emp1',
    employeeCode: '1',
    employeeName: 'A',
    jobTitle: '',
    punchDate: day('2026-08-01'),
    deviceName: '',
    deviceSn: '',
    firstCheckIn: null,
    lastCheckOut: null,
    punchCount: 2,
    checkInCount: 1,
    checkOutCount: 1,
    shiftId: null,
    shiftName: 'Morning',
    expectedCheckIn: null,
    expectedCheckOut: null,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    netWorkedHours: 8,
    overtimeHours: 0,
    isOffDay: false,
    isAbsent: false,
    isAnnualLeave: false,
    isBusDelay: false,
    basicSalary: 0,
    ...overrides,
  };
}

describe('tips import template', () => {
  it('names the sheet and amount column Commission and adds working days', () => {
    const spec = importTemplateSpec('tip');
    expect(spec.sheetName).toBe('استيراد Commission');
    expect(spec.headersEn[spec.amountCol - 1]).toBe('Commission');
    expect(spec.headersAr[spec.amountCol - 1]).toBe('Commission');
    expect(spec.daysCol).toBe(6);
    expect(spec.headersAr[spec.daysCol! - 1]).toBe('أيام العمل');
    expect(TIP_EXTRA_UNLOCKED_ROWS).toBe(25);
    expect(importTemplateSpec('loan').headersAr).toContain('مبلغ السلفة');
  });
});

describe('tips excel column aliases', () => {
  it('reads the tips amount column, not the working-days column', () => {
    const headers = [
      'employee_code / كود الموظف',
      'employee_name / اسم الموظف',
      'department / القسم',
      'job_title / الوظيفة',
      'hiring_date / تاريخ التعيين',
      'actual_working_days / أيام العمل',
      'tips / tips',
    ];
    expect(
      findImportHeaderColumn(headers, LOAN_FILE_AMOUNT_ALIASES),
    ).toBe(6);
    expect(findImportHeaderColumn(headers, LOAN_FILE_DAYS_ALIASES)).toBe(5);
  });

  it('still accepts old Arabic tips column alias', () => {
    const headers = [
      'employee_code / كود الموظف',
      'actual_working_days / أيام العمل',
      'tips / تيبس',
    ];
    expect(findImportHeaderColumn(headers, LOAN_FILE_AMOUNT_ALIASES)).toBe(2);
  });

  it('treats empty working-days cells as missing so import can recompute', () => {
    expect(excelCellHasValue('')).toBe(false);
    expect(excelCellHasValue('  ')).toBe(false);
    expect(excelCellHasValue(null)).toBe(false);
    expect(excelCellHasValue(0)).toBe(true);
    expect(excelCellHasValue('12')).toBe(true);
  });
});

describe('tips period working days', () => {
  it('counts punch or حاضر days only — not payroll month formula', () => {
    const lines = [
      punchLine({ id: 1, employeeId: 'a', punchDate: day('2026-08-11') }),
      punchLine({ id: 2, employeeId: 'a', punchDate: day('2026-08-12') }),
      punchLine({
        id: 3,
        employeeId: 'a',
        punchDate: day('2026-08-13'),
        shiftName: 'حاضر',
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
      }),
      punchLine({
        id: 4,
        employeeId: 'a',
        punchDate: day('2026-08-14'),
        isAbsent: true,
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
      }),
    ];
    expect(tipsWorkingDaysFromPunchLines(lines)).toBe(3);
  });

  it('15-day range stays at 15 — not inflated to 30', () => {
    const lines = Array.from({ length: 15 }, (_, i) =>
      punchLine({
        id: i + 1,
        employeeId: 'a',
        punchDate: day(`2026-08-${String(11 + i).padStart(2, '0')}`),
      }),
    );
    expect(tipsWorkingDaysFromPunchLines(lines)).toBe(15);
    const payrollStyle = actualWorkingDaysByEmployeeFromPunchLines(lines, 30);
    expect(payrollStyle.get('a')).toBe(30);
  });

  it('does not count a day after overnight OUT was moved to the previous shift day (6034-style)', () => {
    // Aug 11 had only 00:11 checkout belonging to Aug 10 C.3 → report row is absent.
    // Remaining 12 days in 11–25 have punches (2 leave days already excluded).
    const lines = [
      punchLine({
        id: 1,
        employeeId: 'a',
        punchDate: day('2026-08-11'),
        shiftName: 'C.3',
        punchCount: 0,
        checkInCount: 0,
        checkOutCount: 0,
        isAbsent: true,
      }),
      ...Array.from({ length: 12 }, (_, i) =>
        punchLine({
          id: i + 2,
          employeeId: 'a',
          punchDate: day(`2026-08-${String(12 + i).padStart(2, '0')}`),
        }),
      ),
    ];
    expect(tipsWorkingDaysFromPunchLines(lines)).toBe(12);
  });
});

describe('punch follow-up working days (same cycle as تقرير البصمات)', () => {
  it('uses the payroll month and caps the end at today', () => {
    const { dateFrom, dateTo } = punchFollowUpPeriodDates(
      day('2026-08-19'),
      26,
      day('2026-08-19'),
    );
    expect(dateFrom.toISOString().slice(0, 10)).toBe('2026-07-26');
    expect(dateTo.toISOString().slice(0, 10)).toBe('2026-08-19');
  });

  it('groups punch-report lines per employee like the follow-up summary', () => {
    const periodDays = getSummaryPeriodDays(day('2026-08-01'), day('2026-08-03'));
    const map = actualWorkingDaysByEmployeeFromPunchLines(
      [
        punchLine({
          id: 1,
          employeeId: 'a',
          punchDate: day('2026-08-01'),
          isAbsent: true,
          punchCount: 0,
          checkInCount: 0,
          checkOutCount: 0,
        }),
        punchLine({
          id: 2,
          employeeId: 'a',
          punchDate: day('2026-08-02'),
        }),
        punchLine({
          id: 3,
          employeeId: 'b',
          punchDate: day('2026-08-01'),
        }),
      ],
      periodDays,
    );
    expect(map.get('a')).toBe(2); // 3 period − 1 absent + 0 earned
    expect(map.get('b')).toBe(3); // 3 working + 0 earned
  });
});

describe('tips cash/fawry after import snapshot', () => {
  it('splits cash vs fawry from stored isFawry, not a later employee toggle', () => {
    const summary = summarizeLoanImportBatch([
      {
        requestedAmount: 100,
        approvedAmount: 100,
        toApprove: true,
        shortAdvanceId: null,
        compareStatus: 'ready',
        employeeCode: '1',
        employeeName: 'Cash',
        note: null,
        rowReason: null,
        repaymentMonths: null,
        isFawry: false,
        employee: {
          code: '1',
          name: 'Cash',
          jobTitle: 'Waiter',
          hasFawryAccount: true,
          fawryAccount: '123',
          workLocation: {
            id: 'loc',
            name: 'Mall',
            actualName: 'Mall',
          },
        },
      },
      {
        requestedAmount: 200,
        approvedAmount: 200,
        toApprove: true,
        shortAdvanceId: null,
        compareStatus: 'ready',
        employeeCode: '2',
        employeeName: 'Fawry',
        note: null,
        rowReason: null,
        repaymentMonths: null,
        isFawry: true,
        employee: {
          code: '2',
          name: 'Fawry',
          jobTitle: 'Waiter',
          hasFawryAccount: false,
          fawryAccount: null,
          workLocation: {
            id: 'loc',
            name: 'Mall',
            actualName: 'Mall',
          },
        },
      },
    ]);
    expect(summary.cashAmount).toBe(100);
    expect(summary.fawryAmount).toBe(200.3);
    expect(summary.totalAmount).toBe(300.3);
  });
});
