/**
 * Transactional email via Code Solution SMTP (mail.code-solution.org).
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { UserRole } from '@prisma/client';
import { config } from '../config';
import { logger } from '../utils/logger';

let transporter: Transporter | null = null;

const ROLE_LABELS_AR: Record<string, string> = {
  EMPLOYEE: 'موظف',
  HR_USER: 'مستخدم موارد بشرية',
  HR_SUPERVISOR: 'مشرف موارد بشرية',
  HR_MANAGER: 'مدير موارد بشرية',
  BRANCH_MANAGER: 'مدير فرع',
  DEVICE_MANAGER: 'مدير أجهزة',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getTransporter(): Transporter | null {
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
      // Same approach as Dishflow POS mail: some mail.code-solution.org
      // certs fail Node's default CA check and hang/fail without this.
      tls: {
        rejectUnauthorized: false,
      },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return transporter;
}

function roleLabelAr(role: UserRole | string): string {
  return ROLE_LABELS_AR[String(role)] ?? String(role);
}

function buildWelcomeHtml(params: {
  name: string;
  login: string;
  password: string;
  role: string;
  siteUrl: string;
}): string {
  const name = escapeHtml(params.name);
  const login = escapeHtml(params.login);
  const password = escapeHtml(params.password);
  const role = escapeHtml(params.role);
  const siteUrl = escapeHtml(params.siteUrl);

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>حساب حضوري</title>
</head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Tahoma,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F1F5F9;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#4F46E5,#6366F1);padding:28px 32px;text-align:center;">
              <div style="font-size:26px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">حضوري</div>
              <div style="margin-top:8px;font-size:14px;color:#E0E7FF;">نظام الحضور والرواتب</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px 8px;color:#0F172A;text-align:right;">
              <h1 style="margin:0 0 12px;font-size:22px;line-height:1.4;">مرحباً ${name}</h1>
              <p style="margin:0 0 18px;font-size:15px;line-height:1.8;color:#334155;">
                تم إنشاء حسابك في منصة <strong>حضوري</strong> بنجاح.
                يمكنك تسجيل الدخول باستخدام البيانات أدناه.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 8px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;">
                <tr>
                  <td style="padding:18px 20px;text-align:right;color:#0F172A;">
                    <div style="font-size:12px;color:#64748B;margin-bottom:4px;">الاسم</div>
                    <div style="font-size:15px;font-weight:700;margin-bottom:14px;">${name}</div>
                    <div style="font-size:12px;color:#64748B;margin-bottom:4px;">الدور</div>
                    <div style="font-size:15px;font-weight:700;margin-bottom:14px;">${role}</div>
                    <div style="font-size:12px;color:#64748B;margin-bottom:4px;">اسم المستخدم / البريد</div>
                    <div style="font-size:15px;font-weight:700;margin-bottom:14px;direction:ltr;text-align:right;">${login}</div>
                    <div style="font-size:12px;color:#64748B;margin-bottom:4px;">كلمة المرور</div>
                    <div style="font-size:16px;font-weight:800;letter-spacing:0.5px;direction:ltr;text-align:right;color:#4F46E5;">${password}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px;text-align:center;">
              <a href="${siteUrl}" style="display:inline-block;background:#4F46E5;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;">
                فتح منصة حضوري
              </a>
              <div style="margin-top:14px;font-size:12px;color:#94A3B8;direction:ltr;">${siteUrl}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;text-align:right;">
              <p style="margin:0;font-size:13px;line-height:1.7;color:#64748B;">
                لأمان حسابك، يُفضّل تغيير كلمة المرور بعد أول دخول.
                إذا لم تطلب هذا الحساب، تجاهل هذه الرسالة أو تواصل مع الإدارة.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#0F172A;padding:16px 24px;text-align:center;color:#94A3B8;font-size:12px;">
              © ${new Date().getFullYear()} Hudoori · Code Solution
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildWelcomeText(params: {
  name: string;
  login: string;
  password: string;
  role: string;
  siteUrl: string;
}): string {
  return [
    `مرحباً ${params.name}`,
    '',
    'تم إنشاء حسابك في منصة حضوري.',
    `الدور: ${params.role}`,
    `اسم المستخدم: ${params.login}`,
    `كلمة المرور: ${params.password}`,
    `رابط المنصة: ${params.siteUrl}`,
    '',
    'يُفضّل تغيير كلمة المرور بعد أول دخول.',
  ].join('\n');
}

function resolveRecipient(login: string, email?: string | null): string | null {
  const candidate = (email || login || '').trim();
  if (!candidate.includes('@')) return null;
  return candidate;
}

export async function sendUserCredentialsEmail(params: {
  name: string;
  login: string;
  email?: string | null;
  password: string;
  role: UserRole | string;
  kind?: 'welcome' | 'reset';
}): Promise<{ sent: boolean; to?: string; error?: string }> {
  const to = resolveRecipient(params.login, params.email);
  if (!to) {
    return { sent: false, error: 'NO_EMAIL' };
  }

  const transport = getTransporter();
  if (!transport) {
    logger.warn({ to }, 'SMTP not configured — credentials email skipped');
    return { sent: false, error: 'SMTP_NOT_CONFIGURED', to };
  }

  const siteUrl = config.appPublicUrl;
  const role = roleLabelAr(params.role);
  const kind = params.kind ?? 'welcome';
  const subject =
    kind === 'reset'
      ? 'حضوري — تم إعادة تعيين كلمة المرور'
      : 'حضوري — بيانات الدخول إلى حسابك';

  const html = buildWelcomeHtml({
    name: params.name,
    login: params.login,
    password: params.password,
    role,
    siteUrl,
  });
  const text = buildWelcomeText({
    name: params.name,
    login: params.login,
    password: params.password,
    role,
    siteUrl,
  });

  try {
    await transport.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
      to,
      subject,
      text,
      html,
    });
    logger.info({ to, kind }, 'Credentials email sent');
    return { sent: true, to };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, to }, 'Failed to send credentials email');
    return { sent: false, to, error: message };
  }
}

export async function sendPasswordResetLinkEmail(params: {
  name: string;
  login: string;
  email?: string | null;
  resetUrl: string;
}): Promise<{ sent: boolean; to?: string; error?: string }> {
  const to = resolveRecipient(params.login, params.email);
  if (!to) {
    return { sent: false, error: 'NO_EMAIL' };
  }

  const transport = getTransporter();
  if (!transport) {
    logger.warn({ to }, 'SMTP not configured — reset email skipped');
    return { sent: false, error: 'SMTP_NOT_CONFIGURED', to };
  }

  const name = escapeHtml(params.name);
  const login = escapeHtml(params.login);
  const resetUrl = escapeHtml(params.resetUrl);
  const subject = 'حضوري — رابط إعادة تعيين كلمة المرور';
  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Tahoma,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F1F5F9;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(135deg,#4F46E5,#6366F1);padding:28px 32px;text-align:center;color:#fff;">
            <div style="font-size:26px;font-weight:700;">حضوري</div>
            <div style="margin-top:8px;font-size:14px;color:#E0E7FF;">إعادة تعيين كلمة المرور</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 28px;color:#0F172A;text-align:right;">
            <h1 style="margin:0 0 12px;font-size:20px;">مرحباً ${name}</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.8;color:#334155;">
              وصلك هذا الرابط لإعادة تعيين كلمة مرور حساب <strong style="direction:ltr;">${login}</strong>.
              الرابط صالح لمدة ساعة واحدة.
            </p>
            <p style="text-align:center;margin:24px 0;">
              <a href="${resetUrl}" style="display:inline-block;background:#4F46E5;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;">
                تعيين كلمة مرور جديدة
              </a>
            </p>
            <p style="margin:0;font-size:12px;color:#94A3B8;direction:ltr;text-align:right;word-break:break-all;">${resetUrl}</p>
            <p style="margin:16px 0 0;font-size:13px;color:#64748B;">إذا لم تطلب إعادة التعيين، تجاهل هذه الرسالة.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  const text = [
    `مرحباً ${params.name}`,
    '',
    'لإعادة تعيين كلمة المرور افتح الرابط التالي (صالح لمدة ساعة):',
    params.resetUrl,
    '',
    'إذا لم تطلب ذلك، تجاهل الرسالة.',
  ].join('\n');

  try {
    await transport.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
      to,
      subject,
      text,
      html,
    });
    logger.info({ to }, 'Password reset link email sent');
    return { sent: true, to };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, to }, 'Failed to send password reset email');
    return { sent: false, to, error: message };
  }
}

export type LoanNotificationLine = {
  employeeCode: string;
  employeeName: string;
  jobTitle: string;
  branchName?: string;
  approvedAmount: number;
  fawryCommission: number;
  totalAmount: number;
  paymentMethod: 'Cash' | 'Fawry';
};

export async function sendLoanImportApprovedEmail(params: {
  recipients: string[];
  branchName: string;
  reference: string;
  date: string;
  odooReference: string;
  odooMoveId: number | null;
  lines: LoanNotificationLine[];
  attachment?: {
    filename: string;
    base64: string;
  };
}): Promise<{ sent: boolean; recipients: string[]; error?: string }> {
  const recipients = [
    ...new Set(
      params.recipients
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!recipients.length) {
    return { sent: false, recipients, error: 'NO_RECIPIENTS' };
  }

  const transport = getTransporter();
  if (!transport) {
    return { sent: false, recipients, error: 'SMTP_NOT_CONFIGURED' };
  }

  const cashTotal = params.lines.reduce(
    (sum, line) =>
      sum + (line.paymentMethod === 'Cash' ? line.approvedAmount : 0),
    0,
  );
  const fawryTotal = params.lines.reduce(
    (sum, line) =>
      sum + (line.paymentMethod === 'Fawry' ? line.approvedAmount : 0),
    0,
  );
  const commissionTotal = params.lines.reduce(
    (sum, line) => sum + line.fawryCommission,
    0,
  );
  const odooTotal = params.lines.reduce(
    (sum, line) => sum + line.totalAmount,
    0,
  );
  const rows = params.lines
    .map(
      (line) => `
        <tr>
          <td style="padding:8px;border:1px solid #E2E8F0;">${escapeHtml(line.employeeCode)}</td>
          <td style="padding:8px;border:1px solid #E2E8F0;">${escapeHtml(line.employeeName)}</td>
          <td style="padding:8px;border:1px solid #E2E8F0;">${escapeHtml(line.jobTitle)}</td>
          <td style="padding:8px;border:1px solid #E2E8F0;">${escapeHtml(line.branchName ?? '')}</td>
          <td style="padding:8px;border:1px solid #E2E8F0;">${escapeHtml(line.paymentMethod)}</td>
          <td style="padding:8px;border:1px solid #E2E8F0;">${line.approvedAmount.toFixed(2)}</td>
          <td style="padding:8px;border:1px solid #E2E8F0;">${line.fawryCommission.toFixed(2)}</td>
          <td style="padding:8px;border:1px solid #E2E8F0;">${line.totalAmount.toFixed(2)}</td>
        </tr>`,
    )
    .join('');
  const moveLabel =
    params.odooMoveId == null ? '' : ` — Journal Entry #${params.odooMoveId}`;
  const html = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<body style="font-family:Tahoma,Arial,sans-serif;background:#F8FAFC;color:#0F172A;padding:24px;">
  <div style="max-width:760px;margin:auto;background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:24px;">
    <h2 style="margin-top:0;">Approved advances sent to Odoo — ${escapeHtml(params.branchName)}</h2>
    <p>Review reference: <strong>${escapeHtml(params.reference)}</strong></p>
    <p>Date: ${escapeHtml(params.date)}</p>
    <p>Odoo reference: ${escapeHtml(params.odooReference)}${escapeHtml(moveLabel)}</p>
    <table style="width:100%;border-collapse:collapse;margin-top:16px;">
      <thead>
        <tr style="background:#EEF2FF;">
          <th style="padding:8px;border:1px solid #E2E8F0;">Employee Code</th>
          <th style="padding:8px;border:1px solid #E2E8F0;">Employee Name</th>
          <th style="padding:8px;border:1px solid #E2E8F0;">Job Title</th>
          <th style="padding:8px;border:1px solid #E2E8F0;">Branch</th>
          <th style="padding:8px;border:1px solid #E2E8F0;">Payment Method</th>
          <th style="padding:8px;border:1px solid #E2E8F0;">Approved Amount</th>
          <th style="padding:8px;border:1px solid #E2E8F0;">Fawry Commission</th>
          <th style="padding:8px;border:1px solid #E2E8F0;">Total Sent to Odoo</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:16px;padding:16px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;">
      <p style="margin:0 0 8px;">Cash: <strong>${cashTotal.toFixed(2)}</strong></p>
      <p style="margin:0 0 8px;">Fawry: <strong>${fawryTotal.toFixed(2)}</strong></p>
      <p style="margin:0 0 8px;">Fawry commission: <strong>${commissionTotal.toFixed(2)}</strong></p>
      <p style="margin:0;font-weight:bold;">Total sent to Odoo: ${odooTotal.toFixed(2)}</p>
    </div>
  </div>
</body>
</html>`;
  const text = [
    `Approved advances sent to Odoo — ${params.branchName}`,
    `Review reference: ${params.reference}`,
    `Date: ${params.date}`,
    `Odoo reference: ${params.odooReference}${moveLabel}`,
    '',
    ...params.lines.map(
      (line) =>
        `${line.employeeCode} | ${line.employeeName} | ${line.jobTitle} | ${line.branchName ?? ''} | ${line.paymentMethod} | Approved: ${line.approvedAmount.toFixed(2)} | Fawry commission: ${line.fawryCommission.toFixed(2)} | Odoo total: ${line.totalAmount.toFixed(2)}`,
    ),
    '',
    `Cash: ${cashTotal.toFixed(2)}`,
    `Fawry: ${fawryTotal.toFixed(2)}`,
    `Fawry commission: ${commissionTotal.toFixed(2)}`,
    `Total sent to Odoo: ${odooTotal.toFixed(2)}`,
  ].join('\n');

  try {
    await transport.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
      to: recipients.join(', '),
      subject: `Hudoori — Approved advances sent to Odoo — ${params.branchName}`,
      text,
      html,
      attachments: params.attachment
        ? [
            {
              filename: params.attachment.filename,
              content: Buffer.from(params.attachment.base64, 'base64'),
              contentType:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            },
          ]
        : undefined,
    });
    logger.info(
      {
        recipients,
        branchName: params.branchName,
        reference: params.reference,
      },
      'Loan import notification email sent',
    );
    return { sent: true, recipients };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      { error, recipients, branchName: params.branchName },
      'Failed to send loan import notification email',
    );
    return { sent: false, recipients, error: message };
  }
}

export type PayrollJournalEmailLine = {
  code: string;
  name: string;
  debit: number;
  credit: number;
};

function formatMoneyLe(n: number): string {
  return `${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} LE`;
}

export async function sendPayrollJournalSummaryEmail(params: {
  recipients: string[];
  branchName: string;
  payrollName: string;
  odooJournalName: string;
  dateTo: string;
  lines: PayrollJournalEmailLine[];
  totalDebit: number;
  totalCredit: number;
  cashTotal: number;
  fawryGrandTotal: number;
  fawryCommission: number;
  attachments?: { filename: string; base64: string }[];
}): Promise<{ sent: boolean; recipients: string[]; error?: string }> {
  const recipients = [
    ...new Set(
      params.recipients
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!recipients.length) {
    return { sent: false, recipients, error: 'NO_RECIPIENTS' };
  }
  const transport = getTransporter();
  if (!transport) {
    return { sent: false, recipients, error: 'SMTP_NOT_CONFIGURED' };
  }

  const rowHtml = params.lines
    .map((line) => {
      const debit = line.debit ? formatMoneyLe(line.debit) : '';
      const credit = line.credit ? formatMoneyLe(line.credit) : '';
      return `<tr>
        <td style="padding:8px;border:1px solid #E2E8F0;font-family:monospace;">${escapeHtml(line.code)}</td>
        <td style="padding:8px;border:1px solid #E2E8F0;">${escapeHtml(line.name)}</td>
        <td style="padding:8px;border:1px solid #E2E8F0;text-align:left;">${debit}</td>
        <td style="padding:8px;border:1px solid #E2E8F0;text-align:left;">${credit}</td>
      </tr>`;
    })
    .join('');

  const subject = `ملخص قيد مرتبات ${params.odooJournalName} — ${params.branchName}`;
  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Tahoma,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F1F5F9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr>
          <td style="background:#2c6e49;padding:20px 24px;color:#ffffff;">
            <div style="font-size:18px;font-weight:700;">معاينة القيد المحاسبي</div>
            <div style="margin-top:6px;font-size:13px;opacity:.9;">${escapeHtml(params.odooJournalName)} — ${escapeHtml(params.branchName)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 24px;color:#0F172A;font-size:14px;line-height:1.7;">
            <p style="margin:0 0 12px;">تم إرسال قيد مرتبات الفرع إلى Odoo كمسودة للمراجعة والترحيل.</p>
            <p style="margin:0 0 16px;color:#475569;">الكشف: ${escapeHtml(params.payrollName)}<br/>تاريخ القيد: ${escapeHtml(params.dateTo)}</p>
            <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;direction:rtl;">
              <thead>
                <tr style="background:#2c6e49;color:#ffffff;">
                  <th style="padding:8px;border:1px solid #2c6e49;text-align:right;">الكود</th>
                  <th style="padding:8px;border:1px solid #2c6e49;text-align:right;">البيان</th>
                  <th style="padding:8px;border:1px solid #2c6e49;">مدين</th>
                  <th style="padding:8px;border:1px solid #2c6e49;">دائن</th>
                </tr>
              </thead>
              <tbody>
                ${rowHtml}
                <tr style="background:#dee2e6;font-weight:700;">
                  <td colspan="2" style="padding:8px;border:1px solid #E2E8F0;text-align:center;">الإجمالي</td>
                  <td style="padding:8px;border:1px solid #E2E8F0;text-align:left;color:#2c6e49;">${formatMoneyLe(params.totalDebit)}</td>
                  <td style="padding:8px;border:1px solid #E2E8F0;text-align:left;color:#2c6e49;">${formatMoneyLe(params.totalCredit)}</td>
                </tr>
                <tr style="background:#fff3cd;font-weight:700;">
                  <td colspan="2" style="padding:8px;border:1px solid #E2E8F0;text-align:center;">إجمالي الكاش</td>
                  <td colspan="2" style="padding:8px;border:1px solid #E2E8F0;text-align:left;color:#856404;">${formatMoneyLe(params.cashTotal)}</td>
                </tr>
                <tr style="background:#fff3cd;font-weight:700;">
                  <td colspan="2" style="padding:8px;border:1px solid #E2E8F0;text-align:center;">إجمالي الفوري (شامل العمولة)</td>
                  <td colspan="2" style="padding:8px;border:1px solid #E2E8F0;text-align:left;color:#856404;">${formatMoneyLe(params.fawryGrandTotal)}</td>
                </tr>
                <tr style="background:#fff3cd;">
                  <td colspan="2" style="padding:8px;border:1px solid #E2E8F0;text-align:center;">عمولة فوري (0.15%)</td>
                  <td colspan="2" style="padding:8px;border:1px solid #E2E8F0;text-align:left;color:#856404;">${formatMoneyLe(params.fawryCommission)}</td>
                </tr>
              </tbody>
            </table>
            <p style="margin:16px 0 0;font-size:12px;color:#64748B;">مرفقات: كشف الرواتب + فوري + كاش/فوري (نفس تصدير Hudoori).</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await transport.sendMail({
      from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
      to: recipients.join(', '),
      subject,
      html,
      attachments: (params.attachments ?? []).map((file) => ({
        filename: file.filename,
        content: Buffer.from(file.base64, 'base64'),
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })),
    });
    logger.info(
      {
        recipients,
        branchName: params.branchName,
        odooJournalName: params.odooJournalName,
      },
      'Payroll journal summary email sent',
    );
    return { sent: true, recipients };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      { error, recipients, branchName: params.branchName },
      'Failed to send payroll journal summary email',
    );
    return { sent: false, recipients, error: message };
  }
}
