/**
 * Odoo parity: biotime_payroll/models/payroll_advances.py + biotime.payroll._apply_advances
 */
import {
  AdvanceState,
  AdvanceLong,
  AdvanceLongPayment,
  AdvanceShort,
  Payroll,
  PayrollLine,
  PayrollState,
  Prisma,
} from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import {
  recalculatePayrollLineTotals,
  refreshPayrollHeaderTotals,
} from './payrollLine.service';
import {
  assertAdvanceWithinLimit,
  eligibilityAuditFields,
  type AdvanceLimitCheckInput,
} from './advanceEligibility.service';

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Odoo _advance_period_start — first day of payroll month */
export function advancePeriodStart(refDate: Date): Date {
  return new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), 1));
}

export type LongAdvanceAmounts = {
  installmentAmount: number;
  paidAmount: number;
  remainingAmount: number;
  paidInstallments: number;
  remainingInstallments: number;
};

export function computeLongAdvanceAmounts(
  advance: AdvanceLong & { payments: AdvanceLongPayment[] },
): LongAdvanceAmounts {
  const n = advance.installments || 1;
  const installmentAmount = round2(
    advance.installmentAmount || advance.totalAmount / n,
  );
  const paidAmount = round2(advance.payments.reduce((s, p) => s + p.amount, 0));
  const remainingAmount = round2(Math.max(0, advance.totalAmount - paidAmount));
  const paidInstallments = advance.payments.length;
  let remainingInstallments = 0;
  if (remainingAmount <= 0.01) {
    remainingInstallments = 0;
  } else if (installmentAmount > 0) {
    // Tolerate a one-cent residue: a 333.34 balance against a 333.33 instalment
    // is collected in a single final payment, not two.
    remainingInstallments = Math.max(
      0,
      Math.ceil((remainingAmount - 0.01) / installmentAmount),
    );
  } else {
    remainingInstallments = Math.max(0, n - paidInstallments);
  }
  return {
    installmentAmount,
    paidAmount,
    remainingAmount,
    paidInstallments,
    remainingInstallments,
  };
}

/** Editable while no instalment sits on a confirmed payroll sheet. */
export function longAdvanceCanEdit(advance: {
  state: AdvanceState;
  isAccountingLocked?: boolean;
  payments?: { payroll?: { state?: PayrollState } | null }[];
}): boolean {
  if (
    advance.state === AdvanceState.cancelled ||
    advance.state === AdvanceState.stopped ||
    advance.state === AdvanceState.done ||
    advance.isAccountingLocked
  ) {
    return false;
  }
  return !(advance.payments ?? []).some(
    (p) => p.payroll?.state === PayrollState.confirmed,
  );
}

/**
 * Stop is for a running long advance that still has balance. Unlike cancel, it
 * keeps every instalment already taken and simply ends further payroll draws.
 */
export function longAdvanceCanStop(advance: {
  state: AdvanceState;
  isAccountingLocked?: boolean;
  totalAmount: number;
  installmentAmount: number;
  installments: number;
  payments?: AdvanceLongPayment[];
}): boolean {
  if (advance.state !== AdvanceState.running || advance.isAccountingLocked) {
    return false;
  }
  const amounts = computeLongAdvanceAmounts({
    ...advance,
    payments: advance.payments ?? [],
  } as AdvanceLong & { payments: AdvanceLongPayment[] });
  return amounts.remainingAmount > 0.01;
}

/**
 * After a confirmed deduction the full edit path is closed. This path lets HR
 * reshape only what is left: remaining balance and how many instalments it
 * should still take.
 */
export function longAdvanceCanAdjustRemaining(advance: {
  state: AdvanceState;
  isAccountingLocked?: boolean;
  totalAmount: number;
  installmentAmount: number;
  installments: number;
  payments?: AdvanceLongPayment[];
}): boolean {
  if (advance.state !== AdvanceState.running || advance.isAccountingLocked) {
    return false;
  }
  const amounts = computeLongAdvanceAmounts({
    ...advance,
    payments: advance.payments ?? [],
  } as AdvanceLong & { payments: AdvanceLongPayment[] });
  return amounts.paidInstallments > 0 && amounts.remainingAmount > 0.01;
}

