/**
 * Replace Odoo-generated payroll journal Excel attachments with Hudoori exports
 * so journal files match «تصدير Excel» from the dashboard.
 */
import {
  exportCashFawryXlsx,
  exportFawryXlsx,
  exportPayrollXlsx,
} from '../payrollExport.service';
import { executeKw, searchRead } from './odooOrm.service';

type OdooSession = Awaited<ReturnType<typeof import('./odooOrm.service').authenticateOdooOrm>>;

type PayrollLineForSync = {
  employeeCode: string | null;
  socialInsurance: number | null;
  medicalInsurance: number | null;
  employee: {
    code: string | null;
    insuranceSalary: number | null;
    medicalInsuranceSalary: number | null;
    hasFawryAccount: boolean;
  } | null;
};

const KW_CTX = { context: { tracking_disable: true, mail_notrack: true } };
const HR_SYNC_CTX = {
  context: {
    tracking_disable: true,
    mail_notrack: true,
    skip_biotime_push: true,
  },
};
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type HudooriPayrollJournalExports = {
  payroll: { filename: string; base64: string };
  fawry: { filename: string; base64: string };
  cashFawry: { filename: string; base64: string };
};

function siblingExportFilename(payrollFilename: string, prefix: 'Fawry' | 'CashFawry'): string {
  const stem = payrollFilename.replace(/\.xlsx$/i, '').replace(/^Payroll_/, '');
  return `${prefix}_${stem}.xlsx`;
}

export async function buildHudooriPayrollJournalExports(
  payrollId: string,
): Promise<HudooriPayrollJournalExports> {
  const [payrollExport, fawryExport, cashFawryExport] = await Promise.all([
    exportPayrollXlsx(payrollId),
    exportFawryXlsx(payrollId),
    exportCashFawryXlsx(payrollId),
  ]);
  return {
    payroll: payrollExport,
    fawry: fawryExport,
    cashFawry: cashFawryExport,
  };
}

async function createOdooAttachment(
  session: OdooSession,
  params: {
    name: string;
    base64: string;
    resModel: string;
    resId: number;
  },
): Promise<number> {
  const id = await executeKw<number>(
    'ir.attachment',
    'create',
    [
      {
        name: params.name,
        type: 'binary',
        datas: params.base64,
        mimetype: XLSX_MIME,
        res_model: params.resModel,
        res_id: params.resId,
      },
    ],
    KW_CTX,
    session,
  );
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`فشل إنشاء مرفق Odoo: ${params.name}`);
  }
  return id;
}

export async function syncOdooHrEmployeesForPayroll(
  session: OdooSession,
  lines: PayrollLineForSync[],
  hrEmployeeIds: Map<string, number>,
): Promise<number> {
  let updated = 0;
  for (const line of lines) {
    const code = (line.employeeCode || line.employee?.code || '').trim();
    if (!code) continue;
    const hrId = hrEmployeeIds.get(code);
    if (!hrId || !line.employee) continue;
    const emp = line.employee;
    await executeKw(
      'hr.employee',
      'write',
      [
        [
          hrId,
          {
            insurance_salary: emp.insuranceSalary || line.socialInsurance || 0,
            medical_insurance_salary:
              emp.medicalInsuranceSalary || line.medicalInsurance || 0,
            fawry_account: Boolean(emp.hasFawryAccount),
          },
        ],
      ],
      KW_CTX,
      session,
    );
    updated += 1;
  }
  return updated;
}

export async function replaceOdooJournalAttachmentsWithHudooriExports(
  session: OdooSession,
  odooJournalId: number,
  payrollId: string,
): Promise<HudooriPayrollJournalExports> {
  const exports = await buildHudooriPayrollJournalExports(payrollId);

  const rows = await searchRead<{
    id: number;
    payroll_xlsx_attachment_id: false | [number, string];
    fawry_xlsx_attachment_id: false | [number, string];
    cash_fawry_xlsx_attachment_id: false | [number, string];
    attachment_ids: number[];
  }>(
    'biotime.payroll.journal',
    [['id', '=', odooJournalId]],
    [
      'id',
      'payroll_xlsx_attachment_id',
      'fawry_xlsx_attachment_id',
      'cash_fawry_xlsx_attachment_id',
      'attachment_ids',
    ],
    { limit: 1 },
    session,
  );
  const row = rows[0];
  if (!row) {
    throw new Error('تعذر قراءة قيد المرتبات في Odoo لرفع ملفات Excel');
  }

  const oldIds = new Set<number>();
  for (const rel of [
    row.payroll_xlsx_attachment_id,
    row.fawry_xlsx_attachment_id,
    row.cash_fawry_xlsx_attachment_id,
  ]) {
    if (Array.isArray(rel) && rel[0]) oldIds.add(rel[0]);
  }
  for (const id of row.attachment_ids || []) {
    if (id) oldIds.add(id);
  }

  const model = 'biotime.payroll.journal';
  const payrollAttId = await createOdooAttachment(session, {
    name: exports.payroll.filename,
    base64: exports.payroll.base64,
    resModel: model,
    resId: odooJournalId,
  });
  const fawryAttId = await createOdooAttachment(session, {
    name: exports.fawry.filename,
    base64: exports.fawry.base64,
    resModel: model,
    resId: odooJournalId,
  });
  const cashFawryAttId = await createOdooAttachment(session, {
    name: exports.cashFawry.filename,
    base64: exports.cashFawry.base64,
    resModel: model,
    resId: odooJournalId,
  });

  const newIds = [payrollAttId, fawryAttId, cashFawryAttId];

  await executeKw(
    'biotime.payroll.journal',
    'write',
    [
      [
        odooJournalId,
        {
          payroll_xlsx_attachment_id: payrollAttId,
          fawry_xlsx_attachment_id: fawryAttId,
          cash_fawry_xlsx_attachment_id: cashFawryAttId,
          attachment_ids: [[6, 0, newIds]],
        },
      ],
    ],
    KW_CTX,
    session,
  );

  const stale = [...oldIds].filter((id) => !newIds.includes(id));
  if (stale.length) {
    try {
      await executeKw('ir.attachment', 'unlink', [stale], KW_CTX, session);
    } catch {
      /* best-effort */
    }
  }

  try {
    await executeKw(
      'biotime.payroll.journal',
      'message_post',
      [[odooJournalId]],
      {
        body: 'تم استبدال ملفات Excel بملفات تصدير Hudoori (كشف + فوري + كاش/فوري).',
        attachment_ids: [[6, 0, newIds]],
        ...KW_CTX,
      },
      session,
    );
  } catch {
    /* optional chatter note */
  }

  return exports;
}
