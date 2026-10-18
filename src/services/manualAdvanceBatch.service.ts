/**
 * Open batch of manually created short advances → lock + send to Odoo accounts.
 *
 * - One draft AdvanceLoanImport with source=manual collects all unsent manual shorts.
 * - After successful Odoo send the batch is locked; new shorts open a new batch.
 */
import {
  AdvanceLoanImportState,
  AdvanceState,
  type AdvanceShort,
  type EmployeeProfile,
} from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { nextManualAdvanceBatchReference } from './deductionReference.service';
import {
  calculateLoanPaymentAmounts,
  employeeIsFawry,
  sendLoanImportToOdooAccounts,
} from './odoo/odooLoanAccounts.service';
import {
  advanceLoanImportJson,
  freezeLoanImportPaymentSnapshot,
  getAdvanceLoanImport,
} from './advanceLoanImport.service';

export const MANUAL_BATCH_SOURCE = 'manual';

function cairoToday(): Date {
  const iso = new Date().toLocaleDateString('en-CA', {
    timeZone: 'Africa/Cairo',
  });
  return new Date(`${iso}T00:00:00.000Z`);
}

export async function findOpenManualBatch() {
  return prisma.advanceLoanImport.findFirst({
    where: {
      source: MANUAL_BATCH_SOURCE,
      kind: 'loan',
      state: AdvanceLoanImportState.draft,
      odooAccountsSendId: null,
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getOrCreateOpenManualBatch() {
  const existing = await findOpenManualBatch();
  if (existing) return existing;

  const date = cairoToday();
  const reference = await nextManualAdvanceBatchReference(date);
  return prisma.advanceLoanImport.create({
    data: {
      reference,
      kind: 'loan',
      source: MANUAL_BATCH_SOURCE,
      date,
      defaultRepaymentMonths: 1,
      defaultReason: 'سلفة يدوية',
      state: AdvanceLoanImportState.draft,
    },
  });
}

/** Attach an existing AdvanceShort to the open manual batch (creates import line). */
export async function attachShortToOpenManualBatch(
  advance: AdvanceShort & {
    employee?: Pick<
      EmployeeProfile,
      | 'id'
      | 'code'
      | 'name'
      | 'hasFawryAccount'
      | 'fawryAccount'
    > | null;
  },
) {
  if (advance.state === AdvanceState.cancelled) return null;

  const already = await prisma.advanceLoanImportLine.findFirst({
    where: { shortAdvanceId: advance.id },
    select: { id: true, importId: true },
  });
  if (already) return already;

  const employee =
    advance.employee ??
    (await prisma.employeeProfile.findUnique({
      where: { id: advance.employeeId },
      select: {
        id: true,
        code: true,
        name: true,
        hasFawryAccount: true,
        fawryAccount: true,
      },
    }));
  if (!employee) throw new NotFoundError('Employee not found');

  const batch = await getOrCreateOpenManualBatch();
  const isFawry = employeeIsFawry(employee);

  return prisma.advanceLoanImportLine.create({
    data: {
      importId: batch.id,
      employeeId: employee.id,
      employeeCode: employee.code,
      employeeName: employee.name,
      requestedAmount: advance.amount,
      eligibleAmount: advance.amount,
      systemEligibleAmount: advance.maxEligibleAtCreation ?? advance.amount,
      eligibilityOverridden: advance.limitOverride === true,
      approvedAmount: advance.amount,
      actualWorkingDays: advance.actualWorkingDaysAtCreation,
      compareStatus: 'approved',
      toApprove: false,
      rowReason: advance.notes || 'سلفة يدوية',
      shortAdvanceId: advance.id,
      isFawry,
      note: `سلفة يدوية ${advance.id.slice(0, 8)}`,
    },
  });
}

/**
 * Pull orphan manual shorts (no import line) into the open batch.
 * Skips cancelled / already-linked advances.
 */
export async function ensureOrphanManualShortsInOpenBatch() {
  const linked = await prisma.advanceLoanImportLine.findMany({
    where: { shortAdvanceId: { not: null } },
    select: { shortAdvanceId: true },
  });
  const linkedIds = new Set(
    linked.map((l) => l.shortAdvanceId).filter(Boolean) as string[],
  );

  const orphans = await prisma.advanceShort.findMany({
    where: {
      state: { in: [AdvanceState.pending, AdvanceState.confirmed] },
      ...(linkedIds.size
        ? { id: { notIn: [...linkedIds] } }
        : {}),
    },
    include: {
      employee: {
        select: {
          id: true,
          code: true,
          name: true,
          hasFawryAccount: true,
          fawryAccount: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  let attached = 0;
  for (const advance of orphans) {
    await attachShortToOpenManualBatch(advance);
    attached += 1;
  }
  return { attached };
}

export async function getOpenManualBatchPayload() {
  await ensureOrphanManualShortsInOpenBatch();
  const batch = await findOpenManualBatch();
  if (!batch) {
    return { batch: null, lineCount: 0 };
  }
  // Drop empty open batch (all lines removed).
  const lineCount = await prisma.advanceLoanImportLine.count({
    where: { importId: batch.id },
  });
  if (lineCount === 0) {
    return { batch: null, lineCount: 0, importId: batch.id };
  }
  return {
    batch: await getAdvanceLoanImport(batch.id),
    lineCount,
    importId: batch.id,
  };
}

async function freezeManualBatchTotals(importId: string) {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: importId },
    include: {
      lines: {
        include: {
          employee: {
            select: {
              hasFawryAccount: true,
              fawryAccount: true,
            },
          },
        },
      },
    },
  });
  if (!batch) throw new NotFoundError('Advance loan import not found');

  let cashAmount = 0;
  let fawryApprovedAmount = 0;
  let fawryCommissionAmount = 0;
  for (const line of batch.lines) {
    if (!(line.approvedAmount > 0) || !line.shortAdvanceId) continue;
    const isFawry =
      batch.state === AdvanceLoanImportState.draft && line.employee
        ? employeeIsFawry(line.employee)
        : line.isFawry === true;
    const amounts = calculateLoanPaymentAmounts(line.approvedAmount, isFawry);
    if (isFawry) {
      fawryApprovedAmount += amounts.approvedAmount;
      fawryCommissionAmount += amounts.fawryCommission;
    } else {
      cashAmount += amounts.totalAmount;
    }
    if (batch.state === AdvanceLoanImportState.draft && isFawry !== line.isFawry) {
      await prisma.advanceLoanImportLine.update({
        where: { id: line.id },
        data: { isFawry },
      });
    }
  }
  cashAmount = Math.round(cashAmount * 100) / 100;
  fawryApprovedAmount = Math.round(fawryApprovedAmount * 100) / 100;
  fawryCommissionAmount = Math.round(fawryCommissionAmount * 100) / 100;
  const fawryAmount =
    Math.round((fawryApprovedAmount + fawryCommissionAmount) * 100) / 100;
  const totalAmount = Math.round((cashAmount + fawryAmount) * 100) / 100;

  return prisma.advanceLoanImport.update({
    where: { id: importId },
    data: { cashAmount, fawryAmount, totalAmount },
  });
}

/** Lock open manual batch (shorts already exist) then send to Odoo accounts. */
export async function lockAndSendOpenManualBatchToOdoo() {
  await ensureOrphanManualShortsInOpenBatch();
  const batch = await findOpenManualBatch();
  if (!batch) {
    throw new AppError(
      'لا توجد سلف يدوية معلّقة للإرسال',
      400,
      'NO_OPEN_MANUAL_BATCH',
    );
  }

  // No Prisma relation on shortAdvanceId — load AdvanceShort states separately.
  const lines = await prisma.advanceLoanImportLine.findMany({
    where: { importId: batch.id },
  });
  const shortIds = [
    ...new Set(
      lines
        .map((l) => l.shortAdvanceId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const shorts = shortIds.length
    ? await prisma.advanceShort.findMany({
        where: { id: { in: shortIds } },
        select: { id: true, state: true },
      })
    : [];
  const shortStateById = new Map(shorts.map((s) => [s.id, s.state]));
  const sendable = lines.filter((l) => {
    if (!l.shortAdvanceId || !(l.approvedAmount > 0)) return false;
    return shortStateById.get(l.shortAdvanceId) !== AdvanceState.cancelled;
  });
  if (!sendable.length) {
    throw new AppError(
      'لا توجد سلف يدوية صالحة في الباتش المفتوح',
      400,
      'NO_VALID_MANUAL_LINES',
    );
  }

  await freezeManualBatchTotals(batch.id);

  const locked = await prisma.advanceLoanImport.update({
    where: { id: batch.id },
    data: { state: AdvanceLoanImportState.locked },
  });

  try {
    const odoo = await sendLoanImportToOdooAccounts(locked.id);
    return {
      ...odoo,
      import: await getAdvanceLoanImport(locked.id),
    };
  } catch (err) {
    // Keep same batch open for retry — do not merge with a new batch.
    await prisma.advanceLoanImport.update({
      where: { id: locked.id },
      data: { state: AdvanceLoanImportState.draft },
    });
    throw err;
  }
}

export async function isManualOpenBatch(importId: string): Promise<boolean> {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: importId },
    select: {
      source: true,
      state: true,
      odooAccountsSendId: true,
    },
  });
  return (
    batch?.source === MANUAL_BATCH_SOURCE &&
    batch.state === AdvanceLoanImportState.draft &&
    batch.odooAccountsSendId == null
  );
}

export { advanceLoanImportJson, freezeLoanImportPaymentSnapshot };