async function detachLongAdvanceFromUnconfirmedPayrolls(
  advanceId: string,
): Promise<string[]> {
  const payments = await prisma.advanceLongPayment.findMany({
    where: { advanceId },
    include: { payroll: { select: { state: true } } },
  });
  const removable = payments.filter(
    (p) => !p.payroll || p.payroll.state !== PayrollState.confirmed,
  );
  if (removable.length === 0) return [];

  const payrollIds = [
    ...new Set(
      removable.map((p) => p.payrollId).filter((id): id is string => Boolean(id)),
    ),
  ];

  await prisma.advanceLongPayment.deleteMany({
    where: { id: { in: removable.map((p) => p.id) } },
  });

  for (const payrollId of payrollIds) {
    const lines = await prisma.payrollLine.findMany({ where: { payrollId } });
    for (const line of lines) {
      const sum = await prisma.advanceLongPayment.aggregate({
        where: { payrollLineId: line.id },
        _sum: { amount: true },
      });
      const advanceLongTotal = round2(sum._sum.amount ?? 0);
      const merged = { ...line, advanceLongTotal } as PayrollLine;
      const totals = recalculatePayrollLineTotals(merged);
      await prisma.payrollLine.update({
        where: { id: line.id },
        data: {
          advanceLongTotal,
          totalEarnings: totals.totalEarnings,
          grossSalary: totals.grossSalary,
          totalDeductions: totals.totalDeductions,
          netSalary: totals.netSalary,
        },
      });
    }
    await refreshPayrollHeaderTotals(payrollId);
  }

  const adv = await prisma.advanceLong.findUnique({
    where: { id: advanceId },
    include: { payments: true },
  });
  if (adv?.state === AdvanceState.done) {
    const { remainingAmount } = computeLongAdvanceAmounts(adv);
    if (remainingAmount > 0.01) {
      await prisma.advanceLong.update({
        where: { id: advanceId },
        data: { state: AdvanceState.running },
      });
    }
  }

  return payrollIds;
}

/** True when payroll month is on or after the deduction-start month */
export function isPayrollEligibleForDeductionStart(
  payrollDateTo: Date,
  deductionStartDate: Date,
): boolean {
  const payrollMonth = advancePeriodStart(payrollDateTo).getTime();
  const startMonth = advancePeriodStart(deductionStartDate).getTime();
  return payrollMonth >= startMonth;
}

/** True when short advance date falls in payroll month window (Odoo _short_advances_for_employee) */
export function shortAdvanceDateInPayrollPeriod(
  advanceDate: Date,
  payrollDateTo: Date,
): boolean {
  const periodStart = advancePeriodStart(payrollDateTo);
  return advanceDate >= periodStart && advanceDate <= payrollDateTo;
}

/** Odoo _short_advances_for_employee — advance date within payroll month */
export async function shortAdvancesForEmployee(
  payroll: Payroll,
  employeeId: string,
  preview = false,
): Promise<AdvanceShort[]> {
  const periodStart = advancePeriodStart(payroll.dateTo);
  const where: Prisma.AdvanceShortWhereInput = {
    employeeId,
    // pending = not yet on a sheet; confirmed = legacy. Applied/cancelled stay out.
    state: { in: [AdvanceState.pending, AdvanceState.confirmed] },
    isDeducted: false,
    date: { gte: periodStart, lte: payroll.dateTo },
  };
  if (preview) {
    where.payrollId = null;
  } else {
    where.OR = [{ payrollId: null }, { payrollId: payroll.id }];
  }
  return prisma.advanceShort.findMany({
    where,
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  });
}

