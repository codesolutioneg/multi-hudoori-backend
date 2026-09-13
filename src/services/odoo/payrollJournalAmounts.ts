/**
 * Odoo-parity amounts for biotime.payroll.journal / account.move.
 * Mirrors jouma-main 5/biotime_payroll/models/payroll_journal_entry.py
 */
export const PAYROLL_JOURNAL_ACCOUNT_CODES = {
  salaries: '613004200',
  socExp: '613134340',
  penalties: '221531076',
  longAdv: '150480381',
  shortAdv: '150480380',
  checks: '150480382',
  manualDebit: '150540469',
  socLib: '221541090',
  medLib: '150490394',
  paper: '221531075',
  netSal: '221541086',
} as const;

export type PayrollJournalLineInput = {
  basicSalary?: number | null;
  totalEarnings?: number | null;
  lateDeduction?: number | null;
  punchDeductionCheckin?: number | null;
  lateCheckoutDeduction?: number | null;
  sickDeduction?: number | null;
  absentCount?: number | null;
  adminDeduction?: number | null;
  penaltyDeductionValue?: number | null;
  fractionDeduction?: number | null;
  fines?: number | null;
  advanceLongTotal?: number | null;
  advanceShortTotal?: number | null;
  deductionChecks?: number | null;
  healthCertificatesDeduction?: number | null;
  manualDebit?: number | null;
  documentsDeduction?: number | null;
  socialInsurance?: number | null;
  medicalInsurance?: number | null;
  employee?: {
    insuranceSalary?: number | null;
    medicalInsuranceSalary?: number | null;
    hasFawryAccount?: boolean | null;
    active?: boolean | null;
    departureDate?: Date | string | null;
    archivedAt?: Date | string | null;
    archiveReason?: string | null;
  } | null;
  netSalary?: number | null;
  /** Frozen on payroll line at confirm / Odoo send. */
  paymentMethod?: string | null;
};

