import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.hoisted(() => vi.fn());

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail }),
  },
}));

import { sendLoanImportApprovedEmail } from '../../src/services/mail.service';

describe('loan import notification email', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue({});
  });

  it('sends an English summary and attaches the branch Cash/Fawry workbook', async () => {
    const result = await sendLoanImportApprovedEmail({
      recipients: ['finance@example.com'],
      branchName: 'Sizzler',
      reference: 'LOAN/2026/00025',
      date: '2026-08-17',
      odooReference: 'New',
      odooMoveId: 123,
      lines: [
        {
          employeeCode: 'C1',
          employeeName: 'Cash Employee',
          jobTitle: 'Chef',
          paymentMethod: 'Cash',
          approvedAmount: 1000,
          fawryCommission: 0,
          totalAmount: 1000,
        },
        {
          employeeCode: 'F1',
          employeeName: 'Fawry Employee',
          jobTitle: 'Steward',
          paymentMethod: 'Fawry',
          approvedAmount: 2000,
          fawryCommission: 3,
          totalAmount: 2003,
        },
      ],
      attachment: {
        filename: 'sizzler_cash_fawry.xlsx',
        base64: Buffer.from('test workbook').toString('base64'),
      },
    });

    expect(result.sent).toBe(true);
    expect(sendMail).toHaveBeenCalledOnce();
    const message = sendMail.mock.calls[0][0];
    expect(message.subject).toContain('Approved advances sent to Odoo');
    expect(message.html).toContain('Cash: <strong>1000.00</strong>');
    expect(message.html).toContain('Fawry: <strong>2000.00</strong>');
    expect(message.html).toContain('Fawry commission: <strong>3.00</strong>');
    expect(message.html).toContain('Total sent to Odoo: 3003.00');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].filename).toBe('sizzler_cash_fawry.xlsx');
  });
});