/** Odoo _revert_advances (before recalc / re-link) */
export async function revertAdvancesOnPayroll(
  payrollId: string,
): Promise<void> {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll || payroll.state === PayrollState.confirmed) return;

  await prisma.advanceShort.updateMany({
    where: { payrollId, isDeducted: false },
    data: {
      payrollId: null,
      payrollLineId: null,
      state: AdvanceState.pending,
    },
  });

  await prisma.payrollLine.updateMany({
    where: { payrollId },
    data: { advanceShortTotal: 0, advanceLongTotal: 0 },
  });

  const payments = await prisma.advanceLongPayment.findMany({
    where: { payrollId },
  });
  const advanceIds = [...new Set(payments.map((p) => p.advanceId))];
  await prisma.advanceLongPayment.deleteMany({ where: { payrollId } });

  for (const advId of advanceIds) {
    const adv = await prisma.advanceLong.findUnique({
      where: { id: advId },
      include: { payments: true },
    });
    if (!adv) continue;
    const { remainingAmount } = computeLongAdvanceAmounts(adv);
    if (adv.state === AdvanceState.done && remainingAmount > 0.01) {
      await prisma.advanceLong.update({
        where: { id: advId },
        data: { state: AdvanceState.running },
      });
    }
  }
}

/** Apply short advances for one payroll line */
export async function applyShortAdvancesForLine(
  payroll: Payroll,
  line: PayrollLine,
): Promise<number> {
  const shorts = await shortAdvancesForEmployee(payroll, line.employeeId);
  const shortTotal = round2(shorts.reduce((s, a) => s + a.amount, 0));
  if (shortTotal > 0) {
    await prisma.advanceShort.updateMany({
      where: { id: { in: shorts.map((a) => a.id) } },
      data: {
        payrollId: payroll.id,
        payrollLineId: line.id,
        // Like deductions → linked/applied as soon as reserved on the payroll sheet
        state: AdvanceState.applied,
      },
    });
  }
  return shortTotal;
}

/** Apply long advance installments for one line (calculate / full link) */
export async function applyLongAdvancesForLine(
  payroll: Payroll,
  line: PayrollLine,
): Promise<number> {
  const longs = await prisma.advanceLong.findMany({
    where: {
      employeeId: line.employeeId,
      state: AdvanceState.running,
      isAccountingLocked: false,
    },
    include: { payments: true },
  });

  let longTotal = 0;
  for (const adv of longs) {
    const deductionStart = adv.startDate ?? adv.date;
    if (!isPayrollEligibleForDeductionStart(payroll.dateTo, deductionStart))
      continue;

    const existing = await prisma.advanceLongPayment.findFirst({
      where: { advanceId: adv.id, payrollId: payroll.id },
    });
    if (existing) {
      longTotal = round2(longTotal + existing.amount);
      continue;
    }

    const { remainingAmount, installmentAmount } =
      computeLongAdvanceAmounts(adv);
    if (remainingAmount <= 0.01) continue;
    const amt = round2(Math.min(installmentAmount, remainingAmount));
    if (amt <= 0) continue;

    await prisma.advanceLongPayment.create({
      data: {
        advanceId: adv.id,
        payrollId: payroll.id,
        payrollLineId: line.id,
        amount: amt,
        paymentDate: payroll.dateTo,
        state: AdvanceState.applied,
      },
    });
    longTotal = round2(longTotal + amt);

    const newRemaining = round2(remainingAmount - amt);
    if (newRemaining <= 0.01) {
      await prisma.advanceLong.update({
        where: { id: adv.id },
        data: { state: AdvanceState.done },
      });
    } else {
      const nextMonth = new Date(
        Date.UTC(
          payroll.dateTo.getUTCFullYear(),
          payroll.dateTo.getUTCMonth() + 1,
          1,
        ),
      );
      await prisma.advanceLong.update({
        where: { id: adv.id },
        data: { nextDeductionDate: nextMonth },
      });
    }
  }

  return longTotal;
}

