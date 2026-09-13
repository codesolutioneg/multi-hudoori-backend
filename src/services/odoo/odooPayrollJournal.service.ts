/**
 * Send Hudoori payroll as biotime.payroll.journal (قيود المرتبات)
 * then create the draft account.move via action_create_journal_entry.
 */
import { PayrollState } from '@prisma/client';
import { prisma } from '../../prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { getOdooConfig } from './odooClient.service';
import { authenticateOdooOrm, executeKw, searchRead } from './odooOrm.service';
import {
  buildPayrollJournalMoveLines,
  computePayrollCashFawrySummary,
  computePayrollJournalAmounts,
  type PayrollCashFawrySummary,
  type PayrollJournalAmounts,
  type PayrollJournalMoveLine,
} from './payrollJournalAmounts';
import { sendPayrollJournalSummaryEmail } from '../mail.service';
import {
  replaceOdooJournalAttachmentsWithHudooriExports,
  syncOdooHrEmployeesForPayroll,
  type HudooriPayrollJournalExports,
} from './odooPayrollJournalAttachments.service';

type OdooSession = Awaited<ReturnType<typeof authenticateOdooOrm>>;
type PayrollForJournal = Awaited<ReturnType<typeof loadPayrollForJournal>>;

export type PayrollJournalPreview = {
  payrollId: string;
  payrollName: string;
  dateTo: string;
  branchLabel: string;
  alreadySent: boolean;
  odooMoveId: number | null;
  odooMoveName: string | null;
  odooPayrollJournalId: number | null;
  odooSentAt: string | null;
  amounts: PayrollJournalAmounts;
  cashFawry: PayrollCashFawrySummary;
  notificationEmails: string[];
  lines: PayrollJournalMoveLine[];
  debitLabel: string;
};

const KW_CTX = { context: { tracking_disable: true, mail_notrack: true } };

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function loadPayrollForJournal(payrollId: string) {
  const payroll = await prisma.payroll.findUnique({
    where: { id: payrollId },
    include: {
      shiftGrid: { include: { location: true, device: true } },
      lines: {
        include: {
          employee: {
            select: {
              name: true,
              code: true,
              insuranceSalary: true,
              medicalInsuranceSalary: true,
              hasFawryAccount: true,
              active: true,
              departureDate: true,
              archivedAt: true,
              archiveReason: true,
            },
          },
        },
        orderBy: { sequence: 'asc' },
      },
    },
  });
  if (!payroll) throw new NotFoundError('كشف الرواتب غير موجود');
  return payroll;
}

function branchLabel(payroll: PayrollForJournal): string {
  const loc = payroll.shiftGrid?.location;
  const device = payroll.shiftGrid?.device;
  return (
    (loc?.actualName || loc?.name || device?.alias || device?.name || '').trim()
  );
}

