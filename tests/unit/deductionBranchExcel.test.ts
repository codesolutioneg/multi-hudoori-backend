import ExcelJS from 'exceljs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  exportDeductionBranchTemplate,
  previewDeductionBranchXlsx,
  confirmDeductionBranchImport,
  equalSplitAmounts,
  parseExcelAmount,
  previewDeductionDistribute,
  confirmDeductionDistribute,
  recalcDeductionDistribute,
  employeesForDeductionScope,
  normalizeDeductionLocationIds,
} from '../../src/services/deductionExcel.service';
import { DEDUCTION_TYPES } from '../../src/services/serialize.service';
import { prisma } from '../../src/prisma/client';

describe('parseExcelAmount', () => {
  it('reads Excel formula cached result', () => {
    expect(parseExcelAmount({ formula: '380+170+275', result: 825 })).toBe(825);
    expect(parseExcelAmount({ formula: '71.67+70.81', result: 142.48 })).toBe(142.48);
  });

  it('reads literal numbers and comma strings', () => {
    expect(parseExcelAmount(570)).toBe(570);
    expect(parseExcelAmount('1,234.5')).toBe(1234.5);
  });

  it('returns 0 for empty / formula without result', () => {
    expect(parseExcelAmount(null)).toBe(0);
    expect(parseExcelAmount({ formula: 'A1+B1' })).toBe(0);
  });
});

describe('equalSplitAmounts (Odoo parity)', () => {
  it('splits with remainder on last line', () => {
    expect(equalSplitAmounts(3, 100)).toEqual([33.33, 33.33, 33.34]);
    expect(equalSplitAmounts(2, 10)).toEqual([5, 5]);
    expect(equalSplitAmounts(1, 7.5)).toEqual([7.5]);
  });

  it('returns empty for invalid inputs', () => {
    expect(equalSplitAmounts(0, 100)).toEqual([]);
    expect(equalSplitAmounts(3, 0)).toEqual([]);
    expect(equalSplitAmounts(-1, 10)).toEqual([]);
  });

  it('sums exactly to total', () => {
    for (const [n, total] of [[3, 100], [7, 99.99], [4, 1], [11, 33.33]] as const) {
      const amounts = equalSplitAmounts(n, total);
      const sum = Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100;
      expect(sum).toBe(total);
    }
  });
});

describe('normalizeDeductionLocationIds', () => {
  it('merges locationId and locationIds uniquely', () => {
    expect(normalizeDeductionLocationIds({ locationId: 'a' })).toEqual(['a']);
    expect(normalizeDeductionLocationIds({ locationIds: ['a', 'b', 'a'] })).toEqual(['a', 'b']);
    expect(normalizeDeductionLocationIds({ locationId: 'c', locationIds: ['a', 'c'] })).toEqual([
      'a',
      'c',
    ]);
    expect(normalizeDeductionLocationIds({})).toEqual([]);
  });
});

