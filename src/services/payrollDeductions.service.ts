import { DeductionState, Payroll, PayrollLine, PayrollState, Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import { recalculatePayrollLineTotals, refreshPayrollHeaderTotals } from './payrollLine.service';

/** Odoo biotime_payroll/models/payroll_deductions.py DEDUCTION_TYPE_FIELD */
export const DEDUCTION_TYPE_FIELD: Record<string, keyof PayrollLine> = {
  manual_debit: 'manualDebit',
  grouped_checks: 'groupedChecks',
  personal_checks: 'deductionChecks',
  check: 'deductionChecks',
  health_certificates: 'healthCertificatesDeduction',
  fraction: 'fractionDeduction',
  fines: 'fines',
  documents: 'documentsDeduction',
  admin: 'penaltyDeductionValue',
  previous_settlements: 'previousSettlements',
  previous_insurance: 'previousInsurance',
};

const FIELD_TO_TYPES = new Map<string, string[]>();
for (const [type, field] of Object.entries(DEDUCTION_TYPE_FIELD)) {
  const list = FIELD_TO_TYPES.get(field) ?? [];
  if (!list.includes(type)) list.push(type);
  FIELD_TO_TYPES.set(field, list);
}

const DEDUCTION_LINE_FIELDS = [...new Set(Object.values(DEDUCTION_TYPE_FIELD))];

/** Odoo _deduction_link_domain — also pick up orphaned «مطبق» rows (linked, no payroll). */
export function deductionLinkDomain(
  payroll: Payroll,
  employeeIds: string[],
  options?: { includeRelinked?: boolean },
): Prisma.DeductionWhereInput {
  const and: Prisma.DeductionWhereInput[] = [
    { employeeId: { in: employeeIds } },
    { date: { gte: payroll.dateFrom, lte: payroll.dateTo } },
    {
      OR: [
        { state: DeductionState.draft },
        { state: DeductionState.linked, payrollId: null },
      ],
    },
  ];

  if (options?.includeRelinked) {
    and.push({ OR: [{ payrollId: null }, { payrollId: payroll.id }] });
  } else {
    and.push({ payrollId: null });
  }

  if (payroll.deviceId) {
    and.push({ OR: [{ deviceId: payroll.deviceId }, { deviceId: null }] });
  }

  return { AND: and };
}

/** Odoo _revert_advances deduction section (biotime_payroll.py ~1769) */
export async function revertDeductionsOnPayroll(payrollId: string): Promise<void> {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll || payroll.state === PayrollState.confirmed) return;

  await prisma.deduction.updateMany({
    where: { payrollId },
    data: {
      state: DeductionState.draft,
      payrollId: null,
      payrollLineId: null,
      appliedAmount: 0,
    },
  });

  const zeroFields = Object.fromEntries(DEDUCTION_LINE_FIELDS.map((f) => [f, 0]));
  await prisma.payrollLine.updateMany({
    where: { payrollId },
    data: zeroFields,
  });
}

export async function linkDeductionsToPayroll(
  payrollId: string,
  options?: { allowConfirmed?: boolean },
): Promise<{ linked: number; skipped: number }> {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll) throw new Error('Payroll not found');
  if (payroll.state === 'confirmed' && !options?.allowConfirmed) {
    throw new Error('لا يمكن تعديل كشف رواتب مؤكد');
  }

  const lines = await prisma.payrollLine.findMany({ where: { payrollId } });
  if (!lines.length) throw new Error('لا توجد سطور رواتب — احسب الكشف أولاً');

  const employeeIds = [...new Set(lines.map((l) => l.employeeId))];
  const lineByEmployee = new Map(lines.map((l) => [l.employeeId, l]));

  const pending = await prisma.deduction.findMany({
    where: deductionLinkDomain(payroll, employeeIds, { includeRelinked: true }),
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  });
  const applied = await prisma.deduction.findMany({
    where: { payrollId, state: DeductionState.linked },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  });
  const allDeds = [...pending, ...applied.filter((d) => !pending.some((p) => p.id === d.id))];

  const affected = new Set<string>();
  let linked = 0;

  for (const ded of allDeds) {
    const field = DEDUCTION_TYPE_FIELD[ded.type];
    if (!field) continue;

    if (ded.payrollId && ded.payrollId !== payrollId) continue;

    const line = lineByEmployee.get(ded.employeeId);
    if (!line) continue;

    const linkData = {
      payrollId,
      payrollLineId: line.id,
      state: DeductionState.linked,
      appliedAmount: ded.amount,
    };

    if (ded.payrollId !== payrollId || ded.payrollLineId !== line.id) {
      await prisma.deduction.update({
        where: { id: ded.id },
        data: linkData,
      });
      if (ded.payrollId !== payrollId) linked++;
    } else if (Math.abs((ded.appliedAmount ?? 0) - ded.amount) > 0.001) {
      await prisma.deduction.update({
        where: { id: ded.id },
        data: { appliedAmount: ded.amount },
      });
    }

    affected.add(line.id);
  }

  for (const lineId of affected) {
    const line = lines.find((l) => l.id === lineId)!;
    const updates: Partial<PayrollLine> = {};

    for (const [field, types] of FIELD_TO_TYPES) {
      const sum = await prisma.deduction.aggregate({
        where: {
          payrollId,
          payrollLineId: lineId,
          employeeId: line.employeeId,
          type: { in: types },
          state: DeductionState.linked,
        },
        _sum: { amount: true },
      });
      const newTotal = sum._sum.amount ?? 0;
      (updates as Record<string, number>)[field] = newTotal;

      const linkedDeds = await prisma.deduction.findMany({
        where: {
          payrollId,
          payrollLineId: lineId,
          employeeId: line.employeeId,
          type: { in: types },
          state: DeductionState.linked,
        },
      });
      for (const d of linkedDeds) {
        if (Math.abs((d.appliedAmount ?? 0) - d.amount) > 0.001) {
          await prisma.deduction.update({
            where: { id: d.id },
            data: { appliedAmount: d.amount },
          });
        }
      }
    }

    const merged = { ...line, ...updates } as PayrollLine;
    const totals = recalculatePayrollLineTotals(merged);
    await prisma.payrollLine.update({
      where: { id: lineId },
      data: {
        ...updates,
        totalEarnings: totals.totalEarnings,
        grossSalary: totals.grossSalary,
        totalDeductions: totals.totalDeductions,
        netSalary: totals.netSalary,
      },
    });
  }

  await refreshPayrollHeaderTotals(payrollId);
  return { linked, skipped: allDeds.length - linked };
}