export type PayrollJournalAmounts = {
  totalEarnings: number;
  companySocial: number;
  totalDebit: number;
  penalties: number;
  longTermAdvance: number;
  salaryAdvance: number;
  deductionChecks: number;
  manualDebit: number;
  documentsTotal: number;
  employeeSocial: number;
  employeeMedical: number;
  totalSocialLib: number;
  totalMedicalLib: number;
  netSalary: number;
  totalCredit: number;
  lineCount: number;
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Odoo `_penalty_total` — P+R+T+V + أيام×اليومي + مبلغ الجزاء + كسر + غرامات */
export function penaltyTotal(line: PayrollJournalLineInput): number {
  const basic = line.basicSalary || 0;
  const daily = basic ? basic / 30 : 0;
  return round2(
    round2(line.lateDeduction || 0) +
      round2(line.punchDeductionCheckin || 0) +
      round2(line.lateCheckoutDeduction || 0) +
      round2(line.sickDeduction || 0) +
      round2(daily * (line.absentCount || 0)) +
      round2(daily * (line.adminDeduction || 0)) +
      (line.penaltyDeductionValue || 0) +
      (line.fractionDeduction || 0) +
      (line.fines || 0),
  );
}

function employeeSocial(line: PayrollJournalLineInput): number {
  const fromEmp = line.employee?.insuranceSalary;
  if (fromEmp && fromEmp > 0) return fromEmp;
  return line.socialInsurance || 0;
}

function employeeMedical(line: PayrollJournalLineInput): number {
  const fromEmp = line.employee?.medicalInsuranceSalary;
  if (fromEmp && fromEmp > 0) return fromEmp;
  return line.medicalInsurance || 0;
}

export function computePayrollJournalAmounts(
  lines: PayrollJournalLineInput[],
): PayrollJournalAmounts {
  const empSoc = round2(lines.reduce((s, l) => s + employeeSocial(l), 0));
  const empMed = round2(lines.reduce((s, l) => s + employeeMedical(l), 0));
  const coSoc = empSoc ? round2((empSoc / 0.11) * 0.1875) : 0;
  const totalEarnings = round2(
    lines.reduce((s, l) => s + (l.totalEarnings || 0), 0),
  );
  const penalties = round2(lines.reduce((s, l) => s + penaltyTotal(l), 0));
  const longTermAdvance = round2(
    lines.reduce((s, l) => s + (l.advanceLongTotal || 0), 0),
  );
  const salaryAdvance = round2(
    lines.reduce((s, l) => s + (l.advanceShortTotal || 0), 0),
  );
  const deductionChecks = round2(
    lines.reduce(
      (s, l) =>
        s +
        (l.deductionChecks || 0) +
        (l.healthCertificatesDeduction || 0),
      0,
    ),
  );
  const manualDebit = round2(
    lines.reduce((s, l) => s + (l.manualDebit || 0), 0),
  );
  const documentsTotal = round2(
    lines.reduce((s, l) => s + (l.documentsDeduction || 0), 0),
  );
  const totalDebit = round2(totalEarnings + coSoc);
  const creditsWithoutNet = round2(
    penalties +
      longTermAdvance +
      salaryAdvance +
      deductionChecks +
      manualDebit +
      documentsTotal +
      round2(empSoc + coSoc) +
      empMed,
  );
  const netSalary = round2(totalDebit - creditsWithoutNet);
  return {
    totalEarnings,
    companySocial: coSoc,
    totalDebit,
    penalties,
    longTermAdvance,
    salaryAdvance,
    deductionChecks,
    manualDebit,
    documentsTotal,
    employeeSocial: empSoc,
    employeeMedical: empMed,
    totalSocialLib: round2(empSoc + coSoc),
    totalMedicalLib: empMed,
    netSalary,
    totalCredit: round2(creditsWithoutNet + netSalary),
    lineCount: lines.length,
  };
}

export type PayrollJournalMoveLine = {
  code: string;
  name: string;
  debit: number;
  credit: number;
};

export function buildPayrollJournalMoveLines(
  amounts: PayrollJournalAmounts,
  debitLabel: string,
): PayrollJournalMoveLine[] {
  const C = PAYROLL_JOURNAL_ACCOUNT_CODES;
  const rows: PayrollJournalMoveLine[] = [];
  const debit = (code: string, name: string, amount: number) => {
    if (!amount) return;
    rows.push({ code, name, debit: amount, credit: 0 });
  };
  const credit = (code: string, name: string, amount: number) => {
    if (!amount) return;
    rows.push({ code, name, debit: 0, credit: amount });
  };

  debit(C.salaries, debitLabel, amounts.totalEarnings);
  debit(C.socExp, 'حـ/ مصروف تأمينات اجتماعية حصة الشركة', amounts.companySocial);
  credit(C.penalties, 'حـ/ جزاءات العاملين', amounts.penalties);
  credit(C.longAdv, 'حـ/ سلف طويلة الأجل', amounts.longTermAdvance);
  credit(C.shortAdv, 'حـ/ سلفة مؤقتة', amounts.salaryAdvance);
  credit(C.checks, 'حـ/ تحميلات / شيكات شخصية', amounts.deductionChecks);
  credit(C.manualDebit, 'حـ/ مانوال ديبت', amounts.manualDebit);
  credit(C.socLib, 'حـ/ مستحق تأمينات اجتماعية', amounts.totalSocialLib);
  credit(C.paper, 'حـ/ خصم اوراق', amounts.documentsTotal);
  credit(C.medLib, 'حـ/ مقدم تأمينات طبية', amounts.totalMedicalLib);
  credit(C.netSal, 'حـ/ مستحق مرتبات', amounts.netSalary);
  return rows;
}

export type PayrollCashFawrySummary = {
  cashTotal: number;
  fawryNet: number;
  fawryCommission: number;
  fawryGrandTotal: number;
};

export function isPayrollEmployeeResigned(
  emp?: PayrollJournalLineInput['employee'] | null,
): boolean {
  if (!emp) return false;
  if (emp.active && !emp.departureDate) return false;
  if (!emp.active || emp.departureDate || emp.archivedAt) return true;
  const reason = String(emp.archiveReason ?? '');
  return /استقال|انهاء|إنهاء|انقطاع|ترك العمل|terminated|resign/i.test(reason);
}

/** Same split as معاينة القيد: cash net, fawry inclusive of 0.15%, commission. */
export function computePayrollCashFawrySummary(
  lines: PayrollJournalLineInput[],
): PayrollCashFawrySummary {
  let cash = 0;
  let fawry = 0;
  for (const line of lines) {
    const net = Number(line.netSalary ?? 0) || 0;
    const frozen = String(line.paymentMethod ?? '').trim();
    const isFawry =
      frozen === 'فوري'
        ? true
        : frozen === 'كاش'
          ? false
          : !(
              isPayrollEmployeeResigned(line.employee) ||
              !line.employee?.hasFawryAccount
            );
    if (isFawry) fawry += net;
    else cash += net;
  }
  const cashTotal = round2(cash);
  const fawryNet = round2(fawry);
  const fawryCommission = round2(fawryNet * 0.0015);
  return {
    cashTotal,
    fawryNet,
    fawryCommission,
    fawryGrandTotal: round2(fawryNet + fawryCommission),
  };
}