describe('deduction branch excel', () => {
  let locationId = '';
  let employeeId = '';
  let empCode = '';
  const dateFrom = '2026-08-01';
  const dateTo = '2026-08-31';
  let punchId = '';

  beforeAll(async () => {
    const loc = await prisma.location.create({
      data: { name: `test-ded-loc-${Date.now()}`, active: true },
    });
    locationId = loc.id;
    empCode = `TDED${Date.now() % 100000}`;
    const emp = await prisma.employeeProfile.create({
      data: {
        name: 'Test Ded Emp',
        code: empCode,
        locationId,
        active: true,
        basicSalary: 5000,
        jobTitle: 'كاشير',
      },
    });
    employeeId = emp.id;
    const punch = await prisma.transaction.create({
      data: {
        employeeId,
        empCode,
        punchTime: new Date('2026-08-15T10:00:00.000Z'),
        punchState: '0',
        isDuplicate: false,
      },
    });
    punchId = punch.id;
  });

  afterAll(async () => {
    if (punchId) await prisma.transaction.delete({ where: { id: punchId } }).catch(() => {});
    await prisma.deduction.deleteMany({ where: { employeeId } }).catch(() => {});
    if (employeeId) await prisma.employeeProfile.delete({ where: { id: employeeId } }).catch(() => {});
    if (locationId) await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
  });

  it('exports legacy branch template with type column', async () => {
    const { base64, count, filename } = await exportDeductionBranchTemplate({ locationId });
    expect(count).toBeGreaterThan(0);
    expect(filename).toMatch(/deduction_all_/);
    expect(base64.length).toBeGreaterThan(100);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('استقطاعات');
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell(2, 1).value).toBe('كود الموظف');
    expect(sheet!.getCell(2, 4).value).toBe('نوع الخصم');
  });

  it('exports Odoo single-type template filtered by punch period', async () => {
    const { base64, count } = await exportDeductionBranchTemplate({
      locationId,
      deductionType: 'personal_checks',
      dateFrom,
      dateTo,
    });
    expect(count).toBe(1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('Deductions');
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell(3, 1).value).toBe('employee_code');
    expect(sheet!.getCell(4, 1).value).toBe(empCode);
  });

  it('previews filled rows with punch gate and confirms draft deductions', async () => {
    const { base64 } = await exportDeductionBranchTemplate({ locationId });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('استقطاعات')!;

    const code = String(sheet.getCell(4, 1).value ?? '');
    expect(code).toBe(empCode);
    const typeLabel = DEDUCTION_TYPES.find((t) => t.value === 'personal_checks')?.label ?? 'شيكات شخصية';
    sheet.getCell(4, 4).value = typeLabel;
    sheet.getCell(4, 5).value = 123.45;
    sheet.getCell(4, 6).value = 'unit-test';

    const filled = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const preview = await previewDeductionBranchXlsx({
      base64: filled,
      locationId,
      dateFrom,
      dateTo,
    });
    expect(preview.countOk).toBeGreaterThanOrEqual(1);
    const okLine = preview.lines.find((l) => l.ok && l.employeeCode === code);
    expect(okLine).toBeTruthy();
    expect(okLine!.type).toBe('personal_checks');
    expect(okLine!.amount).toBeCloseTo(123.45);

    const confirm = await confirmDeductionBranchImport({
      lines: [{
        employeeId: okLine!.employeeId!,
        type: okLine!.type,
        amount: okLine!.amount,
        note: okLine!.note,
      }],
      date: '2026-08-06',
    });
    expect(confirm.created).toBe(1);

    const created = await prisma.deduction.findFirst({
      where: {
        employeeId: okLine!.employeeId!,
        amount: 123.45,
        notes: 'unit-test',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(created?.type).toBe('personal_checks');
    expect(created?.state).toBe('draft');

    if (created) await prisma.deduction.delete({ where: { id: created.id } });
  });

  it('skips import rows with no punch in period', async () => {
    const { base64 } = await exportDeductionBranchTemplate({ locationId });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('استقطاعات')!;
    const typeLabel = DEDUCTION_TYPES.find((t) => t.value === 'fines')?.label ?? 'غرامات';
    sheet.getCell(4, 4).value = typeLabel;
    sheet.getCell(4, 5).value = 50;
    const filled = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

    const preview = await previewDeductionBranchXlsx({
      base64: filled,
      locationId,
      dateFrom: '2026-01-01',
      dateTo: '2026-01-05',
    });
    expect(preview.countOk).toBe(0);
    expect(preview.skipped.some((s) => s.reason.includes('ملوش بصمة'))).toBe(true);
  });

  it('mass distribute preview/confirm with equal-split and rejects sum drift', async () => {
    const preview = await previewDeductionDistribute({
      locationId,
      dateFrom,
      dateTo,
      deductionType: 'manual_debit',
      totalAmount: 100,
    });
    expect(preview.employeeCount).toBe(1);
    expect(preview.lines[0]!.amount).toBe(100);

    await expect(
      confirmDeductionDistribute({
        locationId,
        dateFrom,
        dateTo,
        deductionType: 'manual_debit',
        totalAmount: 100,
        lines: [{ employeeId, amount: 90, note: 'bad' }],
      }),
    ).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });

    const ok = await confirmDeductionDistribute({
      locationId,
      dateFrom,
      dateTo,
      deductionType: 'manual_debit',
      totalAmount: 100,
      date: '2026-08-20',
      lines: preview.lines.map((l) => ({
        employeeId: l.employeeId,
        amount: l.amount,
        note: l.note,
      })),
    });
    expect(ok.created).toBe(1);
    await prisma.deduction.deleteMany({
      where: { employeeId, type: 'manual_debit', amount: 100 },
    });
  });

  it('recalcDeductionDistribute re-splits remaining employees', async () => {
    const emp2 = await prisma.employeeProfile.create({
      data: {
        name: 'Recalc Peer',
        code: `TRC${Date.now() % 100000}`,
        locationId,
        active: true,
        basicSalary: 2000,
      },
    });
    try {
      const recalc = await recalcDeductionDistribute({
        employeeIds: [employeeId, emp2.id],
        totalAmount: 100,
        note: 'recalc',
      });
      expect(recalc.employeeCount).toBe(2);
      expect(recalc.lines.map((l) => l.amount)).toEqual([50, 50]);

      await expect(
        recalcDeductionDistribute({
          employeeIds: [employeeId, '00000000-0000-0000-0000-000000000000'],
          totalAmount: 100,
        }),
      ).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    } finally {
      await prisma.employeeProfile.delete({ where: { id: emp2.id } }).catch(() => {});
    }
  });
});

