import { describe, it, expect } from 'vitest';
import type { AdvanceLong, AdvanceLongPayment } from '@prisma/client';
import { computeLongAdvanceAmounts, round2 } from '../../src/services/advances.service';

function advance(
  overrides: Partial<AdvanceLong> = {},
  payments: Partial<AdvanceLongPayment>[] = [],
): AdvanceLong & { payments: AdvanceLongPayment[] } {
  return {
    id: 'adv1',
    employeeId: 'emp1',
    totalAmount: 6000,
    installments: 6,
    installmentAmount: 1000,
    state: 'running',
    date: new Date('2026-01-01'),
    startDate: new Date('2026-01-01'),
    nextDeductionDate: new Date('2026-01-01'),
    isAccountingLocked: false,
    ...overrides,
    payments: payments.map((p, i) => ({
      id: `pay${i}`,
      advanceId: 'adv1',
      payrollId: null,
      payrollLineId: null,
      amount: 1000,
      paymentDate: new Date('2026-02-01'),
      state: 'applied',
      ...p,
    })) as AdvanceLongPayment[],
  } as AdvanceLong & { payments: AdvanceLongPayment[] };
}

describe('computeLongAdvanceAmounts', () => {
  it('reports the full amount outstanding before any payment', () => {
    const a = computeLongAdvanceAmounts(advance());
    expect(a).toMatchObject({
      installmentAmount: 1000,
      paidAmount: 0,
      remainingAmount: 6000,
      paidInstallments: 0,
      remainingInstallments: 6,
    });
  });

  it('tracks partial repayment', () => {
    const a = computeLongAdvanceAmounts(advance({}, [{ amount: 1000 }, { amount: 1000 }]));
    expect(a.paidAmount).toBe(2000);
    expect(a.remainingAmount).toBe(4000);
    expect(a.paidInstallments).toBe(2);
    expect(a.remainingInstallments).toBe(4);
  });

  it('reports zero remaining instalments once settled', () => {
    const a = computeLongAdvanceAmounts(
      advance({}, Array.from({ length: 6 }, () => ({ amount: 1000 }))),
    );
    expect(a.remainingAmount).toBe(0);
    expect(a.remainingInstallments).toBe(0);
  });

  it('never reports a negative remaining amount on overpayment', () => {
    const a = computeLongAdvanceAmounts(advance({}, [{ amount: 9999 }]));
    expect(a.remainingAmount).toBe(0);
    expect(a.remainingInstallments).toBe(0);
  });

  it('derives the instalment amount when it is not stored', () => {
    const a = computeLongAdvanceAmounts(
      advance({ installmentAmount: 0, totalAmount: 5000, installments: 4 }),
    );
    expect(a.installmentAmount).toBe(1250);
  });

  it('treats a missing instalment count as one', () => {
    const a = computeLongAdvanceAmounts(
      advance({ installments: 0, installmentAmount: 0, totalAmount: 900 }),
    );
    expect(a.installmentAmount).toBe(900);
  });

  it('rounds a non-divisible instalment up to a whole final payment', () => {
    // 1000 over 3 → 333.33; after two payments 333.34 is left, which is one instalment
    const a = computeLongAdvanceAmounts(
      advance({ totalAmount: 1000, installments: 3, installmentAmount: 333.33 }, [
        { amount: 333.33 },
        { amount: 333.33 },
      ]),
    );
    expect(a.remainingAmount).toBe(333.34);
    expect(a.remainingInstallments).toBe(1);
  });

  it('treats a sub-cent balance as settled', () => {
    const a = computeLongAdvanceAmounts(
      advance({ totalAmount: 1000, installmentAmount: 500 }, [{ amount: 999.995 }]),
    );
    expect(a.remainingInstallments).toBe(0);
  });

  it('falls back to the instalment count when no instalment amount can be derived', () => {
    const a = computeLongAdvanceAmounts(
      advance({ totalAmount: 100, installments: 4, installmentAmount: 0 }, []),
    );
    expect(a.installmentAmount).toBe(25);
    expect(a.remainingInstallments).toBe(4);
  });
});

describe('round2 (advances)', () => {
  it('rounds money to two decimals', () => {
    expect(round2(333.335)).toBe(333.34);
    expect(round2(0)).toBe(0);
  });
});
