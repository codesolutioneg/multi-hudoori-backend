import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AdvanceLoanImportState,
  AdvanceState,
} from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { approveAdvanceLoanImport } from '../../src/services/advanceLoanImport.service';
import {
  exportLoanAccountsSheetsForPeriod,
  resolveLoanImportBranchName,
  resolveLoanImportFilenameLocationToken,
} from '../../src/services/odoo/odooLoanAccounts.service';
import {
  ensureBioTimeConfig,
  resetDatabase,
} from '../helpers/db';

async function createEmployee(code: string) {
  return prisma.employeeProfile.create({
    data: {
      code,
      name: `Employee ${code}`,
      jobTitle: 'Tester',
      basicSalary: 10000,
      active: true,
    },
  });
}

async function createImport(
  reference: string,
  employees: Array<{ id: string; code: string; name: string }>,
) {
  return prisma.advanceLoanImport.create({
    data: {
      reference,
      date: new Date('2026-09-15T00:00:00.000Z'),
      state: AdvanceLoanImportState.draft,
      lines: {
        create: employees.map((employee) => ({
          employeeId: employee.id,
          employeeCode: employee.code,
          employeeName: employee.name,
          requestedAmount: 1000,
          eligibleAmount: 2500,
          systemEligibleAmount: 2500,
          approvedAmount: 1000,
          compareStatus: 'ready',
          toApprove: true,
        })),
      },
    },
    include: { lines: true },
  });
}

