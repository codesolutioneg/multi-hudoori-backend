import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { DeductionState, UserRole } from '@prisma/client';
import ExcelJS from 'exceljs';
import { prisma } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';

describe('deductions wizard multi-branch (e2e)', () => {
  let hr: SeededUser;
  let locA = '';
  let locB = '';
  let empA = '';
  let empB = '';
  let codeA = '';
  let codeB = '';
  const dateFrom = '2026-08-01';
  const dateTo = '2026-08-31';

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hr = await createUser({ login: 'hr-ded-wiz@test.local', role: UserRole.HR_MANAGER });
    const stamp = Date.now();
    const a = await prisma.location.create({
      data: { name: `e2e-ded-a-${stamp}`, active: true },
    });
    const b = await prisma.location.create({
      data: { name: `e2e-ded-b-${stamp}`, active: true },
    });
    locA = a.id;
    locB = b.id;
    codeA = `EA${stamp % 100000}`;
    codeB = `EB${stamp % 100000}`;
    const ea = await prisma.employeeProfile.create({
      data: {
        name: 'E2E Ded A',
        code: codeA,
        locationId: locA,
        active: true,
        basicSalary: 4000,
        jobTitle: 'كاشير',
      },
    });
    const eb = await prisma.employeeProfile.create({
      data: {
        name: 'E2E Ded B',
        code: codeB,
        locationId: locB,
        active: true,
        basicSalary: 4000,
        jobTitle: 'كاشير',
      },
    });
    empA = ea.id;
    empB = eb.id;
    for (const [employeeId, empCode] of [
      [empA, codeA],
      [empB, codeB],
    ] as const) {
      await prisma.transaction.create({
        data: {
          employeeId,
          empCode,
          punchTime: new Date('2026-08-12T09:00:00.000Z'),
          punchState: '0',
          isDuplicate: false,
        },
      });
    }
  });

  it('rejects empty locationIds on scope-count', async () => {
    expectFail(
      await rpc('/api/biotime/deductions/scope-count', {}, hr.token),
      'VALIDATION_ERROR',
    );
  });

  it('scope-count and job-titles accept locationIds', async () => {
    const count = expectOk(
      await rpc(
        '/api/biotime/deductions/scope-count',
        { locationIds: [locA, locB], dateFrom, dateTo },
        hr.token,
      ),
    );
    expect(count.count).toBe(2);

    const jobs = expectOk(
      await rpc(
        '/api/biotime/deductions/job-titles',
        { locationIds: [locA, locB], dateFrom, dateTo },
        hr.token,
      ),
    );
    expect(jobs.jobTitles).toEqual(expect.arrayContaining(['كاشير']));
  });

  it('export → preview → confirm branch import across branches', async () => {
    const exported = expectOk(
      await rpc(
        '/api/biotime/deductions/export-branch-template',
        {
          locationIds: [locA, locB],
          deductionType: 'fines',
          dateFrom,
          dateTo,
        },
        hr.token,
      ),
    );
    expect(exported.count).toBe(2);
    expect(String(exported.filename)).toMatch(/_x2_/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(String(exported.base64), 'base64') as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('Deductions')!;
    sheet.getCell(4, 4).value = 25;
    sheet.getCell(5, 4).value = 35;
    const filled = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

    const preview = expectOk(
      await rpc(
        '/api/biotime/deductions/preview-branch-xlsx',
        {
          base64: filled,
          locationIds: [locA, locB],
          dateFrom,
          dateTo,
          deductionType: 'fines',
        },
        hr.token,
      ),
    );
    expect(preview.countOk).toBe(2);
    const lines = (preview.lines as Array<Record<string, unknown>>).filter((l) => l.ok === true);

    const confirmed = expectOk(
      await rpc(
        '/api/biotime/deductions/confirm-branch-import',
        {
          date: '2026-08-20',
          lines: lines.map((l) => ({
            employeeId: l.employeeId,
            type: l.type,
            amount: l.amount,
            note: l.note ?? '',
          })),
        },
        hr.token,
      ),
    );
    expect(confirmed.created).toBe(2);

    const rows = await prisma.deduction.findMany({
      where: { employeeId: { in: [empA, empB] }, type: 'fines' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === DeductionState.draft)).toBe(true);
  });

  it('distribute preview → recalc → confirm; rejects empty locations and sum drift', async () => {
    expectFail(
      await rpc(
        '/api/biotime/deductions/distribute/preview',
        {
          locationIds: [],
          dateFrom,
          dateTo,
          deductionType: 'manual_debit',
          totalAmount: 100,
        },
        hr.token,
      ),
      'VALIDATION_ERROR',
    );

    const preview = expectOk(
      await rpc(
        '/api/biotime/deductions/distribute/preview',
        {
          locationIds: [locA, locB],
          dateFrom,
          dateTo,
          deductionType: 'manual_debit',
          totalAmount: 100,
          date: '2026-08-20',
        },
        hr.token,
      ),
    );
    expect(preview.employeeCount).toBe(2);
    const previewLines = preview.lines as Array<{ employeeId: string; amount: number; note?: string }>;
    expect(previewLines.map((l) => l.amount)).toEqual([50, 50]);

    const recalc = expectOk(
      await rpc(
        '/api/biotime/deductions/distribute/recalc',
        {
          employeeIds: [previewLines[0]!.employeeId],
          totalAmount: 100,
        },
        hr.token,
      ),
    );
    expect((recalc.lines as Array<{ amount: number }>)[0]!.amount).toBe(100);

    expectFail(
      await rpc(
        '/api/biotime/deductions/distribute/confirm',
        {
          locationIds: [locA, locB],
          dateFrom,
          dateTo,
          deductionType: 'manual_debit',
          totalAmount: 100,
          lines: [{ employeeId: empA, amount: 40 }, { employeeId: empB, amount: 40 }],
        },
        hr.token,
      ),
      'VALIDATION_ERROR',
    );

    const confirmed = expectOk(
      await rpc(
        '/api/biotime/deductions/distribute/confirm',
        {
          locationIds: [locA, locB],
          dateFrom,
          dateTo,
          deductionType: 'manual_debit',
          totalAmount: 100,
          date: '2026-08-20',
          lines: previewLines.map((l) => ({
            employeeId: l.employeeId,
            amount: l.amount,
            note: l.note ?? '',
          })),
        },
        hr.token,
      ),
    );
    expect(confirmed.created).toBe(2);
  });

  it('accepts legacy single locationId', async () => {
    const count = expectOk(
      await rpc(
        '/api/biotime/deductions/scope-count',
        { locationId: locA, dateFrom, dateTo },
        hr.token,
      ),
    );
    expect(count.count).toBe(1);
  });
});