/** Odoo _apply_advances for one payroll line */
export async function applyAdvancesForLine(
  payroll: Payroll,
  line: PayrollLine,
): Promise<{ shortTotal: number; longTotal: number }> {
  const shortTotal = await applyShortAdvancesForLine(payroll, line);
  const longTotal = await applyLongAdvancesForLine(payroll, line);
  return { shortTotal, longTotal };
}

/** Odoo action_link_long_advances_to_payroll — idempotent long-only link */
export async function linkLongAdvancesOnly(
  payrollId: string,
): Promise<{ linked: number; updated: number }> {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن تعديل كشف رواتب مؤكد', 400, 'ACTION_ERROR');
  }

  const lines = await prisma.payrollLine.findMany({ where: { payrollId } });
  let linked = 0;
  let updated = 0;

  for (const line of lines) {
    const longs = await prisma.advanceLong.findMany({
      where: {
        employeeId: line.employeeId,
        state: { not: AdvanceState.cancelled },
        isAccountingLocked: false,
      },
      include: { payments: true },
    });

    for (const adv of longs) {
      const { remainingAmount } = computeLongAdvanceAmounts(adv);
      if (remainingAmount <= 0.01) continue;

      const exists = await prisma.advanceLongPayment.findFirst({
        where: { advanceId: adv.id, payrollId },
      });
      if (exists) continue;

      const amt = round2(
        Math.min(adv.installmentAmount || remainingAmount, remainingAmount),
      );
      if (amt <= 0) continue;

      await prisma.advanceLongPayment.create({
        data: {
          advanceId: adv.id,
          payrollId,
          payrollLineId: line.id,
          amount: amt,
          paymentDate: payroll.dateTo,
          state: AdvanceState.applied,
        },
      });
      linked++;

      const newRemaining = round2(remainingAmount - amt);
      await prisma.advanceLong.update({
        where: { id: adv.id },
        data: {
          state:
            newRemaining <= 0.01 ? AdvanceState.done : AdvanceState.running,
          nextDeductionDate:
            newRemaining <= 0.01
              ? adv.nextDeductionDate
              : new Date(
                  Date.UTC(
                    payroll.dateTo.getUTCFullYear(),
                    payroll.dateTo.getUTCMonth() + 1,
                    1,
                  ),
                ),
        },
      });
    }

    const booked = await prisma.advanceLongPayment.aggregate({
      where: { payrollId, payrollLineId: line.id },
      _sum: { amount: true },
    });
    const newTotal = round2(booked._sum.amount ?? 0);
    if (Math.abs((line.advanceLongTotal || 0) - newTotal) > 0.009) {
      const merged = { ...line, advanceLongTotal: newTotal };
      const totals = recalculatePayrollLineTotals(merged);
      await prisma.payrollLine.update({
        where: { id: line.id },
        data: {
          advanceLongTotal: newTotal,
          totalEarnings: totals.totalEarnings,
          grossSalary: totals.grossSalary,
          totalDeductions: totals.totalDeductions,
          netSalary: totals.netSalary,
        },
      });
      updated++;
    }
  }

  if (linked || updated) {
    await refreshPayrollHeaderTotals(payrollId);
  }
  return { linked, updated };
}

export async function lockLongAdvanceAccounting(
  advanceId: string,
  journalMoveId?: string,
) {
  const adv = await prisma.advanceLong.findUnique({ where: { id: advanceId } });
  if (!adv) throw new AppError('السلفة غير موجودة', 404, 'NOT_FOUND');
  return prisma.advanceLong.update({
    where: { id: advanceId },
    data: {
      isAccountingLocked: true,
      remainingJournalMoveId: journalMoveId ?? null,
    },
    include: { employee: true, payments: true },
  });
}

