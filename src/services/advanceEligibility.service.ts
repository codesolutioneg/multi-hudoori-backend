/**
 * Advance eligibility — Odoo parity (biotime_advance_eligibility_export wizard)
 * with configurable percent, working-days gate, and outstanding advance offsets.
 */
import { AdvanceRequestState, AdvanceState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { earnedLeaveFromBaseDays } from './punchReport.service';
import {
  computeSummaryWorkMetrics,
  generatePunchReportLines,
  getPayableSummaryPeriodDays,
} from './punchReportLine.service';
import { getPayablePeriodPolicy } from './payablePeriod.service';
import { computeLongAdvanceAmounts, round2 } from './advances.service';

export type AdvanceEligibilitySource = 'punch_report' | 'shift_grid';

export type AdvanceSettings = {
  defaultPercent: number;
  minimumWorkingDays: number;
  enforceLimit: boolean;
  eligibilitySource: AdvanceEligibilitySource;
};

export type AdvanceEligibilityInput = {
  employeeId: string;
  percent?: number;
  shiftGridId?: string | null;
  dateFrom?: Date;
  dateTo?: Date;
  /** Ignore this pending request's own reservation — used while approving it. */
  excludeRequestId?: string | null;
};

export type AdvanceEligibilityResult = {
  employeeId: string;
  employeeName: string;
  basicSalary: number;
  actualWorkingDays: number;
  minimumWorkingDays: number;
  isEligible: boolean;
  percentUsed: number;
  maxEligibleAmount: number;
  pendingShortTotal: number;
  runningLongRemaining: number;
  draftLongTotal: number;
  pendingRequestTotal: number;
  committedAdvanceTotal: number;
  availableAmount: number;
  eligibilitySource: AdvanceEligibilitySource;
  periodLabel: string;
  shiftGridId: string | null;
  dateFrom: string;
  dateTo: string;
};

export async function getAdvanceSettings(): Promise<AdvanceSettings> {
  const config = await prisma.bioTimeConfig.findFirst();
  const source = config?.advanceEligibilitySource === 'shift_grid' ? 'shift_grid' : 'punch_report';
  return {
    defaultPercent: config?.advanceDefaultPercent ?? 25,
    minimumWorkingDays: config?.advanceMinimumWorkingDays ?? 15,
    enforceLimit: config?.advanceEnforceLimit !== false,
    eligibilitySource: source,
  };
}

function parseDay(d: Date): Date {
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

async function resolvePeriod(input: AdvanceEligibilityInput, settings: AdvanceSettings) {
  if (input.shiftGridId) {
    const grid = await prisma.shiftGrid.findUnique({ where: { id: input.shiftGridId } });
    if (!grid) throw new AppError('جدول الشيفت غير موجود', 404, 'NOT_FOUND');
    return {
      dateFrom: parseDay(grid.dateFrom),
      dateTo: parseDay(grid.dateTo),
      shiftGridId: grid.id,
      periodLabel: grid.name,
    };
  }
  if (input.dateFrom && input.dateTo) {
    return {
      dateFrom: parseDay(input.dateFrom),
      dateTo: parseDay(input.dateTo),
      shiftGridId: null as string | null,
      periodLabel: `${input.dateFrom.toISOString().slice(0, 10)} → ${input.dateTo.toISOString().slice(0, 10)}`,
    };
  }
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const grid = await prisma.shiftGrid.findFirst({
    where: {
      dateFrom: { lte: monthEnd },
      dateTo: { gte: monthStart },
    },
    orderBy: { updatedAt: 'desc' },
  });
  if (grid) {
    return {
      dateFrom: parseDay(grid.dateFrom),
      dateTo: parseDay(grid.dateTo),
      shiftGridId: grid.id,
      periodLabel: grid.name,
    };
  }
  const dateTo = parseDay(now);
  const dateFrom = new Date(dateTo);
  dateFrom.setUTCDate(dateFrom.getUTCDate() - 29);
  return {
    dateFrom,
    dateTo,
    shiftGridId: null as string | null,
    periodLabel: 'آخر 30 يوم',
  };
}

/** Odoo advance_eligibility_wizard._compute_actual_working_days (shift grid fallback) */
function actualWorkingDaysFromGridLines(
  lines: { isOff: boolean; isExcluded: boolean; shiftId: string | null; isAnnualLeave: boolean }[],
): number {
  const workingCount = lines.filter(
    (l) => !l.isOff && !l.isExcluded && (l.shiftId || l.isAnnualLeave),
  ).length;
  const earnedLeaveCapped = Math.min(earnedLeaveFromBaseDays(workingCount), 4);
  return Math.max(0, workingCount + earnedLeaveCapped);
}

async function computeActualWorkingDays(
  employeeId: string,
  period: { dateFrom: Date; dateTo: Date; shiftGridId: string | null },
  source: AdvanceEligibilitySource,
): Promise<number> {
  if (source === 'punch_report') {
    const lines = await generatePunchReportLines({
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
      employeeIds: [employeeId],
      shiftGridId: period.shiftGridId ?? undefined,
    });
    if (lines.length > 0) {
      const payablePolicy = await getPayablePeriodPolicy();
      const periodDays = getPayableSummaryPeriodDays(
        period.dateFrom,
        period.dateTo,
        payablePolicy,
      );
      return computeSummaryWorkMetrics(lines, periodDays).actualWorkingDays;
    }
  }

  const gridWhere: { employeeId: string; date: { gte: Date; lte: Date }; gridId?: string } = {
    employeeId,
    date: { gte: period.dateFrom, lte: period.dateTo },
  };
  if (period.shiftGridId) gridWhere.gridId = period.shiftGridId;

  const gridLines = await prisma.shiftGridLine.findMany({ where: gridWhere });
  if (gridLines.length > 0) {
    return actualWorkingDaysFromGridLines(gridLines);
  }

  if (source === 'shift_grid') {
    const lines = await generatePunchReportLines({
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
      employeeIds: [employeeId],
      shiftGridId: period.shiftGridId ?? undefined,
    });
    if (lines.length > 0) {
      const payablePolicy = await getPayablePeriodPolicy();
      const periodDays = getPayableSummaryPeriodDays(
        period.dateFrom,
        period.dateTo,
        payablePolicy,
      );
      return computeSummaryWorkMetrics(lines, periodDays).actualWorkingDays;
    }
  }

  return 0;
}

/**
 * Money already spoken for: confirmed advances plus requests still waiting on an
 * approval. Reserving pending requests stops an employee from filing the same
 * entitlement twice before HR gets to the first one.
 *
 * `excludeRequestId` leaves out the request currently being approved, so HR sees
 * the amount that was available when it was filed rather than one it blocks itself.
 */
export async function getOutstandingAdvanceTotals(
  employeeId: string,
  options: { excludeRequestId?: string | null } = {},
) {
  const pendingRequests = await prisma.advanceRequest.findMany({
    where: {
      employeeId,
      state: { in: [AdvanceRequestState.pending_branch, AdvanceRequestState.pending_hr] },
      ...(options.excludeRequestId ? { id: { not: options.excludeRequestId } } : {}),
    },
    select: { amount: true },
  });
  const pendingRequestTotal = round2(pendingRequests.reduce((s, r) => s + r.amount, 0));

  const shorts = await prisma.advanceShort.findMany({
    where: {
      employeeId,
      state: { in: [AdvanceState.pending, AdvanceState.confirmed] },
      isDeducted: false,
    },
  });
  const pendingShortTotal = round2(shorts.reduce((s, a) => s + a.amount, 0));

  const longs = await prisma.advanceLong.findMany({
    where: {
      employeeId,
      state: { in: [AdvanceState.running, AdvanceState.draft] },
    },
    include: { payments: true },
  });

  let runningLongRemaining = 0;
  let draftLongTotal = 0;
  for (const adv of longs) {
    if (adv.state === AdvanceState.running) {
      runningLongRemaining = round2(runningLongRemaining + computeLongAdvanceAmounts(adv).remainingAmount);
    } else {
      draftLongTotal = round2(draftLongTotal + adv.totalAmount);
    }
  }

  const committedAdvanceTotal = round2(
    pendingShortTotal + runningLongRemaining + draftLongTotal + pendingRequestTotal,
  );
  return {
    pendingShortTotal,
    runningLongRemaining,
    draftLongTotal,
    pendingRequestTotal,
    committedAdvanceTotal,
  };
}

export async function computeAdvanceEligibility(
  input: AdvanceEligibilityInput,
): Promise<AdvanceEligibilityResult> {
  const employee = await prisma.employeeProfile.findUnique({ where: { id: input.employeeId } });
  if (!employee) throw new AppError('الموظف غير موجود', 404, 'NOT_FOUND');

  const settings = await getAdvanceSettings();
  const period = await resolvePeriod(input, settings);
  const percentUsed = input.percent != null && input.percent > 0 ? input.percent : settings.defaultPercent;
  const basicSalary = round2(employee.basicSalary || 0);
  const actualWorkingDays = await computeActualWorkingDays(
    input.employeeId,
    period,
    settings.eligibilitySource,
  );
  // Reaching the minimum days (inclusive) earns the flat percent of salary;
  // below it, nothing. Both the day threshold and the percent are configurable.
  const isEligible = actualWorkingDays >= settings.minimumWorkingDays;
  const maxEligibleAmount = isEligible
    ? round2((basicSalary * percentUsed) / 100)
    : 0;

  const outstanding = await getOutstandingAdvanceTotals(input.employeeId, {
    excludeRequestId: input.excludeRequestId,
  });
  const availableAmount = round2(Math.max(0, maxEligibleAmount - outstanding.committedAdvanceTotal));

  return {
    employeeId: employee.id,
    employeeName: employee.name,
    basicSalary,
    actualWorkingDays,
    minimumWorkingDays: settings.minimumWorkingDays,
    isEligible,
    percentUsed,
    maxEligibleAmount,
    ...outstanding,
    availableAmount,
    eligibilitySource: settings.eligibilitySource,
    periodLabel: period.periodLabel,
    shiftGridId: period.shiftGridId,
    dateFrom: period.dateFrom.toISOString().slice(0, 10),
    dateTo: period.dateTo.toISOString().slice(0, 10),
  };
}

export type AdvanceLimitCheckInput = {
  employeeId: string;
  amount: number;
  percent?: number;
  shiftGridId?: string | null;
  dateFrom?: Date;
  dateTo?: Date;
  limitOverride?: boolean;
  overrideReason?: string | null;
  excludeRequestId?: string | null;
};

export async function assertAdvanceWithinLimit(input: AdvanceLimitCheckInput): Promise<AdvanceEligibilityResult> {
  const settings = await getAdvanceSettings();
  const eligibility = await computeAdvanceEligibility(input);

  if (!eligibility.isEligible && settings.enforceLimit && !input.limitOverride) {
    throw new AppError(
      `الموظف غير مستحق للسلف — أيام العمل الفعلية (${eligibility.actualWorkingDays}) أقل من الحد (${eligibility.minimumWorkingDays})`,
      400,
      'NOT_ELIGIBLE',
    );
  }

  if (input.amount <= 0) {
    throw new AppError('قيمة السلفة يجب أن تكون أكبر من صفر', 400, 'VALIDATION_ERROR');
  }

  if (input.amount > eligibility.availableAmount + 0.009) {
    if (!input.limitOverride) {
      if (settings.enforceLimit) {
        throw new AppError(
          `المبلغ يتجاوز الحد المتاح (${eligibility.availableAmount}) — الحد الأقصى ${eligibility.maxEligibleAmount} والمتبقي بعد السلف الحالية`,
          400,
          'LIMIT_EXCEEDED',
        );
      }
    } else {
      const reason = (input.overrideReason ?? '').trim();
      if (!reason) {
        throw new AppError('أدخل سبب تجاوز الحد عند الموافقة على مبلغ أعلى من المتاح', 400, 'OVERRIDE_REASON_REQUIRED');
      }
    }
  }

  return eligibility;
}

export function eligibilityAuditFields(
  eligibility: AdvanceEligibilityResult,
  limitOverride?: boolean,
  overrideReason?: string | null,
) {
  return {
    eligibilityPercent: eligibility.percentUsed,
    maxEligibleAtCreation: eligibility.maxEligibleAmount,
    actualWorkingDaysAtCreation: eligibility.actualWorkingDays,
    limitOverride: Boolean(limitOverride),
    overrideReason: limitOverride ? (overrideReason?.trim() || null) : null,
  };
}

export function advanceEligibilityJson(e: AdvanceEligibilityResult) {
  return {
    employeeId: e.employeeId,
    employeeName: e.employeeName,
    basicSalary: e.basicSalary,
    actualWorkingDays: e.actualWorkingDays,
    minimumWorkingDays: e.minimumWorkingDays,
    isEligible: e.isEligible,
    percentUsed: e.percentUsed,
    maxEligibleAmount: e.maxEligibleAmount,
    pendingShortTotal: e.pendingShortTotal,
    runningLongRemaining: e.runningLongRemaining,
    draftLongTotal: e.draftLongTotal,
    pendingRequestTotal: e.pendingRequestTotal,
    committedAdvanceTotal: e.committedAdvanceTotal,
    availableAmount: e.availableAmount,
    eligibilitySource: e.eligibilitySource,
    periodLabel: e.periodLabel,
    shiftGridId: e.shiftGridId,
    dateFrom: e.dateFrom,
    dateTo: e.dateTo,
  };
}

export function advanceSettingsJson(settings: AdvanceSettings) {
  return {
    advanceDefaultPercent: settings.defaultPercent,
    advanceMinimumWorkingDays: settings.minimumWorkingDays,
    advanceEnforceLimit: settings.enforceLimit,
    advanceEligibilitySource: settings.eligibilitySource,
  };
}
