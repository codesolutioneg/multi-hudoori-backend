import { describe, it, expect } from 'vitest';
import {
  parsePunchReportSummariesFromSheet,
  buildPayrollLineFromSummary,
  validatePunchReportMeta,
} from '../../src/services/punchReportImport.service';
import { AppError } from '../../src/utils/errors';

describe('punchReportImport parser', () => {
  it('reads employee summary block after detail rows', () => {
    const rows: unknown[][] = [
      ['#', 'اسم الموظف', 'الوظيفة', 'كود الموظف', 'التاريخ', 'اليوم', 'الشيفت', 'وقت الحضور', 'وقت الانصراف', 'الحضور المتوقع', 'الانصراف المتوقع', 'إذن', 'تأخير الحضور', 'انصراف مبكر', 'صافي الساعات', 'الجهاز', 'Line ID'],
      [1, 'أحمد', 'Kitchen', '1001', '2026-07-01', 'الأربعاء', 'SH-1', '09:00', '18:00', '09:00', '18:00', '', 0, 0, 9, 'Dev', 1000001],
      [
        'عدد أيام العمل',
        'أيام الإجازة المستحقة',
        'أيام العمل الفعلية',
        'عدم تكرار البصمة',
        'خصم تكرار البصمة',
        'غياب بدون إذن',
        'جزاء إداري',
        'الإضافي',
        'تأخير الحضور',
        'تأخير الانصراف',
        'أيام الإجازة المرضية',
        'خصم الإجازة المرضية',
        'إجمالي الجزاءات',
      ],
      [20, 2, 22, 1, 0.25, 0, 1, 3.5, 0.5, 0.25, 0, 0, 2],
    ];

    const map = parsePunchReportSummariesFromSheet(rows);
    expect(map.size).toBe(1);
    const s = map.get('1001')!;
    expect(s.actualDays).toBe(22);
    expect(s.overtime).toBe(3.5);
    expect(s.punchDed).toBe(0.25);
    expect(s.lateDed).toBe(0.5);
    expect(s.earlyDed).toBe(0.25);
    expect(s.adminPenalty).toBe(1);
    expect(s.earnedLeave).toBe(2);
  });

  it('reads formula and rich-text cells written by HR', () => {
    const rows: unknown[][] = [
      ['#', 'اسم الموظف', 'كود الموظف', 'Line ID'],
      [1, { richText: [{ text: 'أحمد' }] }, { richText: [{ text: '1001' }] }, 1000001],
      [
        'عدد أيام العمل',
        'أيام الإجازة المستحقة',
        'أيام العمل الفعلية',
        'عدم تكرار البصمة',
        'خصم تكرار البصمة',
        'غياب بدون إذن',
        'جزاء إداري',
        'الإضافي',
        'تأخير الحضور',
        'تأخير الانصراف',
        'أيام الإجازة المرضية',
        'خصم الإجازة المرضية',
        'إجمالي الجزاءات',
      ],
      [
        25,
        4,
        { formula: '20+9', result: 29 },
        4,
        0.75,
        { formula: '1+1', result: 2 },
        0,
        0.31,
        1.75,
        0,
        0,
        { error: '#DIV/0!' },
        { formula: 'ROUND(E5+F5,2)', result: 4.5 },
      ],
    ];

    const s = parsePunchReportSummariesFromSheet(rows).get('1001')!;
    expect(s.empName).toBe('أحمد');
    expect(s.actualDays).toBe(29);
    expect(s.absentCount).toBe(2);
    expect(s.sickDed).toBe(0);
  });

  it('converts day fractions to money on payroll line', () => {
    const line = buildPayrollLineFromSummary({
      employeeId: 'e1',
      employeeCode: '1001',
      basicSalary: 3000,
      insuranceSalary: 0,
      medicalInsuranceSalary: 0,
      sequence: 1,
      payrollId: 'p1',
      summary: {
        earnedLeave: 0,
        actualDays: 20,
        punchCount: 1,
        punchDed: 0.25,
        absentCount: 1,
        adminPenalty: 1,
        overtime: 2,
        lateDed: 0.5,
        earlyDed: 0.25,
        sickDays: 0,
        sickDed: 0,
      },
    });
    // daily = 100
    expect(line.workingDays).toBe(20);
    expect(line.lateDeduction).toBe(50);
    expect(line.lateCheckoutDeduction).toBe(25);
    expect(line.punchDeductionCheckin).toBe(25);
    expect(line.absentDeduction).toBe(100);
    expect(line.adminDeduction).toBe(1); // days (Odoo); money via adminPenaltyMoney
    expect(line.singlePunchCount).toBe(0.25); // punch_ded days
    expect(line.overtimeHours).toBe(2);
  });
});

describe('validatePunchReportMeta', () => {
  const gridId = 'grid-abc';

  it('passes when meta matches grid and period', () => {
    expect(() =>
      validatePunchReportMeta(
        { shiftGridId: gridId, dateFrom: '2026-07-26', dateTo: '2026-08-25' },
        { shiftGridId: gridId, dateFrom: '2026-07-26', dateTo: '2026-08-25' },
      ),
    ).not.toThrow();
  });

  it('rejects wrong shift grid', () => {
    expect(() =>
      validatePunchReportMeta(
        { shiftGridId: 'other', dateFrom: '2026-07-26', dateTo: '2026-08-25' },
        { shiftGridId: gridId, dateFrom: '2026-07-26', dateTo: '2026-08-25' },
      ),
    ).toThrow(AppError);
  });

  it('rejects wrong period', () => {
    expect(() =>
      validatePunchReportMeta(
        { shiftGridId: gridId, dateFrom: '2026-01-01', dateTo: '2026-01-31' },
        { shiftGridId: gridId, dateFrom: '2026-07-26', dateTo: '2026-08-25' },
      ),
    ).toThrow(AppError);
  });
});