/** Odoo action_confirm — mark reserved short advances as applied */
export async function confirmAdvancesOnPayroll(
  payrollId: string,
): Promise<void> {
  const lines = await prisma.payrollLine.findMany({
    where: { payrollId },
    select: { id: true, advanceShortTotal: true },
  });
  const lineIdsWithShort = new Set(
    lines.filter((l) => (l.advanceShortTotal || 0) > 0).map((l) => l.id),
  );

  const shorts = await prisma.advanceShort.findMany({
    where: { payrollId, isDeducted: false },
  });

  const toApply = shorts.filter(
    (s) => s.payrollLineId && lineIdsWithShort.has(s.payrollLineId),
  );

  if (toApply.length) {
    await prisma.advanceShort.updateMany({
      where: { id: { in: toApply.map((s) => s.id) } },
      data: { isDeducted: true, state: AdvanceState.applied },
    });
  }
}

export async function createShortAdvance(params: {
  employeeId: string;
  amount: number;
  date?: Date;
  deductionStartDate?: Date;
  notes?: string | null;
  sourceGridId?: string | null;
  eligibilityPercent?: number;
  shiftGridId?: string | null;
  eligibilityDateFrom?: Date;
  eligibilityDateTo?: Date;
  limitOverride?: boolean;
  overrideReason?: string | null;
  /** Set when this advance is being granted by approving a pending request. */
  excludeRequestId?: string | null;
}) {
  const eligibility = await assertAdvanceWithinLimit({
    employeeId: params.employeeId,
    amount: params.amount,
    percent: params.eligibilityPercent,
    shiftGridId: params.shiftGridId ?? params.sourceGridId,
    dateFrom: params.eligibilityDateFrom,
    dateTo: params.eligibilityDateTo,
    limitOverride: params.limitOverride,
    overrideReason: params.overrideReason,
    excludeRequestId: params.excludeRequestId,
  } satisfies AdvanceLimitCheckInput);

  const grantDate = params.date ?? new Date();
  const deductionStart = params.deductionStartDate ?? grantDate;
  return prisma.advanceShort.create({
    data: {
      employeeId: params.employeeId,
      amount: params.amount,
      state: AdvanceState.pending,
      date: grantDate,
      deductionStartDate: deductionStart,
      notes: params.notes ?? null,
      sourceGridId:
        params.sourceGridId ?? params.shiftGridId ?? eligibility.shiftGridId,
      ...eligibilityAuditFields(
        eligibility,
        params.limitOverride,
        params.overrideReason,
      ),
    },
    include: { employee: true },
  });
}

export async function cancelShortAdvance(id: string) {
  const adv = await prisma.advanceShort.findUnique({ where: { id } });
  if (!adv) throw new AppError('السلفة غير موجودة', 404, 'NOT_FOUND');
  if (
    adv.state !== AdvanceState.pending &&
    adv.state !== AdvanceState.confirmed
  ) {
    throw new AppError('يمكن إلغاء السلف المعلّقة فقط', 400, 'ACTION_ERROR');
  }
  if (adv.isDeducted || adv.payrollId) {
    throw new AppError(
      'السلفة مرتبطة بكشف رواتب — لا يمكن إلغاؤها',
      400,
      'ACTION_ERROR',
    );
  }
  return prisma.advanceShort.update({
    where: { id },
    data: { state: AdvanceState.cancelled },
    include: { employee: true },
  });
}

export async function createLongAdvance(params: {
  employeeId: string;
  totalAmount: number;
  installments: number;
  startDate?: Date;
  notes?: string | null;
}) {
  const total = params.totalAmount;
  const installments = Math.max(1, Math.floor(params.installments));
  if (installments <= 0) {
    throw new AppError(
      'عدد الأقساط لازم يكون أكبر من صفر',
      400,
      'VALIDATION_ERROR',
    );
  }
  if (total <= 0) {
    throw new AppError('قيمة السلفة يجب أن تكون أكبر من صفر', 400, 'VALIDATION_ERROR');
  }

  const start = params.startDate ?? new Date();
  return prisma.advanceLong.create({
    data: {
      employeeId: params.employeeId,
      totalAmount: total,
      installments,
      installmentAmount: round2(total / installments),
      state: AdvanceState.draft,
      date: start,
      startDate: start,
      nextDeductionDate: start,
      notes: params.notes ?? null,
    },
    include: { employee: true, payments: true },
  });
}

