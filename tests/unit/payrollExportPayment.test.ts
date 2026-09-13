import { describe, it, expect } from 'vitest';
import type { EmployeeProfile, PayrollLine } from '@prisma/client';
import {
  isResigned,
  payrollPaymentMethod,
} from '../../src/services/payrollExport.service';

function emp(partial: Partial<EmployeeProfile>): EmployeeProfile {
  return {
    id: 'e1',
    active: true,
    hasFawryAccount: true,
    departureDate: null,
    archivedAt: null,
    archiveReason: null,
    ...partial,
  } as EmployeeProfile;
}

function line(employee: EmployeeProfile | null): PayrollLine & { employee: EmployeeProfile | null } {
  return { employee } as PayrollLine & { employee: EmployeeProfile | null };
}

describe('payrollExport payment method (Odoo cash for departed)', () => {
  it('marks inactive / departureDate / archived as resigned', () => {
    expect(isResigned(emp({ active: false }))).toBe(true);
    expect(isResigned(emp({ departureDate: new Date('2026-07-01') }))).toBe(true);
    expect(isResigned(emp({ active: false, archivedAt: new Date('2026-07-01') }))).toBe(true);
    expect(isResigned(emp({ active: false, archiveReason: 'استقاله' }))).toBe(true);
    expect(isResigned(emp({ active: false, archiveReason: 'انهاء خدمة' }))).toBe(true);
    expect(isResigned(emp({ active: false, archiveReason: 'انقطاع' }))).toBe(true);
    expect(isResigned(emp({ active: true }))).toBe(false);
  });

  it('does not mark a restored employee as resigned despite stale archive metadata', () => {
    expect(
      isResigned(
        emp({
          active: true,
          archivedAt: new Date('2026-08-08'),
          archiveReason: 'انهاء',
          departureDate: null,
        }),
      ),
    ).toBe(false);
  });

  it('forces كاش for resigned even when hasFawryAccount (unfrozen)', () => {
    expect(payrollPaymentMethod(line(emp({ hasFawryAccount: true, active: false })))).toBe('كاش');
    expect(
      payrollPaymentMethod(
        line(emp({ hasFawryAccount: true, active: false, archiveReason: 'استقاله' })),
      ),
    ).toBe('كاش');
    expect(payrollPaymentMethod(line(emp({ hasFawryAccount: true })))).toBe('فوري');
    expect(payrollPaymentMethod(line(emp({ hasFawryAccount: false })))).toBe('كاش');
  });

  it('uses frozen paymentMethod even after archive', () => {
    const frozenFawry = {
      paymentMethod: 'فوري',
      employee: emp({ hasFawryAccount: true, active: false, archivedAt: new Date('2026-09-01') }),
    } as PayrollLine & { employee: EmployeeProfile | null };
    expect(payrollPaymentMethod(frozenFawry)).toBe('فوري');
  });
});
