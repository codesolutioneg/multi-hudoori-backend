import { AdvanceLoanImportState } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/prisma/client';
import { listShortAdvances } from '../../src/services/advances.service';
import { advanceShortJson } from '../../src/services/serialize.service';
import { createLocation, resetDatabase } from '../helpers/db';

describe('short advance import grouping metadata', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('returns employee branch/job and the originating loan import', async () => {
    const location = await createLocation({
      name: 'Sizzler',
      code: 'SIZZLER-GROUP',
    });
    const employee = await prisma.employeeProfile.create({
      data: {
        name: 'Grouped Employee',
        code: '12005',
        jobTitle: 'Steward',
        locationId: location.id,
        active: true,
      },
    });
    const shortAdvance = await prisma.advanceShort.create({
      data: {
        employeeId: employee.id,
        amount: 1500,
        date: new Date('2026-08-17T00:00:00.000Z'),
        deductionStartDate: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    const loanImport = await prisma.advanceLoanImport.create({
      data: {
        reference: 'LOAN/2026/00999',
        date: new Date('2026-08-17T00:00:00.000Z'),
        state: AdvanceLoanImportState.locked,
      },
    });
    await prisma.advanceLoanImportLine.create({
      data: {
        importId: loanImport.id,
        employeeId: employee.id,
        employeeCode: employee.code,
        employeeName: employee.name,
        approvedAmount: 1500,
        shortAdvanceId: shortAdvance.id,
      },
    });

    const items = await listShortAdvances();
    const payload = advanceShortJson(items[0]);
    expect(payload).toMatchObject({
      employeeCode: '12005',
      employeeJobTitle: 'Steward',
      locationId: location.id,
      locationName: 'Sizzler',
      importId: loanImport.id,
      importReference: 'LOAN/2026/00999',
      importDate: '2026-08-17',
    });
  });
});
