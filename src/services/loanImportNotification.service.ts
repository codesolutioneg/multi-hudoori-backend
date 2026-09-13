import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import {
  sendLoanImportApprovedEmail,
  type LoanNotificationLine,
} from './mail.service';
import {
  buildOdooLoanAccountsExportWorkbook,
  calculateLoanPaymentAmounts,
  type LoanAccountsExportLine,
} from './odoo/odooLoanAccounts.service';

export type LoanImportNotificationResult = {
  sent: boolean;
  sentBranches: number;
  sentRecipients: string[];
  failures: Array<{ branchName: string; error: string }>;
};

function isFawry(
  employee: {
    hasFawryAccount: boolean;
    fawryAccount: string | null;
  } | null,
): boolean {
  return (
    employee?.hasFawryAccount === true ||
    Boolean(employee?.fawryAccount?.trim())
  );
}

function displayBranchName(
  location:
    | {
        name: string;
        actualName: string | null;
      }
    | null
    | undefined,
): string {
  return (
    location?.actualName?.trim() ||
    location?.name?.trim() ||
    'Unspecified branch'
  );
}

export async function sendLoanImportNotifications(
  importId: string,
): Promise<LoanImportNotificationResult> {
  const batch = await prisma.advanceLoanImport.findUnique({
    where: { id: importId },
    include: {
      device: { select: { name: true } },
      lines: {
        where: {
          approvedAmount: { gt: 0 },
          OR: [
            { shortAdvanceId: { not: null } },
            { compareStatus: 'approved' },
          ],
        },
        include: {
          employee: {
            select: {
              code: true,
              name: true,
              jobTitle: true,
              mobilePhone: true,
              workPhone: true,
              hasFawryAccount: true,
              fawryAccount: true,
              workLocation: {
                select: {
                  id: true,
                  name: true,
                  actualName: true,
                  loanNotificationEmails: true,
                },
              },
            },
          },
        },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!batch) throw new NotFoundError('سجل استيراد السلف غير موجود');
  if (batch.state !== 'locked' || !batch.odooAccountsSendId) {
    throw new AppError(
      'لا يمكن إرسال الإيميل قبل اعتماد السلف وإرسالها إلى Odoo',
      400,
      'ACTION_ERROR',
    );
  }

  const lines: LoanNotificationLine[] = [];
  const workbookLines: LoanAccountsExportLine[] = [];
  const recipients = new Set<string>();
  let primaryBranchName = '';

  for (const line of batch.lines) {
    const location = line.employee?.workLocation;
    const branchName = displayBranchName(location);
    if (!primaryBranchName && branchName !== 'Unspecified branch') {
      primaryBranchName = branchName;
    }
    for (const email of location?.loanNotificationEmails ?? []) {
      const trimmed = email.trim().toLowerCase();
      if (trimmed) recipients.add(trimmed);
    }
    const isFawryPayment = isFawry(line.employee);
    const amounts = calculateLoanPaymentAmounts(
      line.approvedAmount,
      isFawryPayment,
    );
    lines.push({
      employeeCode: line.employeeCode ?? line.employee?.code ?? '',
      employeeName: line.employeeName ?? line.employee?.name ?? '',
      jobTitle: line.employee?.jobTitle ?? '',
      branchName,
      approvedAmount: amounts.approvedAmount,
      fawryCommission: amounts.fawryCommission,
      totalAmount: amounts.totalAmount,
      paymentMethod: isFawryPayment ? 'Fawry' : 'Cash',
    });
    workbookLines.push({
      deviceName: batch.device?.name ?? '',
      employeeCode: line.employeeCode ?? line.employee?.code ?? '',
      employeeName: line.employeeName ?? line.employee?.name ?? '',
      jobTitle: line.employee?.jobTitle ?? '',
      phone: line.employee?.mobilePhone || line.employee?.workPhone || '',
      isFawry: isFawryPayment,
      approvedAmount: amounts.approvedAmount,
    });
  }

  if (!primaryBranchName) primaryBranchName = 'Unspecified branch';

  const failures: Array<{ branchName: string; error: string }> = [];
  if (!lines.length) {
    failures.push({
      branchName: primaryBranchName,
      error: 'لا توجد سطور سلف معتمدة للإرسال',
    });
  } else if (!recipients.size) {
    failures.push({
      branchName: primaryBranchName,
      error: 'لا توجد إيميلات إشعار محفوظة لفروع هذا الكشف',
    });
  }

  let sent = false;
  const sentRecipients: string[] = [];
  if (!failures.length) {
    const filenameToken = `${primaryBranchName}_${batch.reference}`
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_');
    const workbook = await buildOdooLoanAccountsExportWorkbook(workbookLines, {
      filenameStem: filenameToken,
    });
    const result = await sendLoanImportApprovedEmail({
      recipients: [...recipients],
      branchName: primaryBranchName,
      reference: batch.reference,
      date: batch.date.toISOString().slice(0, 10),
      odooReference: batch.odooSendRef ?? String(batch.odooAccountsSendId),
      odooMoveId: batch.odooMoveId,
      lines,
      attachment: {
        filename: workbook.filename,
        base64: workbook.base64,
      },
    });
    if (result.sent) {
      sent = true;
      sentRecipients.push(...result.recipients);
    } else {
      failures.push({
        branchName: primaryBranchName,
        error: result.error ?? 'فشل إرسال البريد',
      });
    }
  }

  const errorText = failures.length
    ? failures
        .map((failure) => `${failure.branchName}: ${failure.error}`)
        .join(' | ')
    : null;
  await prisma.advanceLoanImport.update({
    where: { id: batch.id },
    data: {
      notificationEmailsSentAt: sent ? new Date() : null,
      notificationEmailError: errorText,
      notificationEmailRecipients: sentRecipients,
    },
  });

  return {
    sent,
    sentBranches: sent ? 1 : 0,
    sentRecipients,
    failures,
  };
}