export async function updateLongAdvance(
  id: string,
  params: {
    totalAmount?: number;
    installments?: number;
    startDate?: Date;
    notes?: string | null;
  },
) {
  const adv = await prisma.advanceLong.findUnique({
    where: { id },
    include: {
      payments: { include: { payroll: { select: { state: true } } } },
    },
  });
  if (!adv) throw new AppError('السلفة غير موجودة', 404, 'NOT_FOUND');
  if (!longAdvanceCanEdit(adv)) {
    throw new AppError(
      'لا يمكن تعديل السلفة — فيه قسط على كشف رواتب مؤكد أو السلفة مقفلة',
      400,
      'ACTION_ERROR',
    );
  }

  const total = params.totalAmount ?? adv.totalAmount;
  const installments = Math.max(
    1,
    Math.floor(params.installments ?? adv.installments),
  );
  if (installments <= 0 || total <= 0) {
    throw new AppError(
      'قيمة السلفة وعدد الأقساط لازم يكونوا أكبر من صفر',
      400,
      'VALIDATION_ERROR',
    );
  }

  const paidOnConfirmed = adv.payments.filter(
    (p) => p.payroll?.state === PayrollState.confirmed,
  );
  const paidConfirmed = round2(
    paidOnConfirmed.reduce((s, p) => s + p.amount, 0),
  );
  if (total + 0.009 < paidConfirmed) {
    throw new AppError(
      `إجمالي السلفة لا يمكن أن يكون أقل من الأقساط المخصومة على كشوف مؤكدة (${paidConfirmed})`,
      400,
      'VALIDATION_ERROR',
    );
  }

  await detachLongAdvanceFromUnconfirmedPayrolls(id);

  const start = params.startDate ?? adv.startDate ?? adv.date;
  return prisma.advanceLong.update({
    where: { id },
    data: {
      totalAmount: total,
      installments,
      installmentAmount: round2(total / installments),
      startDate: start,
      nextDeductionDate: start,
      notes: params.notes !== undefined ? params.notes : adv.notes,
    },
    include: {
      employee: true,
      payments: { include: { payroll: { select: { id: true, state: true } } } },
    },
  });
}

export async function confirmLongAdvance(id: string) {
  const adv = await prisma.advanceLong.findUnique({ where: { id } });
  if (!adv) throw new AppError('السلفة غير موجودة', 404, 'NOT_FOUND');
  if (adv.state !== AdvanceState.draft) {
    throw new AppError('يمكن تفعيل السلف في المسودة فقط', 400, 'ACTION_ERROR');
  }
  if (adv.totalAmount <= 0 || adv.installments <= 0) {
    throw new AppError(
      'قيمة السلفة وعدد الأقساط لازم يكونوا أكبر من صفر',
      400,
      'VALIDATION_ERROR',
    );
  }
  return prisma.advanceLong.update({
    where: { id },
    data: { state: AdvanceState.running },
    include: { employee: true, payments: true },
  });
}

export async function cancelLongAdvance(id: string) {
  const adv = await prisma.advanceLong.findUnique({
    where: { id },
    include: { payments: true },
  });
  if (!adv) throw new AppError('السلفة غير موجودة', 404, 'NOT_FOUND');
  if (adv.payments.length > 0) {
    throw new AppError(
      'فيه أقساط مخصومة — لا يمكن الإلغاء',
      400,
      'ACTION_ERROR',
    );
  }
  return prisma.advanceLong.update({
    where: { id },
    data: { state: AdvanceState.cancelled },
    include: { employee: true, payments: true },
  });
}

/**
 * End further payroll deductions on a running long advance. Paid instalments
 * stay; the next payroll month will not pick this advance up.
 */
