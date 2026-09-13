import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  buildOdooLoanAccountsExportWorkbook,
  parseOdooLoanReviewExcel,
} from '../../src/services/odoo/odooLoanAccounts.service';

describe('Odoo loan accounts workbook', () => {
  it('adds 0.15% Fawry commission and sends the post-commission total', async () => {
    const exported = await buildOdooLoanAccountsExportWorkbook([
      {
        deviceName: 'Device',
        employeeCode: 'F1',
        employeeName: 'Fawry Employee',
        jobTitle: 'Chef',
        phone: '01000000000',
        isFawry: true,
        approvedAmount: 1750,
      },
      {
        deviceName: 'Device',
        employeeCode: 'C1',
        employeeName: 'Cash Employee',
        jobTitle: 'Steward',
        phone: '01000000001',
        isFawry: false,
        approvedAmount: 500,
      },
    ]);

    expect(exported.fawryAmount).toBe(1752.63);
    expect(exported.cashAmount).toBe(500);
    expect(exported.cashApprovedAmount).toBe(500);
    expect(exported.fawryApprovedAmount).toBe(1750);
    expect(exported.fawryCommissionAmount).toBe(2.63);
    expect(exported.totalAmount).toBe(2252.63);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(exported.base64, 'base64') as unknown as ExcelJS.Buffer,
    );
    const fawry = workbook.getWorksheet('فوري')!;
    expect(fawry.getRow(1).values).toEqual([
      undefined,
      'جهاز البصمة',
      'كود الموظف',
      'اسم الموظف',
      'وظيفة الموظف',
      'رقم التليفون',
      'فوري',
      'المبلغ المعتمد',
      'عمولة فوري',
      'الإجمالي',
    ]);
    expect(fawry.getCell(2, 7).value).toBe(1750);
    expect(fawry.getCell(2, 8).value).toBe(2.63);
    expect(fawry.getCell(2, 9).value).toBe(1752.63);

    const parsed = await parseOdooLoanReviewExcel(exported.base64);
    expect(parsed.fawryAmount).toBe(1752.63);
    expect(parsed.cashAmount).toBe(500);
    expect(parsed.fawryApprovedAmount).toBe(1750);
    expect(parsed.fawryCommissionAmount).toBe(2.63);
    expect(parsed.totalAmount).toBe(2252.63);
  });
});