function branchNotificationEmails(payroll: PayrollForJournal): string[] {
  const emails = payroll.shiftGrid?.location?.loanNotificationEmails ?? [];
  return [
    ...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

function debitLabel(branch: string, analytic?: { code?: string; name: string; id: number }): string {
  let label = 'حـ/ حساب مرتبات';
  if (branch) label += ` - ${branch}`;
  if (analytic) {
    const code = (analytic.code || '').trim();
    label += code
      ? ` (${code} - ${analytic.name})`
      : ` (${analytic.id} - ${analytic.name})`;
  }
  return label;
}

export async function previewPayrollJournal(
  payrollId: string,
): Promise<PayrollJournalPreview> {
  const payroll = await loadPayrollForJournal(payrollId);
  if (payroll.state === PayrollState.draft) {
    throw new AppError('احسب الكشف أولاً قبل معاينة قيد المرتبات', 400, 'ACTION_ERROR');
  }
  if (!payroll.lines.length) {
    throw new AppError('لا يوجد سطور في كشف الرواتب', 400, 'VALIDATION_ERROR');
  }
  const amounts = computePayrollJournalAmounts(payroll.lines);
  const cashFawry = computePayrollCashFawrySummary(payroll.lines);
  const branch = branchLabel(payroll);
  const label = debitLabel(branch);
  const notificationEmails = branchNotificationEmails(payroll);
  return {
    payrollId: payroll.id,
    payrollName: payroll.name ?? '',
    dateTo: isoDate(payroll.dateTo),
    branchLabel: branch,
    alreadySent: Boolean(payroll.odooPayrollJournalId),
    odooMoveId: payroll.odooMoveId ?? null,
    odooMoveName: payroll.odooMoveName ?? null,
    odooPayrollJournalId: payroll.odooPayrollJournalId ?? null,
    odooSentAt: payroll.odooSentAt?.toISOString() ?? null,
    amounts,
    cashFawry,
    notificationEmails,
    lines: buildPayrollJournalMoveLines(amounts, label),
    debitLabel: label,
  };
}

async function resolveJournalId(
  session: OdooSession,
  configuredId: number | null,
): Promise<{ id: number; name: string }> {
  const byCode = await searchRead<{ id: number; name: string; code: string }>(
    'account.journal',
    [
      ['code', 'in', ['SALAR', 'SALARY', 'PAYROLL', 'salar', 'salary', 'payroll']],
      ['type', 'in', ['general', 'purchase']],
    ],
    ['id', 'name', 'code'],
    { limit: 1 },
    session,
  );
  if (byCode[0]) return { id: byCode[0].id, name: byCode[0].name };

  const byName = await searchRead<{ id: number; name: string }>(
    'account.journal',
    [
      '|',
      ['name', 'ilike', 'مرتبات'],
      ['name', 'ilike', 'payroll'],
      ['type', 'in', ['general', 'purchase']],
    ],
    ['id', 'name'],
    { limit: 1 },
    session,
  );
  if (byName[0]) return { id: byName[0].id, name: byName[0].name };

  if (configuredId) {
    const rows = await searchRead<{ id: number; name: string }>(
      'account.journal',
      [['id', '=', configuredId]],
      ['id', 'name'],
      { limit: 1 },
      session,
    );
    if (rows[0]) return { id: rows[0].id, name: rows[0].name };
  }

  throw new AppError(
    'لم يُعثر على يومية مرتبات في Odoo (SALAR / مرتبات). احفظ دفتر اليومية في الإعدادات.',
    400,
    'ODOO_JOURNAL_MISSING',
  );
}

async function resolveAnalytic(
  session: OdooSession,
  names: string[],
): Promise<{ id: number; name: string; code?: string } | null> {
  const Analytic = 'account.analytic.account';
  for (const name of names) {
    const n = name.trim();
    if (!n) continue;
    const exact = await searchRead<{ id: number; name: string; code?: string }>(
      Analytic,
      [['name', '=', n]],
      ['id', 'name', 'code'],
      { limit: 1 },
      session,
    );
    if (exact[0]) return exact[0];
    const fuzzy = await searchRead<{ id: number; name: string; code?: string }>(
      Analytic,
      [['name', 'ilike', n]],
      ['id', 'name', 'code'],
      { limit: 1 },
      session,
    );
    if (fuzzy[0]) return fuzzy[0];
  }
  const any = await searchRead<{ id: number; name: string; code?: string }>(
    Analytic,
    [],
    ['id', 'name', 'code'],
    { limit: 1 },
    session,
  );
  return any[0] ?? null;
}

async function resolveBiotimeConfigId(session: OdooSession): Promise<number> {
  const rows = await searchRead<{ id: number }>(
    'biotime.config',
    [],
    ['id'],
    { limit: 1 },
    session,
  );
  if (!rows[0]) {
    throw new AppError(
      'لا يوجد biotime.config في Odoo. أنشئ إعدادات BioTime هناك أولاً.',
      400,
      'ODOO_CONFIG_MISSING',
    );
  }
  return rows[0].id;
}

function asIdList(created: number | number[]): number[] {
  if (Array.isArray(created)) return created.filter((id) => Number.isFinite(id) && id > 0);
  return Number.isFinite(created) && created > 0 ? [created] : [];
}

function asSingleId(created: number | number[]): number {
  return asIdList(created)[0] || 0;
}

async function liveOdooPayrollJournalId(
  session: OdooSession,
  journalId: number | null | undefined,
): Promise<number | null> {
  if (!journalId) return null;
  const rows = await searchRead<{ id: number }>(
    'biotime.payroll.journal',
    [['id', '=', journalId]],
    ['id'],
    { limit: 1 },
    session,
  );
  return rows[0]?.id ?? null;
}

async function clearStaleOdooPayrollSendFlags(payrollId: string): Promise<void> {
  await prisma.payroll.update({
    where: { id: payrollId },
    data: {
      odooPayrollJournalId: null,
      odooMoveId: null,
      odooMoveName: '',
      journalEntryId: null,
      odooSentAt: null,
    },
  });
}

async function liveOdooMoveId(
  session: OdooSession,
  moveId: number | null | undefined,
): Promise<number | null> {
  if (!moveId) return null;
  const rows = await searchRead<{ id: number }>(
    'account.move',
    [['id', '=', moveId]],
    ['id'],
    { limit: 1 },
    session,
  );
  return rows[0]?.id ?? null;
}

function odooPayrollLineVals(
  odooPayrollId: number,
  line: PayrollForJournal['lines'][number],
  hrEmployeeId?: number,
): Record<string, unknown> {
  const empSoc = line.employee?.insuranceSalary || line.socialInsurance || 0;
  const empMed = line.employee?.medicalInsuranceSalary || line.medicalInsurance || 0;
  const vals: Record<string, unknown> = {
    payroll_id: odooPayrollId,
    sequence: line.sequence,
    employee_code: line.employeeCode || line.employee?.code || '',
    employee_name: line.employee?.name || '',
    department: line.departmentName || '',
    position: line.positionName || '',
    employee_location: line.employeeLocation || '',
    is_manual: line.isManual,
    basic_salary: line.basicSalary,
    working_days: line.workingDays,
    overtime_hours: line.overtimeHours,
    overtime_amount: line.overtimeAmount,
    work_days_salary: line.workDaysSalary,
    total_earnings: line.totalEarnings,
    late_deduction: line.lateDeduction,
    punch_deduction_checkin: line.punchDeductionCheckin,
    late_checkout_deduction: line.lateCheckoutDeduction,
    sick_deduction: line.sickDeduction,
    absent_count: line.absentCount,
    admin_deduction: line.adminDeduction,
    penalty_deduction_value: line.penaltyDeductionValue,
    fraction_deduction: line.fractionDeduction,
    fines: line.fines,
    long_term_advance: line.advanceLongTotal,
    salary_advance: line.advanceShortTotal,
    deduction_checks: line.deductionChecks,
    health_certificates_deduction: line.healthCertificatesDeduction,
    manual_debit: line.manualDebit,
    documents_deduction: line.documentsDeduction,
    social_insurance: empSoc,
    medical_insurance: empMed,
  };
  if (hrEmployeeId) vals.employee_id = hrEmployeeId;
  return vals;
}

async function resolveHrEmployeeIds(
  session: OdooSession,
  codes: string[],
): Promise<Map<string, number>> {
  const unique = [
    ...new Set(codes.map((c) => c.trim()).filter(Boolean)),
  ];
  const mapped = new Map<string, number>();
  if (!unique.length) return mapped;

  const byBarcode = await searchRead<{ id: number; barcode?: string }>(
    'hr.employee',
    [['barcode', 'in', unique]],
    ['id', 'barcode'],
    { limit: unique.length },
    session,
  );
  for (const row of byBarcode) {
    const code = (row.barcode || '').trim();
    if (code && row.id) mapped.set(code, row.id);
  }
  const missing = unique.filter((code) => !mapped.has(code));
  if (missing.length) {
    const byIdn = await searchRead<{ id: number; identification_id?: string }>(
      'hr.employee',
      [['identification_id', 'in', missing]],
      ['id', 'identification_id'],
      { limit: missing.length },
      session,
    );
    for (const row of byIdn) {
      const code = (row.identification_id || '').trim();
      if (code && row.id && !mapped.has(code)) mapped.set(code, row.id);
    }
  }
  return mapped;
}

async function persistLineEarnings(
  session: OdooSession,
  lineIds: number[],
  expectedEarnings: number[],
): Promise<void> {
  if (!lineIds.length) return;
  const rows = await searchRead<{ id: number; total_earnings: number }>(
    'biotime.payroll.line',
    [['id', 'in', lineIds]],
    ['id', 'total_earnings'],
    { limit: lineIds.length },
    session,
  );
  const current = new Map(rows.map((r) => [r.id, r.total_earnings || 0]));
  for (let i = 0; i < lineIds.length; i++) {
    const want = expectedEarnings[i] ?? 0;
    const got = current.get(lineIds[i]) ?? 0;
    if (Math.abs(got - want) < 0.015) continue;
    await executeKw(
      'biotime.payroll.line',
      'write',
      [[lineIds[i]], { total_earnings: want }],
      KW_CTX,
      session,
    );
  }
}

async function rollbackOdooPayroll(
  session: OdooSession,
  ids: { journalId?: number; payrollId?: number; moveId?: number; unlinkMove?: boolean },
): Promise<void> {
  const silent = async (model: string, method: string, args: unknown[]) => {
    try {
      await executeKw(model, method, args, KW_CTX, session);
    } catch {
      /* best-effort cleanup */
    }
  };
  if (ids.journalId) {
    await silent('biotime.payroll.journal', 'write', [[ids.journalId], { move_id: false }]);
    await silent('biotime.payroll.journal', 'unlink', [[ids.journalId]]);
  }
  if (ids.payrollId) await silent('biotime.payroll', 'unlink', [[ids.payrollId]]);
  if (ids.unlinkMove && ids.moveId) {
    await silent('account.move', 'button_draft', [[ids.moveId]]);
    await silent('account.move', 'button_cancel', [[ids.moveId]]);
    await silent('account.move', 'unlink', [[ids.moveId]]);
  }
}

async function readJournalRow(
  session: OdooSession,
  journalId: number,
): Promise<{ name: string; moveId: number | null; moveName: string }> {
  const rows = await searchRead<{
    id: number;
    name: string;
    move_id: number | [number, string] | false;
  }>(
    'biotime.payroll.journal',
    [['id', '=', journalId]],
    ['id', 'name', 'move_id'],
    { limit: 1 },
    session,
  );
  const row = rows[0];
  if (!row) {
    throw new AppError('تعذر قراءة قيد المرتبات بعد إنشائه في Odoo', 502, 'ODOO_READ_ERROR');
  }
  const moveRel = row.move_id;
  let moveId: number | null = null;
  let moveName = '';
  if (Array.isArray(moveRel)) {
    moveId = moveRel[0];
    moveName = String(moveRel[1] || '');
  } else if (typeof moveRel === 'number' && moveRel > 0) {
    moveId = moveRel;
  }
  if (moveId && (!moveName || moveName === '/')) {
    const moves = await searchRead<{ id: number; name: string }>(
      'account.move',
      [['id', '=', moveId]],
      ['id', 'name'],
      { limit: 1 },
      session,
    );
    moveName = moves[0]?.name || String(moveId);
  }
  return { name: row.name || String(journalId), moveId, moveName };
}

export async function sendPayrollJournalToOdoo(payrollId: string): Promise<{
  payrollId: string;
  odooMoveId: number;
  odooMoveName: string;
  odooPayrollJournalId: number;
  journalName: string;
  amounts: PayrollJournalAmounts;
  cashFawry: PayrollCashFawrySummary;
  email: { sent: boolean; recipients: string[]; error?: string };
}> {
  const config = await getOdooConfig();
  if (!config.integrationEnabled) {
    throw new AppError(
      'Odoo Integration غير مفعّل في الإعدادات',
      400,
      'VALIDATION',
    );
  }

  const payroll = await loadPayrollForJournal(payrollId);
  if (payroll.state === PayrollState.draft) {
    throw new AppError('احسب الكشف أولاً قبل إرسال قيد المرتبات', 400, 'ACTION_ERROR');
  }
  if (!payroll.lines.length) {
    throw new AppError('لا يوجد سطور في كشف الرواتب', 400, 'VALIDATION_ERROR');
  }
  const session = await authenticateOdooOrm();
  if (payroll.odooPayrollJournalId) {
    const liveJournalId = await liveOdooPayrollJournalId(
      session,
      payroll.odooPayrollJournalId,
    );
    if (liveJournalId) {
      throw new AppError(
        `تم الإرسال مسبقًا إلى Odoo (${payroll.odooMoveName || payroll.odooPayrollJournalId})`,
        400,
        'ALREADY_SENT',
      );
    }
    await clearStaleOdooPayrollSendFlags(payroll.id);
  }

  const amounts = computePayrollJournalAmounts(payroll.lines);
  const cashFawry = computePayrollCashFawrySummary(payroll.lines);
  if (amounts.netSalary < 0) {
    throw new AppError(
      'إجمالي الدائن أكبر من المدين. راجع قيم الخصومات/التأمينات.',
      400,
      'VALIDATION_ERROR',
    );
  }
  if (amounts.totalDebit <= 0) {
    throw new AppError('لا يوجد مبالغ لإنشاء قيد', 400, 'VALIDATION_ERROR');
  }
  const salaryJournal = await resolveJournalId(session, config.journalOdooId);
  const branch = branchLabel(payroll);
  const analyticNames = [
    payroll.shiftGrid?.location?.actualName,
    payroll.shiftGrid?.location?.name,
    payroll.shiftGrid?.device?.alias,
    payroll.shiftGrid?.device?.name,
  ].filter((v): v is string => Boolean(v && v.trim()));
  const analytic = await resolveAnalytic(session, analyticNames);
  if (!analytic) {
    throw new AppError(
      'لم يُعثر على حساب تحليلي في Odoo. أنشئ حسابًا تحليليًا باسم الفرع ثم أعد الإرسال.',
      400,
      'ODOO_ANALYTIC_MISSING',
    );
  }

  const existingMoveId = await liveOdooMoveId(session, payroll.odooMoveId);
  if (payroll.odooMoveId && !existingMoveId) {
    await prisma.payroll.update({
      where: { id: payroll.id },
      data: { odooMoveId: null, odooMoveName: '', journalEntryId: null },
    });
  }
  const biotimeConfigId = await resolveBiotimeConfigId(session);

  let odooPayrollId = 0;
  let odooJournalId = 0;
  let createdMoveId: number | null = null;

  try {
    const payrollVals: Record<string, unknown> = {
      config_id: biotimeConfigId,
      date_from: isoDate(payroll.dateFrom),
      date_to: isoDate(payroll.dateTo),
      state: 'calculated',
      biometric_name: branch,
      analytic_account_id: analytic.id,
    };
    odooPayrollId = asSingleId(
      await executeKw<number | number[]>(
        'biotime.payroll',
        'create',
        [payrollVals],
        KW_CTX,
        session,
      ),
    );
    if (!odooPayrollId) {
      throw new AppError('فشل إنشاء كشف الرواتب في Odoo', 502, 'ODOO_PAYROLL_CREATE');
    }

    const hrEmployees = await resolveHrEmployeeIds(
      session,
      payroll.lines.map((line) => line.employeeCode || line.employee?.code || ''),
    );
    await syncOdooHrEmployeesForPayroll(session, payroll.lines, hrEmployees);
    const lineVals = payroll.lines.map((line) =>
      odooPayrollLineVals(
        odooPayrollId,
        line,
        hrEmployees.get((line.employeeCode || line.employee?.code || '').trim()),
      ),
    );
    const createdLines = await executeKw<number | number[]>(
      'biotime.payroll.line',
      'create',
      [lineVals],
      KW_CTX,
      session,
    );
    const lineIds = asIdList(createdLines);
    if (!lineIds.length) {
      throw new AppError('فشل إنشاء سطور كشف الرواتب في Odoo', 502, 'ODOO_LINE_CREATE');
    }
    await persistLineEarnings(
      session,
      lineIds,
      payroll.lines.map((l) => l.totalEarnings),
    );

    const payrollRows = await searchRead<{ id: number; name: string }>(
      'biotime.payroll',
      [['id', '=', odooPayrollId]],
      ['id', 'name'],
      { limit: 1 },
      session,
    );
    const odooPayrollName = payrollRows[0]?.name || payroll.name || 'قيد مرتبات';

    const journalVals: Record<string, unknown> = {
      payroll_id: odooPayrollId,
      date: isoDate(payroll.dateTo),
      journal_id: salaryJournal.id,
      analytic_account_id: analytic.id,
      name: odooPayrollName,
      ref: odooPayrollName,
    };

    odooJournalId = asSingleId(
      await executeKw<number | number[]>(
        'biotime.payroll.journal',
        'create',
        [journalVals],
        KW_CTX,
        session,
      ),
    );
    if (!odooJournalId) {
      throw new AppError('فشل إنشاء قيد المرتبات في Odoo', 502, 'ODOO_JOURNAL_CREATE');
    }

    if (existingMoveId) {
      await executeKw(
        'biotime.payroll.journal',
        'write',
        [[odooJournalId], { move_id: existingMoveId }],
        KW_CTX,
        session,
      );
      await executeKw(
        'biotime.payroll',
        'write',
        [[odooPayrollId], { journal_entry_id: existingMoveId }],
        KW_CTX,
        session,
      );
      createdMoveId = existingMoveId;
    } else {
      await executeKw(
        'biotime.payroll.journal',
        'action_create_journal_entry',
        [[odooJournalId]],
        KW_CTX,
        session,
      );
    }
  } catch (err) {
    await rollbackOdooPayroll(session, {
      journalId: odooJournalId || undefined,
      payrollId: odooPayrollId || undefined,
      moveId: createdMoveId || undefined,
      unlinkMove: Boolean(createdMoveId && !existingMoveId),
    });
    if (err instanceof AppError) throw err;
    throw new AppError(
      err instanceof Error ? err.message : 'فشل إنشاء قيد المرتبات في Odoo',
      502,
      'ODOO_JOURNAL_CREATE',
    );
  }

  const posted = await readJournalRow(session, odooJournalId);
  const moveId = posted.moveId || existingMoveId;
  if (!moveId) {
    await rollbackOdooPayroll(session, {
      journalId: odooJournalId,
      payrollId: odooPayrollId,
    });
    throw new AppError(
      'تم إنشاء قيد المرتبات لكن بدون قيد محاسبي. أعد الإرسال.',
      502,
      'ODOO_MOVE_MISSING',
    );
  }

  let hudooriExports: HudooriPayrollJournalExports;
  try {
    const { freezePayrollPaymentMethods } = await import('../payrollExport.service');
    // Freeze before building attachments so Odoo files match later dashboard re-downloads.
    await freezePayrollPaymentMethods(payroll.id, { overwrite: false });
    hudooriExports = await replaceOdooJournalAttachmentsWithHudooriExports(
      session,
      odooJournalId,
      payroll.id,
    );
  } catch (attachErr) {
    await rollbackOdooPayroll(session, {
      journalId: odooJournalId,
      payrollId: odooPayrollId,
      moveId,
      unlinkMove: Boolean(moveId && !existingMoveId),
    });
    throw new AppError(
      attachErr instanceof Error
        ? attachErr.message
        : 'فشل رفع ملفات Excel إلى قيد Odoo',
      502,
      'ODOO_ATTACHMENT_UPLOAD',
    );
  }

  const displayName = posted.name || posted.moveName || String(moveId);

  await prisma.payroll.update({
    where: { id: payroll.id },
    data: {
      journalEntryId: String(moveId),
      odooMoveId: moveId,
      odooMoveName: displayName,
      odooPayrollJournalId: odooJournalId,
      odooSentAt: new Date(),
    },
  });

  // Snapshot the exact files sent to Odoo so re-downloads stay byte-identical.
  try {
    const { savePayrollSentSnapshot } = await import('../payrollSentSnapshot.service');
    savePayrollSentSnapshot(payroll.id, hudooriExports);
  } catch {
    /* best-effort; already logged inside the snapshot service */
  }

  const debitLbl = debitLabel(branch, analytic);
  const email = await sendPayrollJournalSummaryEmail({
    recipients: branchNotificationEmails(payroll),
    branchName: branch || 'فرع غير محدد',
    payrollName: payroll.name || displayName,
    odooJournalName: displayName,
    dateTo: isoDate(payroll.dateTo),
    lines: buildPayrollJournalMoveLines(amounts, debitLbl),
    totalDebit: amounts.totalDebit,
    totalCredit: amounts.totalCredit,
    cashTotal: cashFawry.cashTotal,
    fawryGrandTotal: cashFawry.fawryGrandTotal,
    fawryCommission: cashFawry.fawryCommission,
    attachments: [
      hudooriExports.payroll,
      hudooriExports.fawry,
      hudooriExports.cashFawry,
    ],
  });

  return {
    payrollId: payroll.id,
    odooMoveId: moveId,
    odooMoveName: displayName,
    odooPayrollJournalId: odooJournalId,
    journalName: salaryJournal.name,
    amounts,
    cashFawry,
    email,
  };
}