describe('deduction multi-branch combined pool', () => {
  let locA = '';
  let locB = '';
  let locC = '';
  let empA = '';
  let empB = '';
  let empC = '';
  let codeA = '';
  let codeB = '';
  let codeC = '';
  const dateFrom = '2026-08-01';
  const dateTo = '2026-08-31';
  const punchIds: string[] = [];

  beforeAll(async () => {
    const stamp = Date.now();
    const a = await prisma.location.create({
      data: { name: `multi-ded-a-${stamp}`, active: true },
    });
    const b = await prisma.location.create({
      data: { name: `multi-ded-b-${stamp}`, active: true },
    });
    const c = await prisma.location.create({
      data: { name: `multi-ded-c-${stamp}`, active: true },
    });
    locA = a.id;
    locB = b.id;
    locC = c.id;
    codeA = `MDA${stamp % 100000}`;
    codeB = `MDB${stamp % 100000}`;
    codeC = `MDC${stamp % 100000}`;
    const ea = await prisma.employeeProfile.create({
      data: {
        name: 'Multi A',
        code: codeA,
        locationId: locA,
        active: true,
        basicSalary: 3000,
        jobTitle: 'كاشير',
      },
    });
    const eb = await prisma.employeeProfile.create({
      data: {
        name: 'Multi B',
        code: codeB,
        locationId: locB,
        active: true,
        basicSalary: 3000,
        jobTitle: 'كاشير',
      },
    });
    const ec = await prisma.employeeProfile.create({
      data: {
        name: 'Multi C Outside',
        code: codeC,
        locationId: locC,
        active: true,
        basicSalary: 3000,
        jobTitle: 'كاشير',
      },
    });
    empA = ea.id;
    empB = eb.id;
    empC = ec.id;
    for (const [employeeId, empCode] of [
      [empA, codeA],
      [empB, codeB],
      [empC, codeC],
    ] as const) {
      const punch = await prisma.transaction.create({
        data: {
          employeeId,
          empCode,
          punchTime: new Date('2026-08-15T10:00:00.000Z'),
          punchState: '0',
          isDuplicate: false,
        },
      });
      punchIds.push(punch.id);
    }
  });

  afterAll(async () => {
    for (const id of punchIds) {
      await prisma.transaction.delete({ where: { id } }).catch(() => {});
    }
    await prisma.deduction.deleteMany({
      where: { employeeId: { in: [empA, empB, empC].filter(Boolean) } },
    }).catch(() => {});
    for (const id of [empA, empB, empC]) {
      if (id) await prisma.employeeProfile.delete({ where: { id } }).catch(() => {});
    }
    for (const id of [locA, locB, locC]) {
      if (id) await prisma.location.delete({ where: { id } }).catch(() => {});
    }
  });

  it('scope unions employees across locationIds', async () => {
    const emps = await employeesForDeductionScope({
      locationIds: [locA, locB],
      dateFrom,
      dateTo,
    });
    const ids = new Set(emps.map((e) => e.id));
    expect(ids.has(empA)).toBe(true);
    expect(ids.has(empB)).toBe(true);
    expect(ids.has(empC)).toBe(false);
    expect(emps).toHaveLength(2);
  });

  it('export includes both branches; filename marks multi', async () => {
    const { count, filename, base64 } = await exportDeductionBranchTemplate({
      locationIds: [locA, locB],
      deductionType: 'fines',
      dateFrom,
      dateTo,
    });
    expect(count).toBe(2);
    expect(filename).toMatch(/_x2_/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('Deductions')!;
    const codes = [String(sheet.getCell(4, 1).value ?? ''), String(sheet.getCell(5, 1).value ?? '')];
    expect(codes).toEqual(expect.arrayContaining([codeA, codeB]));
  });

  it('import accepts selected locations and skips outside branch', async () => {
    const { base64 } = await exportDeductionBranchTemplate({
      locationIds: [locA, locB, locC],
      deductionType: 'fines',
      dateFrom,
      dateTo,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('Deductions')!;
    for (let row = 4; row <= 6; row++) {
      if (sheet.getCell(row, 1).value) sheet.getCell(row, 4).value = 10;
    }
    const filled = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

    const preview = await previewDeductionBranchXlsx({
      base64: filled,
      locationIds: [locA, locB],
      dateFrom,
      dateTo,
      deductionType: 'fines',
    });
    expect(preview.countOk).toBe(2);
    expect(preview.skipped.some((s) => s.reason.includes('ليس على المواقع المحددة نفسها'))).toBe(true);
  });

  it('equal-split across combined multi-branch pool', async () => {
    const preview = await previewDeductionDistribute({
      locationIds: [locA, locB],
      dateFrom,
      dateTo,
      deductionType: 'manual_debit',
      totalAmount: 100,
    });
    expect(preview.employeeCount).toBe(2);
    expect(preview.lines.map((l) => l.amount)).toEqual([50, 50]);
    const sum = preview.lines.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBe(100);

    const recalc = await recalcDeductionDistribute({
      employeeIds: preview.lines.map((l) => l.employeeId),
      totalAmount: 100,
      note: preview.note,
    });
    expect(recalc.employeeCount).toBe(2);
    expect(recalc.lines.map((l) => l.amount)).toEqual([50, 50]);

    const oneLeft = await recalcDeductionDistribute({
      employeeIds: [preview.lines[0]!.employeeId],
      totalAmount: 100,
    });
    expect(oneLeft.lines[0]!.amount).toBe(100);

    const confirmed = await confirmDeductionDistribute({
      locationIds: [locA, locB],
      dateFrom,
      dateTo,
      deductionType: 'manual_debit',
      totalAmount: 100,
      date: '2026-08-20',
      lines: preview.lines.map((l) => ({
        employeeId: l.employeeId,
        amount: l.amount,
        note: l.note,
      })),
    });
    expect(confirmed.created).toBe(2);
    await prisma.deduction.deleteMany({
      where: { employeeId: { in: [empA, empB] }, type: 'manual_debit' },
    });
  });
});
