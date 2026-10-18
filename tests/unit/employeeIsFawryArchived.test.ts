import { describe, it, expect } from 'vitest';
import {
  employeeForcedCashChannel,
  employeeIsFawry,
} from '../../src/services/odoo/odooLoanAccounts.service';

describe('employeeIsFawry — archived staff force كاش', () => {
  it('returns فوري for active employees with Fawry', () => {
    expect(
      employeeIsFawry({
        hasFawryAccount: true,
        fawryAccount: '0100',
        active: true,
        archivedAt: null,
        departureDate: null,
      }),
    ).toBe(true);
  });

  it('forces كاش when inactive even if Fawry is set', () => {
    expect(
      employeeIsFawry({
        hasFawryAccount: true,
        fawryAccount: '0100',
        active: false,
        archivedAt: new Date('2026-09-01'),
        departureDate: null,
      }),
    ).toBe(false);
    expect(
      employeeForcedCashChannel({
        active: false,
        archivedAt: new Date('2026-09-01'),
      }),
    ).toBe(true);
  });

  it('forces كاش when departureDate is set', () => {
    expect(
      employeeIsFawry({
        hasFawryAccount: true,
        fawryAccount: null,
        active: true,
        archivedAt: null,
        departureDate: new Date('2026-08-01'),
      }),
    ).toBe(false);
  });

  it('keeps فوري for restored employees with stale archivedAt', () => {
    expect(
      employeeForcedCashChannel({
        active: true,
        archivedAt: new Date('2026-08-08'),
        departureDate: null,
      }),
    ).toBe(false);
    expect(
      employeeIsFawry({
        hasFawryAccount: true,
        fawryAccount: '0100',
        active: true,
        archivedAt: new Date('2026-08-08'),
        departureDate: null,
      }),
    ).toBe(true);
  });
});
