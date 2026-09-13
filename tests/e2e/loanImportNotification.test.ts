import ExcelJS from 'exceljs';
import { AdvanceLoanImportState } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/prisma/client';
import { resetDatabase } from '../helpers/db';

const sendEmail = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/mail.service', () => ({
  sendLoanImportApprovedEmail: sendEmail,
}));

import { sendLoanImportNotifications } from '../../src/services/loanImportNotification.service';

describe('loan import branch notification attachments', () => {
  beforeEach(async () => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({
      sent: true,
      recipients: ['one@example.com', 'two@example.com'],
    });
    await resetDatabase();
  });

  it('sends one email for the whole import using the primary branch name', async () => {
    const firstLocation = await prisma.location.create({
      data: {
        name: 'Branch One',
        actualName: 'Actual One',
        code: 'EMAIL-B1',
        loanNotificationEmails: ['one@example.com'],
      },
    });
    const secondLocation = await prisma.location.create({
      data: {
        name: 'Branch Two',
        actualName: 'Actual Two',
        code: 'EMAIL-B2',
        loanNotificationEmails: ['two@example.com'],
      },
    });
    const firstEmployee = await prisma.employeeProfile.create({
      data: {
        name: 'Employee One',
        code: 'E1',
        locationId: firstLocation.id,
        active: true,
      },
    });
    const secondEmployee = await prisma.employeeProfile.create({
      data: {
        name: 'Employee Two',
        code: 'E2',
        locationId: secondLocation.id,
        active: true,
        hasFawryAccount: true,
      },
    });
    const batch = await prisma.advanceLoanImport.create({
      data: {
        reference: 'LOAN/2026/EMAIL',
        date: new Date('2026-08-17T00:00:00.000Z'),
        state: AdvanceLoanImportState.locked,
        odooAccountsSendId: 75,
        odooMoveId: 123,
        lines: {
          create: [
            {
              employeeId: firstEmployee.id,
              employeeCode: firstEmployee.code,
              employeeName: firstEmployee.name,
              approvedAmount: 1000,
              compareStatus: 'approved',
            },
            {
              employeeId: secondEmployee.id,
              employeeCode: secondEmployee.code,
              employeeName: secondEmployee.name,
              approvedAmount: 2000,
              compareStatus: 'approved',
            },
          ],
        },
      },
    });

    const result = await sendLoanImportNotifications(batch.id);
    expect(result.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const params = sendEmail.mock.calls[0][0];
    expect(params.branchName).toBe('Actual One');
    expect(params.recipients.sort()).toEqual([
      'one@example.com',
      'two@example.com',
    ]);
    expect(params.lines).toHaveLength(2);
    expect(params.attachment?.base64).toBeTruthy();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(
        params.attachment.base64,
        'base64',
      ) as unknown as ExcelJS.Buffer,
    );
    const workbookText = workbook.worksheets
      .flatMap((sheet) =>
        sheet
          .getSheetValues()
          .flatMap((row) => (Array.isArray(row) ? row.map(String) : [])),
      )
      .join(' ');
    expect(workbookText).toContain('Employee One');
    expect(workbookText).toContain('Employee Two');
  });
});