export async function stopLongAdvance(id: string) {
  const adv = await prisma.advanceLong.findUnique({
    where: { id },
    include: { payments: true },
  });
  if (!adv) throw new AppError('السلفة غير موجودة', 404, 'NOT_FOUND');
  if (!longAdvanceCanStop(adv)) {
    throw new AppError(
      'يمكن إيقاف السلفة الطويلة النشطة التي ما زال عليها رصيد فقط',
      400,
      'ACTION_ERROR',
    );
  }
  return prisma.advanceLong.update({
    where: { id },
    data: { state: AdvanceState.stopped, nextDeductionDate: null },
    include: {
      employee: true,
      payments: { include: { payroll: { select: { id: true, state: true } } } },
    },
  });
}

/**
 * Reshape the unpaid portion of a partially deducted long advance. Confirmed
 * payments are left untouched; total and instalment count are rewritten around
 * them so the next deduction uses the new instalment size.
 */
export async function adjustLongAdvanceRemaining(
  id: string,
  params: { remainingAmount: number; remainingInstallments: number },
) {
  const adv = await prisma.advanceLong.findUnique({
    where: { id },
    include: {
      payments: { include: { payroll: { select: { state: true } } } },
    },
  });
  if (!adv) throw new AppError('السلفة غير موجودة', 404, 'NOT_FOUND');
  if (!longAdvanceCanAdjustRemaining(adv)) {
    throw new AppError(
      'تعديل المتبقي متاح فقط لسلفة نشطة خُصم منها قسط وما زال عليها رصيد',
      400,
      'ACTION_ERROR',
    );
  }

  const remainingAmount = round2(params.remainingAmount);
  const remainingInstallments = Math.floor(params.remainingInstallments);
  if (remainingAmount <= 0 || remainingInstallments <= 0) {
    throw new AppError(
      'المتبقي وعدد الأقساط المتبقية لازم يكونوا أكبر من صفر',
      400,
      'VALIDATION_ERROR',
    );
  }

  const paidAmount = round2(adv.payments.reduce((s, p) => s + p.amount, 0));
  const paidInstallments = adv.payments.length;
  const totalAmount = round2(paidAmount + remainingAmount);
  const installments = paidInstallments + remainingInstallments;
  const installmentAmount = round2(remainingAmount / remainingInstallments);

  // Detach only draft-sheet instalments so the new size is not mixed with a
  // provisional draw that still might change.
  await detachLongAdvanceFromUnconfirmedPayrolls(id);

  return prisma.advanceLong.update({
    where: { id },
    data: {
      totalAmount,
      installments,
      installmentAmount,
    },
    include: {
      employee: true,
      payments: { include: { payroll: { select: { id: true, state: true } } } },
    },
  });
}

export async function listShortAdvances(state?: AdvanceState) {
  const advances = await prisma.advanceShort.findMany({
    where: state ? { state } : undefined,
    include: {
      employee: {
        include: {
          workLocation: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { date: 'desc' },
  });
  const importLines = advances.length
    ? await prisma.advanceLoanImportLine.findMany({
        where: {
          shortAdvanceId: { in: advances.map((advance) => advance.id) },
        },
        select: {
          shortAdvanceId: true,
          import: {
            select: { id: true, reference: true, date: true },
          },
        },
      })
    : [];
  const importByAdvanceId = new Map(
    importLines
      .filter((line) => line.shortAdvanceId)
      .map((line) => [line.shortAdvanceId!, line.import]),
  );
  return advances.map((advance) => ({
    ...advance,
    loanImport: importByAdvanceId.get(advance.id) ?? null,
  }));
}

export async function listLongAdvances(state?: AdvanceState) {
  return prisma.advanceLong.findMany({
    where: state ? { state } : undefined,
    include: {
      employee: true,
      payments: { include: { payroll: { select: { id: true, state: true } } } },
    },
    orderBy: { date: 'desc' },
  });
}

export async function getLongAdvance(id: string) {
  const advance = await prisma.advanceLong.findUnique({
    where: { id },
    include: {
      employee: true,
      payments: { include: { payroll: { select: { id: true, state: true } } } },
    },
  });
  if (!advance) throw new AppError('السلفة غير موجودة', 404, 'NOT_FOUND');
  return advance;
}