describe('advance loan import atomic approval', () => {
  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    await prisma.bioTimeConfig.updateMany({
      data: {
        advanceEnforceLimit: false,
        advanceMinimumWorkingDays: 0,
        payrollMonthStartDay: 26,
      },
    });
  });

  it('preflights every row and creates nothing when one employee has a same-cycle advance', async () => {
    const duplicate = await createEmployee('DUP-1');
    const clean = await createEmployee('CLEAN-1');
    const batch = await createImport('LOAN/TEST/ATOMIC-FAIL', [
      duplicate,
      clean,
    ]);
    await prisma.advanceShort.create({
      data: {
        employeeId: duplicate.id,
        amount: 500,
        state: AdvanceState.pending,
        date: new Date('2026-09-14T00:00:00.000Z'),
        deductionStartDate: new Date('2026-10-01T00:00:00.000Z'),
      },
    });

    await expect(approveAdvanceLoanImport(batch.id)).rejects.toMatchObject({
      errorCode: 'LOAN_IMPORT_PREFLIGHT_FAILED',
    });

    const after = await prisma.advanceLoanImport.findUniqueOrThrow({
      where: { id: batch.id },
      include: { lines: true },
    });
    expect(after.state).toBe(AdvanceLoanImportState.draft);
    expect(after.lines.every((line) => line.shortAdvanceId == null)).toBe(true);
    expect(after.lines.every((line) => line.toApprove)).toBe(true);
    expect(
      await prisma.advanceShort.count({
        where: { employeeId: clean.id },
      }),
    ).toBe(0);
  });

  it('creates nothing when the same employee appears twice inside the import', async () => {
    const duplicate = await createEmployee('DUP-IN-SHEET');
    const clean = await createEmployee('CLEAN-2');
    const batch = await createImport('LOAN/TEST/DUP-IN-SHEET', [
      duplicate,
      duplicate,
      clean,
    ]);

    await expect(
      approveAdvanceLoanImport(batch.id, { approveConflicts: true }),
    ).rejects.toMatchObject({
      errorCode: 'LOAN_IMPORT_PREFLIGHT_FAILED',
      message: expect.stringContaining('مكرر داخل نفس كشف الاستيراد'),
    });

    const after = await prisma.advanceLoanImport.findUniqueOrThrow({
      where: { id: batch.id },
      include: { lines: true },
    });
    expect(after.state).toBe(AdvanceLoanImportState.draft);
    expect(after.lines.every((line) => line.shortAdvanceId == null)).toBe(true);
    expect(
      await prisma.advanceShort.count({
        where: { employeeId: { in: [duplicate.id, clean.id] } },
      }),
    ).toBe(0);
  });

  it('approves same-cycle conflicts too when HR explicitly chooses approve anyway', async () => {
    const duplicate = await createEmployee('ANYWAY-1');
    const clean = await createEmployee('APPROVE-1');
    const batch = await createImport('LOAN/TEST/APPROVE-ANYWAY', [
      duplicate,
      clean,
    ]);
    await prisma.advanceShort.create({
      data: {
        employeeId: duplicate.id,
        amount: 500,
        state: AdvanceState.pending,
        date: new Date('2026-09-14T00:00:00.000Z'),
        deductionStartDate: new Date('2026-10-01T00:00:00.000Z'),
      },
    });

    const result = await approveAdvanceLoanImport(batch.id, {
      approveConflicts: true,
    });

    expect(result.created).toBe(2);
    expect(result.approvedConflicts).toBe(1);
    const after = await prisma.advanceLoanImport.findUniqueOrThrow({
      where: { id: batch.id },
      include: { lines: true },
    });
    expect(after.state).toBe(AdvanceLoanImportState.locked);
    expect(after.totalAmount).toBe(2000);
    expect(after.lines.every((line) => line.compareStatus === 'approved')).toBe(
      true,
    );
    expect(after.lines.every((line) => line.shortAdvanceId != null)).toBe(true);
    expect(
      await prisma.advanceShort.count({
        where: { employeeId: { in: [duplicate.id, clean.id] } },
      }),
    ).toBe(3);
  });

  it('creates every selected advance and locks the sheet in one transaction', async () => {
    const first = await createEmployee('OK-1');
    const second = await createEmployee('OK-2');
    const batch = await createImport('LOAN/TEST/ATOMIC-OK', [first, second]);

    const result = await approveAdvanceLoanImport(batch.id);

    expect(result.created).toBe(2);
    const after = await prisma.advanceLoanImport.findUniqueOrThrow({
      where: { id: batch.id },
      include: { lines: true },
    });
    expect(after.state).toBe(AdvanceLoanImportState.locked);
    expect(after.lines.every((line) => line.shortAdvanceId != null)).toBe(true);
    expect(after.lines.every((line) => !line.toApprove)).toBe(true);
    expect(
      await prisma.advanceShort.count({
        where: { employeeId: { in: [first.id, second.id] } },
      }),
    ).toBe(2);
  });

  it('exports only loan sheets and does not count Commission imports', async () => {
    const loanEmployee = await createEmployee('EXPORT-LOAN');
    const tipEmployee = await createEmployee('EXPORT-TIP');
    const loan = await createImport('LOAN/TEST/EXPORT', [loanEmployee]);
    const tip = await createImport('TIP/TEST/EXPORT', [tipEmployee]);
    await prisma.advanceLoanImport.update({
      where: { id: loan.id },
      data: { state: AdvanceLoanImportState.locked },
    });
    await prisma.advanceLoanImport.update({
      where: { id: tip.id },
      data: { state: AdvanceLoanImportState.locked, kind: 'tip' },
    });

    const exported = await exportLoanAccountsSheetsForPeriod(
      new Date('2026-08-26T00:00:00.000Z'),
      new Date('2026-09-25T00:00:00.000Z'),
    );

    expect(exported.fileCount).toBe(1);
  });

  it('names the Odoo review from the batch branch, not the first employee', () => {
    const batch = {
      device: {
        name: 'Brisk Blue Side',
        location: {
          name: 'BRI.MAR',
          actualName: 'Brisk blue side-marina',
        },
      },
    };
    expect(resolveLoanImportBranchName(batch)).toBe('Brisk blue side-marina');
    expect(
      resolveLoanImportFilenameLocationToken(batch, [
        'Brisk strip',
        'Balkans La Centera',
      ]),
    ).toBe('Brisk_blue_side-marina');
    expect(
      resolveLoanImportFilenameLocationToken({}, [
        'Brisk Open Air Mall',
        'Brisk Open Air Mall',
        'Sizzler Open Air Mall',
      ]),
    ).toBe('Brisk_Open_Air_Mall');
  });
});
