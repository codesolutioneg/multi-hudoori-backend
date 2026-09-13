import { describe, it, expect } from 'vitest';
import { PayrollState } from '@prisma/client';
import {
  DEDUCTION_TYPE_FIELD,
  deductionLinkDomain,
} from '../../src/services/payrollDeductions.service';

describe('payrollDeductions.service', () => {
  const payroll = {
    id: 'pay1',
    dateFrom: new Date('2026-05-01'),
    dateTo: new Date('2026-05-31'),
    deviceId: 'dev1',
    state: PayrollState.draft,
  } as const;

  it('maps Odoo deduction types to payroll line fields', () => {
    expect(DEDUCTION_TYPE_FIELD.fines).toBe('fines');
    expect(DEDUCTION_TYPE_FIELD.personal_checks).toBe('deductionChecks');
    expect(DEDUCTION_TYPE_FIELD.check).toBe('deductionChecks');
    expect(DEDUCTION_TYPE_FIELD.admin).toBe('penaltyDeductionValue');
  });

  it('deductionLinkDomain filters draft rows in payroll period', () => {
    const domain = deductionLinkDomain(payroll, ['emp1'], { includeRelinked: true });
    const json = JSON.stringify(domain);
    expect(json).toContain('emp1');
    expect(json).toContain('draft');
    expect(json).toContain('linked');
    expect(json).toContain('2026-05-01');
  });

  it('deductionLinkDomain adds device filter when payroll has deviceId', () => {
    const domain = deductionLinkDomain(payroll, ['emp1']);
    const json = JSON.stringify(domain);
    expect(json).toContain('dev1');
    expect(json).toContain('deviceId');
  });

  it('deductionLinkDomain without device skips device OR clause', () => {
    const domain = deductionLinkDomain({ ...payroll, deviceId: null }, ['emp1']);
    expect(JSON.stringify(domain)).not.toContain('"dev1"');
  });
});
