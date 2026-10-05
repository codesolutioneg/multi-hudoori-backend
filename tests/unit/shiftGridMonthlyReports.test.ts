import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  exportMonthlyReportsTemplate,
  importMonthlyReports,
} from '../../src/services/shiftGridMonthlyReports.service';
import { prisma } from '../../src/prisma/client';
import { createShift, createLocation, withDefaultTenant } from '../helpers/db';

describe('shiftGridMonthlyReports template', () => {
  it('builds a 5-column template with date and shift dropdowns', async () => {
    const file = await withDefaultTenant(async () =>
      exportMonthlyReportsTemplate({
        dateFrom: '2026-08-26',
        dateTo: '2026-09-25',
      }),
    );
    expect(file.filename).toContain('2026-08-26');
    expect(file.filename).toContain('2026-09-25');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(file.base64, 'base64') as unknown as ExcelJS.Buffer);
    const sheet = wb.getWorksheet('التقارير الشهرية');
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell(1, 1).value).toBe('كود');
    expect(sheet!.getCell(1, 2).value).toBe('اسم');
    expect(sheet!.getCell(1, 3).value).toBe('تاريخ');
    expect(sheet!.getCell(1, 4).value).toBe('تغير شفتات');
    expect(sheet!.getCell(1, 5).value).toBe('إضافي');
    expect(sheet!.getCell(1, 6).value).toBeNull();

    const lists = wb.getWorksheet('قوائم');
    expect(lists).toBeTruthy();
    expect(lists!.getCell(2, 1).value).toBe('2026-08-26');
    expect(lists!.getCell(32, 1).value).toBe('2026-09-25');
    // Same order as shift-grid dropdown: statuses first, then shifts
    expect(lists!.getCell(2, 2).value).toBe('إجازة (off)');
    expect(lists!.getCell(3, 2).value).toBe('حاضر');

    // Dropdowns without Excel error/input popup banners
    const dvs = (
      sheet as ExcelJS.Worksheet & {
        dataValidations?: { model?: Record<string, { showErrorMessage?: boolean; showInputMessage?: boolean; errorTitle?: string }> };
      }
    ).dataValidations?.model;
    if (dvs) {
      for (const v of Object.values(dvs)) {
        expect(v.showErrorMessage).toBeFalsy();
        expect(v.errorTitle).toBeFalsy();
      }
    }
  });
});

describe('shiftGridMonthlyReports import (db)', () => {
  it('updates shift and manual OT on every merged grid that has emp+date', async () => {
    const stamp = Date.now().toString(36);
    const loc = await createLocation({ name: `MR-LOC-${stamp}`, code: `MR${stamp.slice(-4)}` });
    const shiftA = await createShift({ name: `MR.A.${stamp}` });
    const shiftB = await createShift({ name: `MR.B.${stamp}` });
    const emp = await prisma.employeeProfile.create({
      data: {
        name: `موظف تقارير ${stamp}`,
        code: `MR${stamp.slice(-5)}`,
        locationId: loc.id,
        location: loc.name,
        active: true,
        basicSalary: 1000,
      },
    });
    const day = new Date('2026-09-10T00:00:00.000Z');
    const from = new Date('2026-08-26T00:00:00.000Z');
    const to = new Date('2026-09-25T00:00:00.000Z');

    const grid1 = await prisma.shiftGrid.create({
      data: {
        name: `دمج MR1 ${stamp}`,
        dateFrom: from,
        dateTo: to,
        locationId: loc.id,
        selectionMethod: 'location',
        state: 'confirmed',
        employeeIds: [emp.id],
        mergedFromGridIds: [`src-a-${stamp}`],
        mergedAt: new Date(),
      },
    });
    const grid2 = await prisma.shiftGrid.create({
      data: {
        name: `دمج MR2 ${stamp}`,
        dateFrom: from,
        dateTo: to,
        locationId: loc.id,
        selectionMethod: 'location',
        state: 'grid',
        employeeIds: [emp.id],
        mergedFromGridIds: [`src-b-${stamp}`],
        mergedAt: new Date(),
      },
    });
    await prisma.shiftGridLine.createMany({
      data: [
        { gridId: grid1.id, employeeId: emp.id, date: day, shiftId: shiftA.id },
        { gridId: grid2.id, employeeId: emp.id, date: day, shiftId: shiftA.id },
      ],
    });

    const tpl = await exportMonthlyReportsTemplate({
      dateFrom: '2026-08-26',
      dateTo: '2026-09-25',
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(tpl.base64, 'base64') as unknown as ExcelJS.Buffer);
    const sheet = wb.getWorksheet('التقارير الشهرية')!;
    sheet.getCell(2, 1).value = emp.code;
    sheet.getCell(2, 2).value = emp.name;
    sheet.getCell(2, 3).value = '2026-09-10';
    sheet.getCell(2, 4).value = shiftB.name;
    sheet.getCell(2, 5).value = 'نعم';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const result = await importMonthlyReports({
      base64: buf.toString('base64'),
      dateFrom: '2026-08-26',
      dateTo: '2026-09-25',
    });

    expect(result.applied).toBe(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.shiftUpdates).toBe(2);
    expect(result.overtimeAdded).toBe(2);

    const lines = await prisma.shiftGridLine.findMany({
      where: { employeeId: emp.id, date: day },
      select: { gridId: true, shiftId: true },
    });
    expect(lines.every((l) => l.shiftId === shiftB.id)).toBe(true);

    const ot = await prisma.shiftGridManualOtLine.findMany({
      where: { employeeId: emp.id, date: day },
    });
    expect(ot).toHaveLength(2);

    await prisma.shiftGridManualOtLine.deleteMany({ where: { employeeId: emp.id } });
    await prisma.shiftGridLine.deleteMany({ where: { employeeId: emp.id } });
    await prisma.shiftGrid.deleteMany({ where: { id: { in: [grid1.id, grid2.id] } } });
    await prisma.employeeProfile.delete({ where: { id: emp.id } });
    await prisma.shift.deleteMany({ where: { id: { in: [shiftA.id, shiftB.id] } } });
    await prisma.location.delete({ where: { id: loc.id } });
  });

  it('rejects when emp+date is missing on merged grids', async () => {
    const stamp = Date.now().toString(36);
    const emp = await prisma.employeeProfile.create({
      data: {
        name: `موظف رافض ${stamp}`,
        code: `RJ${stamp.slice(-5)}`,
        active: true,
        basicSalary: 500,
      },
    });
    const tpl = await exportMonthlyReportsTemplate({
      dateFrom: '2026-08-26',
      dateTo: '2026-09-25',
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(tpl.base64, 'base64') as unknown as ExcelJS.Buffer);
    const sheet = wb.getWorksheet('التقارير الشهرية')!;
    sheet.getCell(2, 1).value = emp.code;
    sheet.getCell(2, 3).value = '2026-09-01';
    sheet.getCell(2, 5).value = 'نعم';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const result = await importMonthlyReports({
      base64: buf.toString('base64'),
      dateFrom: '2026-08-26',
      dateTo: '2026-09-25',
    });
    expect(result.applied).toBe(0);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]!.reason).toMatch(/مدموج|التاريخ/);
    expect(result.failuresFile?.base64).toBeTruthy();

    await prisma.employeeProfile.delete({ where: { id: emp.id } });
  });
});
