import { describe, it, expect } from 'vitest';
import {
  getManualPayrollEmployeeIds,
  deleteNonManualPayrollLines,
  maxPayrollLineSequence,
} from '../../src/services/payrollLine.service';

describe('payroll manual line helpers', () => {
  it('exports preserve helpers used by calculate/import', () => {
    expect(typeof getManualPayrollEmployeeIds).toBe('function');
    expect(typeof deleteNonManualPayrollLines).toBe('function');
    expect(typeof maxPayrollLineSequence).toBe('function');
  });
});
