import { describe, expect, it } from 'vitest';
import { summarizeLoanImportBatch } from '../../src/services/advanceLoanImport.service';
import { accountsExportLocationToken } from '../../src/services/odoo/odooLoanAccounts.service';

function line(partial: {
  locationId?: string;
  locationName?: string;
  approvedAmount?: number;
  requestedAmount?: number;
  toApprove?: boolean;
  isFawry?: boolean;
  name?: string;
  code?: string;
}) {
  return {
    requestedAmount: partial.requestedAmount ?? partial.approvedAmount ?? 0,
    approvedAmount: partial.approvedAmount ?? 0,
    toApprove: partial.toApprove ?? true,
    isFawry: partial.isFawry ?? false,
    shortAdvanceId: null,
    compareStatus: 'approved',
    employeeCode: partial.code ?? '1',
    employeeName: partial.name ?? 'Emp',
    note: null,
    rowReason: null,
    repaymentMonths: 1,
    employee: {
      code: partial.code ?? '1',
      name: partial.name ?? 'Emp',
      jobTitle: 'Waiter',
              hasFawryAccount: false,
              fawryAccount: null,
      workLocation: {
        id: partial.locationId ?? 'loc-a',
        name: partial.locationName ?? 'Bri.Str',
        actualName: partial.locationName ?? 'Bri.Str',
      },
    },
  };
}

describe('summarizeLoanImportBatch', () => {
  it('picks the primary branch, cash/fawry totals with commission, and outsider lines', () => {
    const summary = summarizeLoanImportBatch([
      line({ locationId: 'a', locationName: 'Bri.Str', approvedAmount: 1000, isFawry: false }),
      line({ locationId: 'a', locationName: 'Bri.Str', approvedAmount: 500, isFawry: true, name: 'Fawry Emp', code: '2' }),
      line({ locationId: 'b', locationName: 'Balkans', approvedAmount: 200, isFawry: false, name: 'Other', code: '3' }),
    ]);
    expect(summary.primaryLocationName).toBe('Bri.Str');
    expect(summary.outsiderCount).toBe(1);
    expect(summary.locationCount).toBe(2);
    expect(summary.mixedLocations).toBe(true);
    expect(summary.outsiderLines[0]?.employeeCode).toBe('3');
    expect(summary.cashAmount).toBe(1200);
    expect(summary.fawryApprovedAmount).toBe(500);
    expect(summary.fawryCommissionAmount).toBe(0.75);
    expect(summary.fawryAmount).toBe(500.75);
    expect(summary.totalAmount).toBe(1700.75);
  });

  it('keeps Cash/Fawry from the stored line flag even if the employee is cash now', () => {
    const summary = summarizeLoanImportBatch([
      {
        ...line({ approvedAmount: 1000, isFawry: true }),
        employee: {
          ...line({ isFawry: true }).employee,
          hasFawryAccount: false,
          fawryAccount: null,
        },
      },
    ]);
    expect(summary.cashAmount).toBe(0);
    expect(summary.fawryApprovedAmount).toBe(1000);
    expect(summary.fawryCommissionAmount).toBe(1.5);
    expect(summary.fawryAmount).toBe(1001.5);
  });

  it('excludes cancelled short advances from cash/fawry totals', () => {
    const summary = summarizeLoanImportBatch([
      {
        ...line({ approvedAmount: 1000, isFawry: false, code: '5476' }),
        shortAdvanceId: 'adv-1',
        shortAdvance: { state: 'cancelled' },
      },
      {
        ...line({ approvedAmount: 500, isFawry: true, code: '2' }),
        shortAdvanceId: 'adv-2',
        shortAdvance: { state: 'pending' },
      },
    ]);
    expect(summary.cashAmount).toBe(0);
    expect(summary.fawryApprovedAmount).toBe(500);
    expect(summary.fawryCommissionAmount).toBe(0.75);
    expect(summary.fawryAmount).toBe(500.75);
    expect(summary.totalAmount).toBe(500.75);
  });
});

describe('accountsExportLocationToken', () => {
  it('uses multiple when more than one branch is on the sheet', () => {
    expect(
      accountsExportLocationToken([
        'Sizzler Strip Mall',
        'Sizzler Strip Mall',
        'Balkans',
      ]),
    ).toBe('multiple');
  });

  it('keeps the single branch name when every row is the same location', () => {
    expect(
      accountsExportLocationToken(['Sizzler Strip Mall', 'Sizzler Strip Mall']),
    ).toBe('Sizzler_Strip_Mall');
  });
});