export async function fixPenaltyValues(payrollId: string): Promise<{ fixed: number; cleared: number }> {
  const lines = await prisma.payrollLine.findMany({ where: { payrollId } });
  let fixed = 0;
  let cleared = 0;

  for (const line of lines) {
    const sum = await prisma.deduction.aggregate({
      where: {
        payrollId,
        payrollLineId: line.id,
        type: 'admin',
        state: DeductionState.linked,
      },
      _sum: { amount: true },
    });
    const expected = sum._sum.amount ?? 0;
    const current = line.penaltyDeductionValue ?? 0;
    if (Math.abs(current - expected) < 0.01) continue;

    const merged = { ...line, penaltyDeductionValue: expected } as PayrollLine;
    const totals = recalculatePayrollLineTotals(merged);
    await prisma.payrollLine.update({
      where: { id: line.id },
      data: {
        penaltyDeductionValue: expected,
        totalEarnings: totals.totalEarnings,
        grossSalary: totals.grossSalary,
        totalDeductions: totals.totalDeductions,
        netSalary: totals.netSalary,
      },
    });
    if (expected === 0) cleared++;
    fixed++;
  }

  if (fixed) await refreshPayrollHeaderTotals(payrollId);
  return { fixed, cleared };
}

function round2Ded(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * After payroll Excel import, payroll line deduction columns are authoritative.
 * Sync linked Deduction rows so the deductions module shows applied amounts.
 */
export async function syncLinkedDeductionsFromPayrollImport(
  payrollId: string,
): Promise<{ updated: number; linked: number; unlinked: number }> {
  const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
  if (!payroll) return { updated: 0, linked: 0, unlinked: 0 };

  const lines = await prisma.payrollLine.findMany({ where: { payrollId } });
  let updated = 0;
  let linked = 0;
  let unlinked = 0;

  for (const line of lines) {
    for (const [field, types] of FIELD_TO_TYPES) {
      const target = round2Ded((line[field as keyof PayrollLine] as number) ?? 0);

      const linkedDeds = await prisma.deduction.findMany({
        where: {
          payrollLineId: line.id,
          payrollId,
          type: { in: types },
          state: DeductionState.linked,
        },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
      });

      if (target <= 0) {
        if (linkedDeds.length) {
          await prisma.deduction.updateMany({
            where: { id: { in: linkedDeds.map((d) => d.id) } },
            data: {
              state: DeductionState.draft,
              payrollId: null,
              payrollLineId: null,
              appliedAmount: 0,
            },
          });
          unlinked += linkedDeds.length;
        }
        continue;
      }

      if (!linkedDeds.length) {
        const drafts = await prisma.deduction.findMany({
          where: {
            employeeId: line.employeeId,
            type: { in: types },
            state: DeductionState.draft,
            payrollId: null,
            date: { gte: payroll.dateFrom, lte: payroll.dateTo },
          },
          orderBy: [{ date: 'asc' }, { id: 'asc' }],
        });
        let remaining = target;
        for (const d of drafts) {
          if (remaining <= 0.001) break;
          const apply = round2Ded(Math.min(d.amount, remaining));
          await prisma.deduction.update({
            where: { id: d.id },
            data: {
              amount: apply,
              appliedAmount: apply,
              state: DeductionState.linked,
              payrollId,
              payrollLineId: line.id,
            },
          });
          remaining = round2Ded(remaining - apply);
          linked++;
          updated++;
        }
        continue;
      }

      const sum = round2Ded(linkedDeds.reduce((s, d) => s + d.amount, 0));

      if (linkedDeds.length === 1) {
        const d = linkedDeds[0];
        if (Math.abs(d.amount - target) > 0.001 || Math.abs((d.appliedAmount ?? 0) - target) > 0.001) {
          await prisma.deduction.update({
            where: { id: d.id },
            data: { amount: target, appliedAmount: target, state: DeductionState.linked },
          });
          updated++;
        }
        continue;
      }

      if (Math.abs(sum - target) > 0.001) {
        const delta = round2Ded(target - sum);
        const last = linkedDeds[linkedDeds.length - 1];
        const newAmount = round2Ded(Math.max(0, last.amount + delta));
        await prisma.deduction.update({
          where: { id: last.id },
          data: { amount: newAmount, appliedAmount: newAmount, state: DeductionState.linked },
        });
        updated++;
      }

      for (const d of linkedDeds.slice(0, -1)) {
        if (Math.abs((d.appliedAmount ?? 0) - d.amount) > 0.001) {
          await prisma.deduction.update({
            where: { id: d.id },
            data: { appliedAmount: d.amount, state: DeductionState.linked },
          });
          updated++;
        }
      }
    }
  }

  return { updated, linked, unlinked };
}
