import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { AdvanceLoanImportState, UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { createLocation, createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';

async function loanWorkbookBase64(rows: Array<{ code: string; name: string; amount: number }>): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('استيراد سلف');
  sheet.getRow(1).values = ['', 'employee_code', 'employee_name', 'amount'];
  rows.forEach((row, i) => {
    sheet.getRow(i + 2).values = ['', row.code, row.name, row.amount];
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

describe('advance loan import merge + branch template filter', () => {
  let hr: SeededUser;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hr = await createUser({ login: 'hr-loan@test.local', role: UserRole.HR_MANAGER });
  });

  it('merges a loan sheet by employee code without dropping review edits or absent rows', async () => {
    const location = await createLocation({
      name: 'Factory Branch',
      code: 'FACTORY-BR',
    });
    const baker = await prisma.employeeProfile.create({
      data: {
        name: 'Baker One',
        code: 'A1',
        jobTitle: 'شيف خباز',
        locationId: location.id,
        basicSalary: 4000,
        active: true,
      },
    });
    const steward = await prisma.employeeProfile.create({
      data: { name: 'Steward One', code: 'B1', jobTitle: 'استيوارد', basicSalary: 3000, active: true },
    });
    await prisma.employeeProfile.create({
      data: { name: 'New Hire', code: 'C1', jobTitle: 'مساعد', basicSalary: 2500, active: true },
    });

    const created = expectOk(
      await rpc('/api/biotime/advances/loan-import/create', { date: '2026-08-17' }, hr.token),
    );
    const importId = String((created.import as { id: string }).id);

    const firstFile = await loanWorkbookBase64([
      { code: baker.code!, name: baker.name, amount: 1000 },
      { code: steward.code!, name: steward.name, amount: 2000 },
    ]);
    expectOk(
      await rpc(
        '/api/biotime/advances/loan-import/preview',
        { importId, base64: firstFile },
        hr.token,
      ),
    );

    const afterPreview = expectOk(
      await rpc('/api/biotime/advances/loan-import/get', { importId }, hr.token),
    );
    const previewLines = (afterPreview.import as { lines: Array<Record<string, unknown>> }).lines;
    expect(previewLines).toHaveLength(2);
    const bakerLine = previewLines.find((l) => l.employeeCode === 'A1');
    expect(bakerLine?.jobTitle).toBe('شيف خباز');
    expect(bakerLine?.locationName).toBe('Factory Branch');

    expectOk(
      await rpc(
        '/api/biotime/advances/loan-import/lines/update',
        { lineId: bakerLine!.id, approvedAmount: 900, toApprove: true },
        hr.token,
      ),
    );

    const mergeFile = await loanWorkbookBase64([
      { code: 'A1', name: baker.name, amount: 500 },
      { code: 'C1', name: 'New Hire', amount: 300 },
    ]);
    const merged = expectOk(
      await rpc(
        '/api/biotime/advances/loan-import/merge-loan',
        { importId, base64: mergeFile },
        hr.token,
      ),
    );
    expect((merged.merge as { updated: number; added: number; unchanged: number }).updated).toBe(1);
    expect((merged.merge as { added: number }).added).toBe(1);
    expect((merged.merge as { unchanged: number }).unchanged).toBe(1);

    const afterMerge = expectOk(
      await rpc('/api/biotime/advances/loan-import/get', { importId }, hr.token),
    );
    const lines = (afterMerge.import as { lines: Array<Record<string, unknown>> }).lines;
    expect(lines).toHaveLength(3);

    const a = lines.find((l) => l.employeeCode === 'A1')!;
    expect(a.requestedAmount).toBe(500);
    expect(a.approvedAmount).toBe(500);
    expect(a.toApprove).toBe(true);
    expect(a.jobTitle).toBe('شيف خباز');

    const b = lines.find((l) => l.employeeCode === 'B1')!;
    expect(b.requestedAmount).toBe(2000);
    expect(b.jobTitle).toBe('استيوارد');

    const c = lines.find((l) => l.employeeCode === 'C1')!;
    expect(c.requestedAmount).toBe(300);
    expect(c.jobTitle).toBe('مساعد');

    await prisma.advanceLoanImport.update({
      where: { id: importId },
      data: {
        state: AdvanceLoanImportState.locked,
        odooAccountsSendId: 91,
        odooMoveId: 92,
        odooSendRef: 'LOAN-ODOO-91',
      },
    });
    const locked = expectOk(
      await rpc(
        '/api/biotime/advances/loan-import/list',
        { state: 'locked' },
        hr.token,
      ),
    );
    const lockedItems = locked.items as Array<Record<string, unknown>>;
    expect(lockedItems).toHaveLength(1);
    expect(lockedItems[0].id).toBe(importId);
    expect(lockedItems[0].state).toBe('locked');
    expect(lockedItems[0].odooAccountsSendId).toBe(91);

    const reopened = expectOk(
      await rpc('/api/biotime/advances/loan-import/get', { importId }, hr.token),
    );
    expect((reopened.import as Record<string, unknown>).odooSendRef).toBe(
      'LOAN-ODOO-91',
    );
  });

  it('adds an employee manually from any branch and returns branch + job', async () => {
    const location = await createLocation({
      name: 'Marassi Branch',
      code: 'MARASSI-BR',
    });
    const employee = await prisma.employeeProfile.create({
      data: {
        name: 'Cross Branch Employee',
        code: 'CB1',
        jobTitle: 'كاشير',
        locationId: location.id,
        basicSalary: 3000,
        active: true,
      },
    });
    const created = expectOk(
      await rpc(
        '/api/biotime/advances/loan-import/create',
        { date: '2026-08-17' },
        hr.token,
      ),
    );
    const importId = String((created.import as { id: string }).id);
    expectOk(
      await rpc(
        '/api/biotime/advances/loan-import/lines/add-manual',
        { importId, employeeId: employee.id, requestedAmount: 750 },
        hr.token,
      ),
    );
    const batch = expectOk(
      await rpc('/api/biotime/advances/loan-import/get', { importId }, hr.token),
    );
    const lines = (batch.import as {
      lines: Array<Record<string, unknown>>;
    }).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].employeeCode).toBe('CB1');
    expect(lines[0].jobTitle).toBe('كاشير');
    expect(lines[0].locationName).toBe('Marassi Branch');
    expect(lines[0].requestedAmount).toBe(750);
  });

  it('rejects merge after the import is locked', async () => {
    await prisma.employeeProfile.create({
      data: { name: 'Locked Emp', code: 'L1', basicSalary: 2000, active: true },
    });
    const created = expectOk(
      await rpc('/api/biotime/advances/loan-import/create', { date: '2026-08-17' }, hr.token),
    );
    const importId = String((created.import as { id: string }).id);
    const file = await loanWorkbookBase64([{ code: 'L1', name: 'Locked Emp', amount: 100 }]);
    expectOk(
      await rpc('/api/biotime/advances/loan-import/preview', { importId, base64: file }, hr.token),
    );
    await prisma.advanceLoanImport.update({
      where: { id: importId },
      data: { state: AdvanceLoanImportState.locked },
    });
    expectFail(
      await rpc('/api/biotime/advances/loan-import/merge-loan', { importId, base64: file }, hr.token),
      'ACTION_ERROR',
    );
  });

  it('exports a blank multiple.xlsx template that can be filled and imported', async () => {
    const location = await createLocation({ name: 'Mixed', code: 'MIX-1' });
    await prisma.employeeProfile.create({
      data: {
        name: 'Fill Emp',
        code: 'M200',
        jobTitle: 'كاشير',
        locationId: location.id,
        active: true,
        basicSalary: 3000,
      },
    });
    const data = expectOk(
      await rpc('/api/biotime/advances/export/import-template', { blank: true }, hr.token),
    );
    expect(data.filename).toBe('multiple.xlsx');
    expect(data.locationName ?? data.count).toBeDefined();

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(String(data.base64), 'base64') as unknown as ExcelJS.Buffer);
    const sheet = wb.getWorksheet('استيراد سلف');
    expect(sheet).toBeTruthy();
    expect(sheet!.getRow(2).getCell(1).value).toBeFalsy();
    sheet!.getRow(2).getCell(1).value = 'M200';
    sheet!.getRow(2).getCell(2).value = 'Fill Emp';
    sheet!.getRow(2).getCell(6).value = 750;
    const filled = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

    const created = expectOk(
      await rpc('/api/biotime/advances/loan-import/create', { date: '2026-08-19' }, hr.token),
    );
    const importId = String((created.import as { id: string }).id);
    expectOk(
      await rpc(
        '/api/biotime/advances/loan-import/preview',
        { importId, base64: filled },
        hr.token,
      ),
    );
    const after = expectOk(await rpc('/api/biotime/advances/loan-import/get', { importId }, hr.token));
    const lines = (after.import as { lines: Array<Record<string, unknown>> }).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].employeeCode).toBe('M200');
    expect(Number(lines[0].requestedAmount)).toBe(750);
  });

  it('enables AutoFilter and sort on the protected branch loan template', async () => {
    const location = await createLocation({ name: 'Factory', code: 'FAC-1' });
    await prisma.employeeProfile.create({
      data: {
        name: 'Branch Emp',
        code: 'F100',
        jobTitle: 'شيف',
        locationId: location.id,
        active: true,
        basicSalary: 3000,
      },
    });
    const data = expectOk(
      await rpc('/api/biotime/advances/export/import-template', { locationId: location.id }, hr.token),
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(String(data.base64), 'base64') as unknown as ExcelJS.Buffer);
    const sheet = wb.getWorksheet('استيراد سلف');
    expect(sheet).toBeTruthy();
    expect(sheet!.autoFilter).toBeTruthy();
    const filter = sheet!.autoFilter as { from?: { row: number; column: number }; to?: { row: number; column: number } } | string;
    if (typeof filter === 'string') {
      expect(filter.toLowerCase()).toContain('a1');
    } else {
      expect(filter.from?.row ?? 1).toBe(1);
      expect(filter.to?.column).toBe(6);
    }
  });
});
