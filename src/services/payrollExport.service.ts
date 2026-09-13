/**
 * Port of Odoo biotime_payroll/reports/payroll_xlsx.py + payslip_sheet_xlsx.py
 */
import ExcelJS from 'exceljs';
import type { EmployeeProfile, PayrollLine } from '@prisma/client';
import { prisma } from '../prisma/client';
import { NotFoundError } from '../utils/errors';

type LineWithEmployee = PayrollLine & {
  employee?: (EmployeeProfile & {
    department?: { name: string } | null;
    workLocation?: { name: string } | null;
  }) | null;
};

type PayrollWithLines = {
  id: string;
  name: string | null;
  dateFrom: Date;
  dateTo: Date;
  shiftGridId: string | null;
  shiftGrid?: { location?: { name: string | null } | null } | null;
  lines: LineWithEmployee[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Net salary for Excel export — uncapped (stored payroll lines use max(0, …)).
 */
export function excelNetSalaryLine(
  line: Pick<PayrollLine, 'totalEarnings' | 'grossSalary' | 'totalDeductions' | 'netSalary'>,
  totalEarnOverride?: number,
  totalDeductionsOverride?: number,
): number {
  const earn = totalEarnOverride ?? line.totalEarnings ?? line.grossSalary ?? 0;
  const ded = totalDeductionsOverride ?? line.totalDeductions ?? 0;
  return round2(earn - ded);
}

function dailyRateExpr(colBasic: string, colWdays: string, colWds: string, xlRow: number): string {
  return `IF(${colBasic}${xlRow}>0,${colBasic}${xlRow}/30,IF(${colWdays}${xlRow}>0,${colWds}${xlRow}/${colWdays}${xlRow},0))`;
}

/** Prefer Excel-imported absent count; `0` is valid (don't fall back to stale absentDays). */
export function exportedAbsentCount(line: Pick<PayrollLine, 'absentCount' | 'absentDays'>): number {
  return line.absentCount ?? line.absentDays ?? 0;
}

/** Stored absent deduction for export (manual/import lines keep exact DB money). */
export function exportedAbsentDeduction(
  line: Pick<PayrollLine, 'absentDeduction' | 'absentCount' | 'absentDays' | 'isManual'>,
  dailyRate: number,
): number {
  const count = exportedAbsentCount(line);
  if (line.isManual && line.absentDeduction != null) {
    return round2(line.absentDeduction);
  }
  if (line.absentDeduction != null && line.absentDeduction > 0) {
    return round2(line.absentDeduction);
  }
  return round2(dailyRate * count);
}

/**
 * Odoo _is_resigned parity for Excel export — inactive / departed employees.
 * restoreEmployee() keeps archivedAt/archiveReason as audit trail; restored
 * (active + no departureDate) employees are not resigned in export.
 */
export function isResigned(emp: EmployeeProfile | null | undefined): boolean {
  if (!emp) return false;
  if (emp.active && !emp.departureDate) return false;
  if (!emp.active || emp.departureDate || emp.archivedAt) return true;
  const reason = String(emp.archiveReason ?? '');
  return /استقال|انهاء|إنهاء|انقطاع|ترك العمل|terminated|resign/i.test(reason);
}

function hasFawryAccount(line: LineWithEmployee): boolean {
  return Boolean(line.employee?.hasFawryAccount);
}

/**
 * Resigned/archived (yellow) state for a payroll line.
 * Prefer the frozen snapshot captured at confirm / Odoo send; fall back to the
 * live employee state only when the line was never frozen. This keeps re-downloads
 * of sent payrolls identical to what went to Odoo even if the employee is archived later.
 */
export function isResignedLine(line: LineWithEmployee): boolean {
  const frozen = (line as { resignedFrozen?: boolean | null }).resignedFrozen;
  if (frozen === true || frozen === false) return frozen;
  return isResigned(line.employee);
}

/** Live rule (used until the line is frozen at confirm / Odoo send). */
export function computeLivePaymentMethod(line: LineWithEmployee): 'فوري' | 'كاش' {
  if (isResigned(line.employee)) return 'كاش';
  return hasFawryAccount(line) ? 'فوري' : 'كاش';
}

/**
 * Prefer frozen paymentMethod on the payroll line (locked at confirm / send).
 * Falls back to live employee flags when not frozen yet.
 */
export function payrollPaymentMethod(line: LineWithEmployee): 'فوري' | 'كاش' {
  const frozen = String(line.paymentMethod ?? '').trim();
  if (frozen === 'فوري' || frozen === 'كاش') return frozen;
  return computeLivePaymentMethod(line);
}

export function isFawryPayment(line: LineWithEmployee): boolean {
  return payrollPaymentMethod(line) === 'فوري';
}

/** Odoo fawry_xlsx: employee work_phone only (stored on payroll line as related field). */
function fawryWorkPhone(line: LineWithEmployee): string {
  const workPhone = line.employee?.workPhone?.trim() ?? '';
  if (workPhone) return workPhone;
  const fawryStored = line.employee?.fawryAccount?.trim() ?? '';
  if (fawryStored && /^\d{8,}$/.test(fawryStored.replace(/\D/g, ''))) return fawryStored;
  return '';
}

/**
 * Grand total column (AM) in Odoo payroll_xlsx / fawry_xlsx.
 * Deliberately delegates to the payroll-Excel math so the Fawry sheet can never
 * drift away from the main sheet again.
 */
function computeFawryGrandTotal(line: LineWithEmployee): number {
  return computePayrollLineExcelTotals(line).grandTotal;
}

/** Odoo cash_fawry_xlsx._compute_line_totals parity — same math as payroll Excel export rows. */
export function computePayrollLineExcelTotals(line: LineWithEmployee): {
  net: number;
  fawryCommission: number;
  grandTotal: number;
  totalEarnings: number;
  totalDeductions: number;
} {
  const emp = line.employee;
  let basic = line.basicSalary || emp?.basicSalary || 0;
  if (!basic && line.workingDays && line.workDaysSalary) {
    basic = round2((line.workDaysSalary / line.workingDays) * 30);
  }
  const daily = basic / 30;

  let totalEarn: number;
  if (line.basicSalary) {
    totalEarn = line.totalEarnings || line.grossSalary || 0;
  } else {
    const workDaysSal = round2(daily * (line.workingDays || 0));
    const overtimeAmt = round2(daily * (line.overtimeHours || 0));
    totalEarn = round2(workDaysSal + overtimeAmt);
  }

  const socialIns = emp?.insuranceSalary || line.socialInsurance || 0;
  const medicalIns = emp?.medicalInsuranceSalary || line.medicalInsurance || 0;
  const lateVal = round2(line.lateDeduction || 0);
  const punchRepVal = round2(line.punchDeductionCheckin || 0);
  const lateCheckoutMoney = round2(line.lateCheckoutDeduction || 0);
  const sickDedVal = round2(line.sickDeduction || 0);
  const absentDedVal = exportedAbsentDeduction(
    { absentDeduction: line.absentDeduction, absentCount: line.absentCount, absentDays: line.absentDays, isManual: line.isManual },
    daily,
  );
  const penaltyVal = round2(daily * (line.adminDeduction || 0) + (line.penaltyDeductionValue || 0));

  const totalDeductions = round2(
    socialIns + medicalIns + lateVal + punchRepVal + lateCheckoutMoney + sickDedVal +
    absentDedVal + penaltyVal +
    (line.advanceLongTotal || 0) + (line.advanceShortTotal || 0) +
    (line.deductionChecks || 0) + (line.manualDebit || 0) +
    (line.healthCertificatesDeduction || 0) + (line.fractionDeduction || 0) +
    (line.fines || 0) + (line.documentsDeduction || 0) +
    (line.groupedChecks || 0) +
    (line.previousSettlements || 0) + (line.previousInsurance || 0),
  );
  const net = round2(totalEarn - totalDeductions);
  // Commission follows the (frozen) payment method, exactly like the main payroll
  // Excel does. Reading live employee flags here would let a later archive change
  // the totals of a payroll that was already sent to Odoo.
  const fawryCommission = isFawryPayment(line) ? round2(net * 0.0015) : 0;
  const grandTotal = round2(net + fawryCommission);

  return { net, fawryCommission, grandTotal, totalEarnings: totalEarn, totalDeductions };
}

/** List / API totals — must match payroll Excel export without running «حساب». */
export function computePayrollExcelSummary(lines: LineWithEmployee[]): {
  totalEarnings: number;
  totalDeductions: number;
  totalNet: number;
  fawryCommission: number;
  grandTotal: number;
  cashTotal: number;
  fawryTotal: number;
  fawryGrandTotal: number;
} {
  let totalEarnings = 0;
  let totalDeductions = 0;
  let totalNet = 0;
  let fawryCommission = 0;
  let grandTotal = 0;
  let cashTotal = 0;
  let fawryTotal = 0;
  let fawryGrandTotal = 0;

  for (const line of lines) {
    const t = computePayrollLineExcelTotals(line);
    totalEarnings += t.totalEarnings;
    totalDeductions += t.totalDeductions;
    totalNet += t.net;
    fawryCommission += t.fawryCommission;
    grandTotal += t.grandTotal;
    if (payrollPaymentMethod(line) === 'كاش') {
      cashTotal += t.grandTotal;
    } else {
      fawryTotal += t.net;
      fawryGrandTotal += t.grandTotal;
    }
  }

  return {
    totalEarnings: round2(totalEarnings),
    totalDeductions: round2(totalDeductions),
    totalNet: round2(totalNet),
    fawryCommission: round2(fawryCommission),
    grandTotal: round2(grandTotal),
    cashTotal: round2(cashTotal),
    fawryTotal: round2(fawryTotal),
    fawryGrandTotal: round2(fawryGrandTotal),
  };
}

function computeLineTotals(line: LineWithEmployee) {
  return computePayrollLineExcelTotals(line);
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return '';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function monthYearLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Safe branch token for download filenames (e.g. Strip → Strip, فرع → فرع). */
export function sanitizePayrollFilenamePart(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, '_');
  const cleaned = trimmed.replace(/[^\w\u0600-\u06FF\-]+/g, '_').replace(/_+/g, '_');
  return cleaned.replace(/^_|_$/g, '') || 'Payroll';
}

export function buildPayrollXlsxFilename(
  payroll: Pick<PayrollWithLines, 'dateFrom' | 'dateTo' | 'shiftGrid' | 'name'>,
): string {
  const branch = sanitizePayrollFilenamePart(
    payroll.shiftGrid?.location?.name?.trim() || payroll.name?.trim() || 'Payroll',
  );
  const from = payroll.dateFrom.toISOString().slice(0, 10);
  const to = payroll.dateTo.toISOString().slice(0, 10);
  return `Payroll_${branch}_${from}_${to}.xlsx`;
}

export function buildPayslipsXlsxFilename(
  payroll: Pick<PayrollWithLines, 'dateFrom' | 'dateTo' | 'shiftGrid' | 'name'>,
): string {
  return buildPayrollXlsxFilename(payroll).replace(/^Payroll_/, 'Payslips_');
}

/** e.g. BALALA_2024-07-26_2024-08-25_CashFawry.xlsx */
export function buildCashFawryXlsxFilename(
  payroll: Pick<PayrollWithLines, 'dateFrom' | 'dateTo' | 'shiftGrid' | 'name'>,
): string {
  const branch = sanitizePayrollFilenamePart(
    payroll.shiftGrid?.location?.name?.trim() || payroll.name?.trim() || 'Payroll',
  );
  const from = payroll.dateFrom.toISOString().slice(0, 10);
  const to = payroll.dateTo.toISOString().slice(0, 10);
  return `${branch}_${from}_${to}_CashFawry.xlsx`;
}

/** e.g. BALALA_2024-07-26_2024-08-25_Fawry.xlsx */
export function buildFawryOnlyXlsxFilename(
  payroll: Pick<PayrollWithLines, 'dateFrom' | 'dateTo' | 'shiftGrid' | 'name'>,
): string {
  const branch = sanitizePayrollFilenamePart(
    payroll.shiftGrid?.location?.name?.trim() || payroll.name?.trim() || 'Payroll',
  );
  const from = payroll.dateFrom.toISOString().slice(0, 10);
  const to = payroll.dateTo.toISOString().slice(0, 10);
  return `${branch}_${from}_${to}_Fawry.xlsx`;
}

function excelColLetter(oneBasedCol: number): string {
  let col = oneBasedCol;
  let letter = '';
  while (col > 0) {
    const mod = (col - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

const COLUMNS: { header: string; width: number; key: string }[] = [
  { header: 'كود\nالموظف', width: 10, key: 'employee_code' },
  { header: 'Employee Name', width: 25, key: 'employee_name' },
  { header: 'Department', width: 10, key: 'department' },
  { header: 'Position', width: 12, key: 'position' },
  { header: 'Date Of\nJoining', width: 12, key: 'hiring_date' },
  { header: 'Last\nWorking', width: 10, key: 'placeholder' },
  { header: 'Basic Salary', width: 10, key: 'basic_salary' },
  { header: 'أيام العمل', width: 6, key: 'working_days' },
  { header: 'عدد\nالإضافي', width: 7, key: 'overtime_hours' },
  { header: 'راتب أيام\nالعمل', width: 10, key: 'work_days_salary' },
  { header: 'مبلغ\nالإضافي', width: 10, key: 'overtime_amount' },
  { header: 'إجمالي\nالاستحقاقات', width: 10, key: 'total_earnings' },
  { header: 'تأمينات\nاجتماعية', width: 10, key: 'social_insurance' },
  { header: 'تأمين\nطبي', width: 10, key: 'medical_insurance' },
  { header: 'خصم\nالتأخير', width: 8, key: 'late_deductible_days' },
  { header: 'قيمة خصم\nالتأخير', width: 10, key: 'late_value' },
  { header: 'عدم\nبصمة', width: 8, key: 'single_punch_count' },
  { header: 'قيمة تكرار\nالبصمة', width: 10, key: 'punch_deduction_checkin' },
  { header: 'تأخير\nالانصراف', width: 8, key: 'late_checkout_days' },
  { header: 'قيمة تأخير\nالانصراف', width: 10, key: 'late_checkout_value' },
  { header: 'أيام الإجازة\nالمرضية', width: 8, key: 'sick_day_count' },
  { header: 'قيمة الإجازة\nالمرضية', width: 10, key: 'sick_value' },
  { header: 'غياب بدون\nإذن', width: 8, key: 'absent_count' },
  { header: 'خصم\nالغياب', width: 10, key: 'absent_deduction' },
  { header: 'خصم\nاداري', width: 10, key: 'admin_deduction' },
  { header: 'قيمة خصم\nالجزاء', width: 10, key: 'penalty_deduction_value' },
  { header: 'قسط سلفة\nطويلة الاجل', width: 10, key: 'long_term_advance' },
  { header: 'سلف من\nالراتب', width: 10, key: 'salary_advance' },
  { header: 'شيكات\nشخصية', width: 10, key: 'deduction_checks' },
  { header: 'مانيول\nديبت', width: 10, key: 'manual_debit' },
  { header: 'شهادات\nصحية', width: 10, key: 'health_certificates_deduction' },
  { header: 'كسر', width: 6, key: 'fraction_deduction' },
  { header: 'خصومات', width: 8, key: 'fines' },
  { header: 'خصم\nاوراق', width: 10, key: 'documents_deduction' },
  { header: 'إجمالي\nالاستقطاعات', width: 10, key: 'total_deductions' },
  { header: 'صافي\nالراتب', width: 12, key: 'net_salary' },
  { header: 'طريقة الدفع', width: 10, key: 'fawry_account' },
  { header: 'عمولة\nفوري', width: 10, key: 'fawry_commission' },
  { header: 'الإجمالي', width: 12, key: 'grand_total' },
  { header: 'Location\nالموظف', width: 22, key: 'employee_location' },
];

const EARNINGS_START = 9;
const EARNINGS_END = 11;
const DEDUCTIONS_START = 12;
const DEDUCTIONS_END = 33;
const DATA_START_ROW = 6;

async function loadPayrollForExport(payrollId: string): Promise<PayrollWithLines> {
  const payroll = await prisma.payroll.findUnique({
    where: { id: payrollId },
    include: {
      lines: {
        include: {
          employee: { include: { department: true, workLocation: true } },
        },
        orderBy: { sequence: 'asc' },
      },
      shiftGrid: { include: { location: true } },
    },
  });
  if (!payroll) throw new NotFoundError('Payroll not found');
  return payroll;
}

function fawryHeaderStyle(): Partial<ExcelJS.Style> {
  return {
    font: { bold: true, size: 11, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } },
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
}

function fawryTotalStyle(): Partial<ExcelJS.Style> {
  return {
    font: { bold: true, size: 11 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
    numFmt: '#,##0.##',
  };
}

function solidFill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: 'thin' as const };
  return { top: side, left: side, bottom: side, right: side };
}

function applyStyle(cell: ExcelJS.Cell, style: Partial<ExcelJS.Style>) {
  if (style.font) cell.font = style.font as ExcelJS.Font;
  if (style.fill) cell.fill = style.fill as ExcelJS.Fill;
  if (style.alignment) cell.alignment = style.alignment as ExcelJS.Alignment;
  if (style.border) cell.border = style.border as ExcelJS.Borders;
  if (style.numFmt) cell.numFmt = style.numFmt;
}

export function getPayslipValues(
  line: LineWithEmployee,
  payroll: PayrollWithLines,
  serialNo: number,
): {
  periodLabel: string;
  branchName: string;
  paymentMethod: string;
  employeeCode: string | number;
  employeeName: string;
  position: string;
  serial: number;
  deductionRows: [number | string, string][];
  earningRows: [number | string, string][];
  excelTotalDeductions: number;
  excelNet: number;
} {
  const emp = line.employee;
  let basic = line.basicSalary || emp?.basicSalary || 0;
  if (!basic && line.workingDays && line.workDaysSalary) {
    basic = round2((line.workDaysSalary / line.workingDays) * 30);
  }
  const dailyRate = basic / 30;
  const socIns = emp?.insuranceSalary || line.socialInsurance || 0;
  const medIns = emp?.medicalInsuranceSalary || line.medicalInsurance || 0;
  // Same money cells as Payroll Excel export (not stale stored totalDeductions).
  const excelTotals = computePayrollLineExcelTotals(line);
  const lateMoney = round2(line.lateDeduction || 0);
  const lateDays = dailyRate && lateMoney ? round2(lateMoney / dailyRate) : line.lateDeductibleDays || 0;
  const lateCheckoutMoney = round2(line.lateCheckoutDeduction || 0);
  const lateCheckoutDays = dailyRate && lateCheckoutMoney ? round2(lateCheckoutMoney / dailyRate) : 0;
  // Payroll sheet uses punchDeductionCheckin only (same as computePayrollLineExcelTotals).
  const punchMoney = round2(line.punchDeductionCheckin || 0);
  const sickMoney = round2(line.sickDeduction || 0);
  const absentMoney = exportedAbsentDeduction(
    {
      absentDeduction: line.absentDeduction,
      absentCount: line.absentCount,
      absentDays: line.absentDays,
      isManual: line.isManual,
    },
    dailyRate,
  );
  const absentCount = exportedAbsentCount(line);
  const penaltyVal = round2(
    (dailyRate * (line.adminDeduction || 0)) + (line.penaltyDeductionValue || 0),
  );
  const paymentMethod = payrollPaymentMethod(line);
  const branchName = (payroll.shiftGrid?.location?.name || '').trim();
  let periodLabel = monthYearLabel(payroll.dateTo || payroll.dateFrom);
  if (periodLabel) periodLabel = `${periodLabel} Payroll`;
  if (branchName) periodLabel = periodLabel ? `${periodLabel} - ${branchName}` : branchName;

  const deductionRows: [number | string, string][] = [
    [round2(socIns), 'تأمينات اجتماعية'],
    [round2(medIns), 'تأمين طبي'],
    [lateDays, 'خصم التأخير'],
    [lateMoney, 'قيمة خصم التأخير'],
    [round2(line.singlePunchCount || 0), 'عدم بصمة'],
    [punchMoney, 'قيمة تكرار البصمة'],
    [lateCheckoutDays, 'تأخير الانصراف'],
    [lateCheckoutMoney, 'قيمة تأخير الانصراف'],
    [round2(line.sickDayCount || 0), 'أيام الإجازة المرضية'],
    [sickMoney, 'قيمة الإجازة المرضية'],
    [absentCount, 'غياب بدون إذن'],
    [absentMoney, 'خصم الغياب'],
    [round2(line.adminDeduction || 0), 'خصم اداري'],
    [penaltyVal, 'قيمة خصم الجزاء'],
    [round2(line.advanceLongTotal || 0), 'قسط سلفة طويلة الاجل'],
    [round2(line.advanceShortTotal || 0), 'سلف من الراتب'],
    [round2(line.groupedChecks || 0), 'شيكات مجمعه'],
    [round2(line.deductionChecks || 0), 'شيكات شخصيه'],
    [round2(line.manualDebit || 0), 'مانيول ديبت'],
    [round2(line.healthCertificatesDeduction || 0), 'شهادات صحيه'],
    [round2(line.fractionDeduction || 0), 'كسر'],
    [round2(line.fines || 0), 'خصومات'],
    [round2(line.documentsDeduction || 0), 'خصم اوراق'],
    [round2(line.previousSettlements || 0), 'تسويات رواتب سابقة'],
    [round2(line.previousInsurance || 0), 'تسويات تأمينات'],
  ];

  const earningRows: [number | string, string][] = [
    [round2(basic), 'أساسي'],
    [round2(line.workDaysSalary || 0), 'الراتب'],
    [round2(dailyRate), 'قيمة اليوم'],
    [round2(line.workingDays || 0), 'أيام العمل'],
    [round2(line.overtimeHours || 0), 'الإضافي'],
    [round2((line.workingDays || 0) + (line.overtimeHours || 0)), 'إجمالي أيام العمل'],
    [round2(excelTotals.totalEarnings), 'الإجمالي'],
    ['-', 'تسويات رواتب سابقة'],
    [round2(socIns), 'تأمينات الشركة'],
    [round2(excelTotals.totalEarnings), 'المستحق'],
  ];

  return {
    periodLabel,
    branchName,
    paymentMethod,
    employeeCode: line.employeeCode || emp?.code || 0,
    employeeName: emp?.name || '',
    position: line.positionName || emp?.jobTitle || '',
    serial: serialNo,
    deductionRows,
    earningRows,
    // Footer must match Payroll Excel «إجمالي الخصومات» / «صافي» — not DB totalDeductions.
    excelTotalDeductions: excelTotals.totalDeductions,
    excelNet: excelTotals.net,
  };
}

export function writePayslipsSheet(workbook: ExcelJS.Workbook, payroll: PayrollWithLines) {
  // Odoo sheet name: Payslip — A4, one employee per printed page.
  const sheet = workbook.addWorksheet('Payslip');
  sheet.views = [{ rightToLeft: true }];
  sheet.pageSetup = {
    paperSize: 9,
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };

  const hdrBlue: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 10, color: { argb: 'FFFFFFFF' } },
    fill: solidFill('FF8FB0D6'),
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  const hdrBlueLabel: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 9, color: { argb: 'FF3F6EA5' } },
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  const empFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 11 },
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  const lblFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 10 },
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  const valFmt: Partial<ExcelJS.Style> = {
    font: { size: 10 },
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
    numFmt: '#,##0.##',
  };
  const greyFill: Partial<ExcelJS.Style> = {
    fill: solidFill('FFF5F5F5'),
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
  };

  sheet.getColumn(1).width = 11;
  sheet.getColumn(2).width = 26;
  sheet.getColumn(3).width = 11;
  sheet.getColumn(4).width = 26;

  let row = 1;
  const sorted = [...payroll.lines].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

  for (let i = 0; i < sorted.length; i++) {
    const line = sorted[i];
    const v = getPayslipValues(line, payroll, line.sequence || i + 1);
    const maxRows = Math.max(v.deductionRows.length, v.earningRows.length);

    sheet.mergeCells(row, 1, row, 4);
    applyStyle(sheet.getCell(row, 1), { font: { bold: true, size: 16, color: { argb: 'FF3F6EA5' } } });
    sheet.getCell(row, 1).value = 'PAYSLIP';
    row++;

    applyStyle(sheet.getCell(row, 1), hdrBlueLabel);
    sheet.getCell(row, 1).value = 'Serial';
    applyStyle(sheet.getCell(row, 2), valFmt);
    sheet.getCell(row, 2).value = v.serial;
    applyStyle(sheet.getCell(row, 3), hdrBlueLabel);
    sheet.getCell(row, 3).value = 'Code';
    applyStyle(sheet.getCell(row, 4), valFmt);
    sheet.getCell(row, 4).value = v.employeeCode;
    row++;

    sheet.mergeCells(row, 1, row, 2);
    applyStyle(sheet.getCell(row, 1), hdrBlue);
    sheet.getCell(row, 1).value = v.periodLabel;
    sheet.mergeCells(row, 3, row, 4);
    applyStyle(sheet.getCell(row, 3), hdrBlue);
    sheet.getCell(row, 3).value = 'EMPLOYEE INFORMATION';
    row++;

    applyStyle(sheet.getCell(row, 1), empFmt);
    sheet.getCell(row, 1).value = v.paymentMethod;
    applyStyle(sheet.getCell(row, 2), hdrBlueLabel);
    sheet.getCell(row, 2).value = 'طريقة الدفع';
    sheet.mergeCells(row, 3, row, 4);
    applyStyle(sheet.getCell(row, 3), empFmt);
    sheet.getCell(row, 3).value = v.employeeName;
    row++;

    sheet.mergeCells(row, 1, row, 2);
    applyStyle(sheet.getCell(row, 1), empFmt);
    sheet.getCell(row, 1).value = v.branchName || '';
    applyStyle(sheet.getCell(row, 3), hdrBlueLabel);
    sheet.getCell(row, 3).value = 'الوظيفة';
    applyStyle(sheet.getCell(row, 4), empFmt);
    sheet.getCell(row, 4).value = v.position;
    row++;

    sheet.mergeCells(row, 1, row, 2);
    applyStyle(sheet.getCell(row, 1), lblFmt);
    sheet.getCell(row, 1).value = 'الاستقطاعات';
    sheet.mergeCells(row, 3, row, 4);
    applyStyle(sheet.getCell(row, 3), lblFmt);
    sheet.getCell(row, 3).value = 'الاستحقاقات';
    row++;

    for (let r = 0; r < maxRows; r++) {
      if (r < v.deductionRows.length) {
        const [dVal, dLbl] = v.deductionRows[r];
        applyStyle(sheet.getCell(row, 1), valFmt);
        sheet.getCell(row, 1).value = dVal;
        applyStyle(sheet.getCell(row, 2), lblFmt);
        sheet.getCell(row, 2).value = dLbl;
      } else {
        sheet.mergeCells(row, 1, row, 2);
        applyStyle(sheet.getCell(row, 1), greyFill);
      }
      if (r < v.earningRows.length) {
        const [eVal, eLbl] = v.earningRows[r];
        applyStyle(sheet.getCell(row, 3), valFmt);
        sheet.getCell(row, 3).value = eVal;
        applyStyle(sheet.getCell(row, 4), lblFmt);
        sheet.getCell(row, 4).value = eLbl;
      } else {
        sheet.mergeCells(row, 3, row, 4);
        applyStyle(sheet.getCell(row, 3), greyFill);
      }
      row++;
    }

    applyStyle(sheet.getCell(row, 1), { ...valFmt, font: { bold: true, size: 11 } });
    sheet.getCell(row, 1).value = v.excelTotalDeductions;
    applyStyle(sheet.getCell(row, 2), lblFmt);
    sheet.getCell(row, 2).value = 'إجمالي الخصم';
    sheet.mergeCells(row, 3, row, 4);
    applyStyle(sheet.getCell(row, 3), greyFill);
    row++;

    applyStyle(sheet.getCell(row, 1), {
      ...valFmt,
      font: {
        bold: true,
        size: 12,
        ...(v.excelNet < 0 ? { color: { argb: 'FF9C0006' } } : {}),
      },
      border: { top: { style: 'medium' }, left: { style: 'medium' }, bottom: { style: 'medium' }, right: { style: 'medium' } },
    });
    sheet.getCell(row, 1).value = v.excelNet;
    sheet.mergeCells(row, 2, row, 4);
    applyStyle(sheet.getCell(row, 2), {
      ...lblFmt,
      font: { bold: true, size: 12 },
      border: { top: { style: 'medium' }, left: { style: 'medium' }, bottom: { style: 'medium' }, right: { style: 'medium' } },
    });
    sheet.getCell(row, 2).value = 'إجمالي الراتب';
    if (i < sorted.length - 1) {
      sheet.getRow(row).addPageBreak();
    }
    row += 3;
  }

  if (!sorted.length) {
    sheet.getCell(1, 1).value = 'لا توجد سطور رواتب';
  }
}

/** Payslip-only workbook — same cells as the Payslip tab on تصدير Excel. */
export async function exportPayslipsXlsx(
  payrollId: string,
): Promise<{ base64: string; filename: string }> {
  const payroll = await loadPayrollForExport(payrollId);
  if (!payroll.lines.length) throw new NotFoundError('لا توجد سطور رواتب');

  const workbook = new ExcelJS.Workbook();
  writePayslipsSheet(workbook, payroll);
  return {
    base64: await workbookToBase64(workbook),
    filename: buildPayslipsXlsxFilename(payroll),
  };
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

export async function exportPayrollXlsx(
  payrollId: string,
): Promise<{ base64: string; filename: string }> {
  const payroll = await loadPayrollForExport(payrollId);
  if (!payroll.lines.length) throw new NotFoundError('لا توجد سطور رواتب');

  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = true;
  const sheet = workbook.addWorksheet('Payroll');
  const lastCol = COLUMNS.length - 1;

  sheet.views = [{ rightToLeft: true, state: 'frozen', xSplit: 2, ySplit: 5 }];

  for (let i = 0; i < COLUMNS.length; i++) {
    sheet.getColumn(i + 1).width = COLUMNS[i].width;
  }

  const titleFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 14, color: { argb: 'FFFF0000' } },
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  const periodFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 11, color: { argb: 'FFFF0000' } },
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  const earningsHdr: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 11, color: { argb: 'FFFFFFFF' } },
    fill: solidFill('FF00B050'),
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  const deductionsHdr: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 11, color: { argb: 'FFFFFFFF' } },
    fill: solidFill('FFFF0000'),
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  const colHeaderFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 9 },
    fill: solidFill('FFD9E1F2'),
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
  };
  const cellFmt: Partial<ExcelJS.Style> = {
    font: { size: 9 },
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
    numFmt: '#,##0.##',
  };
  const moneyFmt: Partial<ExcelJS.Style> = { ...cellFmt };
  const greenMoneyFmt: Partial<ExcelJS.Style> = { ...moneyFmt, fill: solidFill('FFC6EFCE') };
  const redMoneyFmt: Partial<ExcelJS.Style> = {
    ...moneyFmt,
    fill: solidFill('FFFFC7CE'),
    font: { size: 9, color: { argb: 'FF9C0006' } },
  };
  const editableFmt: Partial<ExcelJS.Style> = { ...moneyFmt, fill: solidFill('FFFFFACD') };
  const editableNonzeroFmt: Partial<ExcelJS.Style> = {
    ...moneyFmt,
    fill: solidFill('FFFFD700'),
    font: { size: 9, color: { argb: 'FF9C0006' } },
  };
  const resignedCellFmt: Partial<ExcelJS.Style> = {
    ...cellFmt,
    fill: solidFill('FFF4B942'),
    font: { size: 9, color: { argb: 'FF7B3F00' }, italic: true },
  };
  const resignedMoneyFmt: Partial<ExcelJS.Style> = { ...resignedCellFmt, numFmt: '#,##0.##' };
  const manualCellFmt: Partial<ExcelJS.Style> = {
    ...cellFmt,
    fill: solidFill('FFBDD7EE'),
    font: { size: 9, color: { argb: 'FF1F4E79' } },
  };
  const manualMoneyFmt: Partial<ExcelJS.Style> = { ...manualCellFmt, numFmt: '#,##0.##' };
  const totalFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 10 },
    fill: solidFill('FFD9E1F2'),
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
    numFmt: '#,##0.##',
  };
  const keyFmt: Partial<ExcelJS.Style> = {
    font: { size: 1, color: { argb: 'FFFFFFFF' } },
    fill: solidFill('FFFFFFFF'),
  };

  const periodDate = payroll.dateTo || payroll.dateFrom;
  const branchName = (payroll.shiftGrid?.location?.name || '').trim();
  let titleText = `${monthYearLabel(periodDate)} Payroll`;
  if (branchName) titleText += ` - ${branchName}`;
  sheet.mergeCells(1, 1, 1, lastCol + 1);
  applyStyle(sheet.getCell(1, 1), titleFmt);
  sheet.getCell(1, 1).value = titleText;

  sheet.mergeCells(2, 1, 2, lastCol + 1);
  applyStyle(sheet.getCell(2, 1), periodFmt);
  sheet.getCell(2, 1).value = `Pay Period: ${payroll.dateFrom.toISOString().slice(0, 10)} To ${payroll.dateTo.toISOString().slice(0, 10)}`;

  sheet.mergeCells(3, EARNINGS_START + 1, 3, EARNINGS_END + 1);
  applyStyle(sheet.getCell(3, EARNINGS_START + 1), earningsHdr);
  sheet.getCell(3, EARNINGS_START + 1).value = 'الاستحقاقات/EARNINGS';
  sheet.mergeCells(3, DEDUCTIONS_START + 1, 3, DEDUCTIONS_END + 1);
  applyStyle(sheet.getCell(3, DEDUCTIONS_START + 1), deductionsHdr);
  sheet.getCell(3, DEDUCTIONS_START + 1).value = 'الاستقطاعات/DEDUCTIONS';

  for (let c = 0; c < COLUMNS.length; c++) {
    const cell = sheet.getCell(4, c + 1);
    applyStyle(cell, colHeaderFmt);
    cell.value = COLUMNS[c].header;
  }
  sheet.getRow(4).height = 35;

  for (let c = 0; c < COLUMNS.length; c++) {
    const cell = sheet.getCell(5, c + 1);
    applyStyle(cell, keyFmt);
    cell.value = COLUMNS[c].key;
  }
  sheet.getRow(5).height = 3;

  const tot: Record<number, number> = {
    6: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0, 17: 0,
    18: 0, 19: 0, 20: 0, 21: 0, 22: 0, 23: 0, 24: 0, 25: 0, 26: 0, 27: 0, 28: 0,
    29: 0, 30: 0, 31: 0, 32: 0, 33: 0, 34: 0, 35: 0, 37: 0, 38: 0,
  };

  const sortedLines = [...payroll.lines].sort((a, b) => {
    const rank = (l: LineWithEmployee) =>
      isResignedLine(l) ? 2 : l.isManual ? 1 : 0;
    const ar = rank(a);
    const br = rank(b);
    if (ar !== br) return ar - br;
    return (a.sequence || 0) - (b.sequence || 0);
  });

  let row = DATA_START_ROW;
  for (const line of sortedLines) {
    const emp = line.employee;
    const resigned = isResignedLine(line);
    const manual = Boolean(line.isManual) && !resigned;
    const cf = resigned ? resignedCellFmt : manual ? manualCellFmt : cellFmt;
    const mf = resigned ? resignedMoneyFmt : manual ? manualMoneyFmt : moneyFmt;
    const gf = resigned ? resignedMoneyFmt : manual ? manualMoneyFmt : greenMoneyFmt;
    const ef = resigned ? resignedMoneyFmt : manual ? manualMoneyFmt : editableFmt;
    const enf = resigned ? resignedMoneyFmt : manual ? manualMoneyFmt : editableNonzeroFmt;

    let basic = line.basicSalary || emp?.basicSalary || 0;
    if (!basic && line.workingDays && line.workDaysSalary) {
      basic = round2((line.workDaysSalary / line.workingDays) * 30);
    }
    const dailyRate = basic / 30;

    const xlRow = row;
    // Odoo column letters (0-based indices match payroll_xlsx.py)
    const colBasic = 'G';
    const colWdays = 'H';
    const colOhours = 'I';
    const colWds = 'J';
    const colOa = 'K';
    const colTe = 'L';
    const colLate = 'O';
    const colLateVal = 'P';
    const colPunch = 'Q';
    const colPunchVal = 'R';
    const colLateCheckout = 'S';
    const colSickCount = 'U';
    const colAbs = 'W';
    const colAdmin = 'Y';
    const colLta = 'AA';
    const colSa = 'AB';
    const colDc = 'AC';
    const colMd = 'AD';
    const colHcd = 'AE';
    const colFd = 'AF';
    const colFi = 'AG';
    const colDd = 'AH';
    const colTotded = 'AI';
    const colNet = 'AJ';
    const colFawryV = 'AK';
    const colFcomm = 'AL';
    const dailyExpr = dailyRateExpr(colBasic, colWdays, colWds, xlRow);

    let col = 0;
    const writeCell = (value: ExcelJS.CellValue, style: Partial<ExcelJS.Style>) => {
      const cell = sheet.getCell(row, col + 1);
      applyStyle(cell, style);
      cell.value = value;
      col++;
    };
    const writeFormula = (
      formula: string,
      result: number,
      style: Partial<ExcelJS.Style>,
    ) => {
      const cell = sheet.getCell(row, col + 1);
      applyStyle(cell, style);
      // Style first, then formula — ExcelJS can drop <f> when fill is applied after.
      cell.value = {
        formula,
        result: Number.isFinite(result) ? result : 0,
      };
      col++;
    };

    writeCell(line.employeeCode || emp?.code || '', cf);
    writeCell(resigned ? `★ ${emp?.name ?? ''}` : emp?.name ?? '', cf);
    writeCell(line.departmentName || emp?.department?.name || '', cf);
    writeCell(line.positionName || emp?.jobTitle || '', cf);
    writeCell(formatDate(emp?.hiringDate), cf);
    writeCell(formatDate(emp?.departureDate), cf);
    writeCell(basic, mf);
    writeCell(line.workingDays, ef);
    writeCell(line.overtimeHours || 0, ef);

    tot[6] += basic || 0;
    tot[8] += line.overtimeHours || 0;

    let workDaysSal = line.workDaysSalary;
    let overtimeAmt = line.overtimeAmount;
    let totalEarn = line.totalEarnings || line.grossSalary;
    if (!line.basicSalary && basic) {
      workDaysSal = round2(dailyRate * (line.workingDays || 0));
      overtimeAmt = round2(dailyRate * (line.overtimeHours || 0));
      totalEarn = round2(workDaysSal + overtimeAmt);
    }

    if (!manual) {
      writeFormula(`ROUND(${colBasic}${xlRow}/30*${colWdays}${xlRow},2)`, workDaysSal, gf);
      writeFormula(`ROUND(${colBasic}${xlRow}/30*${colOhours}${xlRow},2)`, overtimeAmt, gf);
    } else {
      // Keep imported money; still use SUM formulas for totals below.
      writeCell(workDaysSal, gf);
      writeCell(overtimeAmt, gf);
    }
    writeFormula(`ROUND(${colWds}${xlRow}+${colOa}${xlRow},2)`, totalEarn, gf);

    tot[9] += workDaysSal || 0;
    tot[10] += overtimeAmt || 0;
    tot[11] += totalEarn || 0;

    const socialIns = emp?.insuranceSalary || line.socialInsurance || 0;
    const medicalIns = emp?.medicalInsuranceSalary || line.medicalInsurance || 0;
    const lateVal = line.lateDeduction || 0;
    const lateDaysVal =
      line.lateDeductibleDays ??
      (dailyRate && lateVal ? round2(lateVal / dailyRate) : 0);
    const punchRepVal = line.punchDeductionCheckin || 0;
    const singlePunchCount = line.singlePunchCount ?? 0;
    const lateCheckoutMoney = line.lateCheckoutDeduction || line.earlyDeduction || 0;
    const lateCheckoutDaysVal =
      dailyRate && lateCheckoutMoney ? round2(lateCheckoutMoney / dailyRate) : 0;
    const sickDedVal = line.sickDeduction || 0;
    const sickDaysCountVal = line.sickDayCount ?? 0;
    const absentCountVal = exportedAbsentCount(line);
    const absentDedVal = exportedAbsentDeduction(line, dailyRate);
    const penaltyVal = round2(dailyRate * (line.adminDeduction || 0) + (line.penaltyDeductionValue || 0));

    const dedMoney = (val: number) => (resigned ? resignedMoneyFmt : val > 0 ? redMoneyFmt : mf);
    /** Days×rate money stays literal on manual rows so imported amounts are not overwritten. */
    const literalDed = manual;

    writeCell(socialIns, dedMoney(socialIns));
    writeCell(medicalIns, dedMoney(medicalIns));
    writeCell(lateDaysVal, ef);
    if (literalDed) {
      writeCell(lateVal, dedMoney(lateVal));
    } else {
      writeFormula(`ROUND(${dailyExpr}*${colLate}${xlRow},2)`, lateVal, dedMoney(lateVal));
    }
    writeCell(singlePunchCount, ef);
    if (literalDed) {
      writeCell(punchRepVal, dedMoney(punchRepVal));
    } else {
      writeFormula(`ROUND(${dailyExpr}*${colPunch}${xlRow},2)`, punchRepVal, dedMoney(punchRepVal));
    }
    writeCell(lateCheckoutDaysVal, ef);
    if (literalDed) {
      writeCell(lateCheckoutMoney, dedMoney(lateCheckoutMoney));
    } else {
      writeFormula(`ROUND(${dailyExpr}*${colLateCheckout}${xlRow},2)`, lateCheckoutMoney, dedMoney(lateCheckoutMoney));
    }
    writeCell(sickDaysCountVal, ef);
    if (literalDed) {
      writeCell(sickDedVal, dedMoney(sickDedVal));
    } else {
      writeFormula(`ROUND(${dailyExpr}*${colSickCount}${xlRow},2)`, sickDedVal, dedMoney(sickDedVal));
    }
    writeCell(absentCountVal, ef);
    if (literalDed) {
      writeCell(absentDedVal, dedMoney(absentDedVal));
    } else {
      writeFormula(`ROUND(${dailyExpr}*${colAbs}${xlRow},2)`, absentDedVal, dedMoney(absentDedVal));
    }
    writeCell(line.adminDeduction || 0, line.adminDeduction ? enf : ef);
    if (literalDed) {
      writeCell(penaltyVal, dedMoney(penaltyVal));
    } else {
      writeFormula(
        `ROUND(${dailyExpr}*${colAdmin}${xlRow},2)+${line.penaltyDeductionValue || 0}`,
        penaltyVal,
        dedMoney(penaltyVal),
      );
    }
    writeCell(line.advanceLongTotal || 0, line.advanceLongTotal ? enf : ef);
    writeCell(line.advanceShortTotal || 0, line.advanceShortTotal ? enf : ef);
    writeCell(line.deductionChecks || 0, line.deductionChecks ? enf : ef);
    writeCell(line.manualDebit || 0, line.manualDebit ? enf : ef);
    writeCell(line.healthCertificatesDeduction || 0, line.healthCertificatesDeduction ? enf : ef);
    writeCell(line.fractionDeduction || 0, line.fractionDeduction ? enf : ef);
    writeCell(line.fines || 0, line.fines ? enf : ef);
    writeCell(line.documentsDeduction || 0, line.documentsDeduction ? enf : ef);

    const excelTotalDeductions = round2(
      socialIns + medicalIns + lateVal + punchRepVal + lateCheckoutMoney + sickDedVal +
      absentDedVal + penaltyVal + (line.advanceLongTotal || 0) + (line.advanceShortTotal || 0) +
      (line.deductionChecks || 0) + (line.manualDebit || 0) +
      (line.healthCertificatesDeduction || 0) + (line.fractionDeduction || 0) +
      (line.fines || 0) + (line.documentsDeduction || 0) +
      (line.groupedChecks || 0) + (line.previousSettlements || 0) +
      (line.previousInsurance || 0),
    );

    const extraHidden =
      (line.groupedChecks || 0) + (line.previousSettlements || 0) + (line.previousInsurance || 0);
    const extraTerm = extraHidden ? `+${round2(extraHidden)}` : '';
    const dedFormula =
      `ROUND(M${xlRow}+N${xlRow}+${colLateVal}${xlRow}+${colPunchVal}${xlRow}` +
      `+T${xlRow}+V${xlRow}+X${xlRow}+Z${xlRow}` +
      `+${colLta}${xlRow}+${colSa}${xlRow}+${colDc}${xlRow}+${colMd}${xlRow}` +
      `+${colHcd}${xlRow}+${colFd}${xlRow}+${colFi}${xlRow}+${colDd}${xlRow}` +
      `${extraTerm},2)`;

    const excelNet = round2(totalEarn - excelTotalDeductions);
    const netFmt =
      excelNet < 0 ? (resigned ? resignedMoneyFmt : redMoneyFmt) : resigned ? resignedMoneyFmt : gf;
    writeFormula(dedFormula, excelTotalDeductions, dedMoney(excelTotalDeductions));
    writeFormula(
      `ROUND(${colTe}${xlRow}-${colTotded}${xlRow},2)`,
      excelNet,
      netFmt,
    );

    const hasFawry = payrollPaymentMethod(line) === 'فوري';
    writeCell(hasFawry ? 'فوري' : 'كاش', cf);
    const fawryCommission = hasFawry ? round2(excelNet * 0.0015) : 0;
    writeFormula(
      `IF(${colFawryV}${xlRow}="فوري",ROUND(${colNet}${xlRow}*0.0015,2),0)`,
      fawryCommission,
      fawryCommission > 0 ? (resigned ? resignedMoneyFmt : redMoneyFmt) : mf,
    );
    const grandTotal = round2(excelNet + fawryCommission);
    const grandFmt =
      grandTotal < 0 ? (resigned ? resignedMoneyFmt : redMoneyFmt) : resigned ? resignedMoneyFmt : gf;
    writeFormula(`ROUND(${colNet}${xlRow}+${colFcomm}${xlRow},2)`, grandTotal, grandFmt);

    const empLocation =
      line.employeeLocation ||
      payroll.shiftGrid?.location?.name ||
      emp?.workLocation?.name ||
      emp?.location ||
      '';
    writeCell(empLocation, cf);

    tot[12] += socialIns || 0;
    tot[13] += medicalIns || 0;
    tot[14] += lateDaysVal || 0;
    tot[15] += lateVal || 0;
    tot[16] += singlePunchCount || 0;
    tot[17] += punchRepVal || 0;
    tot[18] += lateCheckoutDaysVal || 0;
    tot[19] += lateCheckoutMoney || 0;
    tot[20] += sickDaysCountVal || 0;
    tot[21] += sickDedVal || 0;
    tot[22] += absentCountVal || 0;
    tot[23] += absentDedVal || 0;
    tot[24] += line.adminDeduction || 0;
    tot[25] += penaltyVal || 0;
    tot[26] += line.advanceLongTotal || 0;
    tot[27] += line.advanceShortTotal || 0;
    tot[28] += line.deductionChecks || 0;
    tot[29] += line.manualDebit || 0;
    tot[30] += line.healthCertificatesDeduction || 0;
    tot[31] += line.fractionDeduction || 0;
    tot[32] += line.fines || 0;
    tot[33] += line.documentsDeduction || 0;
    tot[34] += excelTotalDeductions || 0;
    tot[35] += excelNet;
    tot[37] += fawryCommission || 0;
    tot[38] += grandTotal;

    row++;
  }

  const totalRow = row;
  const lastDataRow = totalRow - 1;
  // Odoo: AutoFilter on header row 4 through last data row (exclude totals).
  if (lastDataRow >= DATA_START_ROW) {
    sheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: lastDataRow, column: COLUMNS.length },
    };
  }

  for (let c = 0; c <= lastCol; c++) {
    const cell = sheet.getCell(totalRow, c + 1);
    if (c === 1) {
      applyStyle(cell, totalFmt);
      cell.value = 'الإجمالي';
    } else if (c in tot) {
      applyStyle(cell, totalFmt);
      if (lastDataRow >= DATA_START_ROW) {
        const letter = excelColLetter(c + 1);
        cell.value = {
          formula: `SUM(${letter}${DATA_START_ROW}:${letter}${lastDataRow})`,
          result: c === 8 ? tot[c] : round2(tot[c]),
        };
      } else {
        cell.value = c === 8 ? tot[c] : round2(tot[c]);
      }
    } else {
      applyStyle(cell, totalFmt);
      cell.value = '';
    }
  }

  if (payroll.lines.length <= 300) {
    writePayslipsSheet(workbook, payroll);
  } else {
    const payslipSheet = workbook.addWorksheet('Payslip');
    payslipSheet.views = [{ rightToLeft: true }];
    payslipSheet.getCell(1, 1).value =
      'Payslip: الكشف كبير جداً — قسّم الكشف لعرض المسيرات التفصيلية.';
  }

  return {
    base64: await workbookToBase64(workbook),
    filename: buildPayrollXlsxFilename(payroll),
  };
}

function lineNetForFawry(line: LineWithEmployee): number {
  return computeFawryGrandTotal(line);
}

export async function exportFawryXlsx(
  payrollId: string,
): Promise<{ base64: string; filename: string }> {
  const payroll = await loadPayrollForExport(payrollId);
  const fawryLines = payroll.lines.filter((l) => isFawryPayment(l));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Fawry');
  sheet.views = [{ rightToLeft: true }];

  const hdr = fawryHeaderStyle();
  const cellFmt: Partial<ExcelJS.Style> = {
    font: { size: 10 },
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  const moneyFmt: Partial<ExcelJS.Style> = { ...cellFmt, numFmt: '#,##0.##' };
  const totalFmt = fawryTotalStyle();

  sheet.getColumn(1).width = 20;
  sheet.getColumn(2).width = 18;
  sheet.getRow(1).height = 25;
  applyStyle(sheet.getCell(1, 1), hdr);
  sheet.getCell(1, 1).value = 'رقم التلفون';
  applyStyle(sheet.getCell(1, 2), hdr);
  sheet.getCell(1, 2).value = 'الإجمالي';

  let row = 2;
  let grand = 0;
  for (const line of fawryLines) {
    const total = computeFawryGrandTotal(line);
    applyStyle(sheet.getCell(row, 1), cellFmt);
    sheet.getCell(row, 1).value = fawryWorkPhone(line);
    applyStyle(sheet.getCell(row, 2), moneyFmt);
    sheet.getCell(row, 2).value = total;
    grand += total;
    sheet.getRow(row).height = 20;
    row++;
  }

  applyStyle(sheet.getCell(row, 1), totalFmt);
  sheet.getCell(row, 1).value = 'الإجمالي';
  applyStyle(sheet.getCell(row, 2), totalFmt);
  sheet.getCell(row, 2).value = round2(grand);
  sheet.getRow(row).height = 22;

  return {
    base64: await workbookToBase64(workbook),
    filename: buildFawryOnlyXlsxFilename(payroll),
  };
}

export async function exportCashFawryXlsx(
  payrollId: string,
): Promise<{ base64: string; filename: string }> {
  const payroll = await loadPayrollForExport(payrollId);
  if (!payroll.lines.length) throw new NotFoundError('لا توجد سطور رواتب');

  const sortedLines = [...payroll.lines].sort((a, b) => {
    const ar = isFawryPayment(a) ? 0 : isResignedLine(a) ? 2 : 1;
    const br = isFawryPayment(b) ? 0 : isResignedLine(b) ? 2 : 1;
    if (ar !== br) return ar - br;
    return (a.sequence || 0) - (b.sequence || 0);
  });
  const cashLines = sortedLines.filter((l) => !isFawryPayment(l));
  const fawryLines = sortedLines.filter((l) => isFawryPayment(l));

  const workbook = new ExcelJS.Workbook();
  const hdr = fawryHeaderStyle();
  const cellFmt: Partial<ExcelJS.Style> = {
    font: { size: 10 },
    border: thinBorder(),
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  const moneyFmt: Partial<ExcelJS.Style> = { ...cellFmt, numFmt: '#,##0.##' };
  const resignedCellFmt: Partial<ExcelJS.Style> = {
    ...cellFmt,
    fill: solidFill('FFF4B942'),
    font: { size: 10, color: { argb: 'FF7B3F00' }, italic: true },
  };
  const resignedMoneyFmt: Partial<ExcelJS.Style> = { ...resignedCellFmt, numFmt: '#,##0.##' };
  const totalFmt = fawryTotalStyle();

  const cashSheet = workbook.addWorksheet('كاش');
  cashSheet.views = [{ rightToLeft: true }];
  cashSheet.getColumn(1).width = 16;
  cashSheet.getColumn(2).width = 28;
  cashSheet.getColumn(3).width = 24;
  cashSheet.getColumn(4).width = 18;
  cashSheet.getRow(1).height = 25;
  for (const [i, label] of ['كود الموظف', 'اسم الموظف', 'الوظيفة', 'الإجمالي'].entries()) {
    applyStyle(cashSheet.getCell(1, i + 1), hdr);
    cashSheet.getCell(1, i + 1).value = label;
  }

  let cashRow = 2;
  let cashGrand = 0;
  for (const line of cashLines) {
    const resigned = isResignedLine(line);
    const cf = resigned ? resignedCellFmt : cellFmt;
    const mf = resigned ? resignedMoneyFmt : moneyFmt;
    const totals = computeLineTotals(line);
    cashGrand += totals.grandTotal;
    const name = resigned ? `★ ${line.employee?.name ?? ''}` : (line.employee?.name ?? '');
    applyStyle(cashSheet.getCell(cashRow, 1), cf);
    cashSheet.getCell(cashRow, 1).value = line.employeeCode || line.employee?.code || '';
    applyStyle(cashSheet.getCell(cashRow, 2), cf);
    cashSheet.getCell(cashRow, 2).value = name;
    applyStyle(cashSheet.getCell(cashRow, 3), cf);
    cashSheet.getCell(cashRow, 3).value = line.positionName || line.employee?.jobTitle || '';
    applyStyle(cashSheet.getCell(cashRow, 4), mf);
    cashSheet.getCell(cashRow, 4).value = totals.grandTotal;
    cashRow++;
  }
  applyStyle(cashSheet.getCell(cashRow, 1), totalFmt);
  cashSheet.getCell(cashRow, 1).value = 'الإجمالي';
  applyStyle(cashSheet.getCell(cashRow, 2), totalFmt);
  applyStyle(cashSheet.getCell(cashRow, 3), totalFmt);
  applyStyle(cashSheet.getCell(cashRow, 4), totalFmt);
  cashSheet.getCell(cashRow, 4).value = round2(cashGrand);

  const fawrySheet = workbook.addWorksheet('فوري');
  fawrySheet.views = [{ rightToLeft: true }];
  fawrySheet.getColumn(1).width = 16;
  fawrySheet.getColumn(2).width = 20;
  fawrySheet.getColumn(3).width = 25;
  fawrySheet.getColumn(4).width = 24;
  fawrySheet.getColumn(5).width = 18;
  fawrySheet.getRow(1).height = 25;
  for (const [i, label] of ['كود الموظف', 'رقم التلفون', 'اسم الموظف', 'الوظيفة', 'الإجمالي'].entries()) {
    applyStyle(fawrySheet.getCell(1, i + 1), hdr);
    fawrySheet.getCell(1, i + 1).value = label;
  }

  let fawryRow = 2;
  let fawryGrand = 0;
  for (const line of fawryLines) {
    const resigned = isResignedLine(line);
    const cf = resigned ? resignedCellFmt : cellFmt;
    const mf = resigned ? resignedMoneyFmt : moneyFmt;
    const totals = computeFawryGrandTotal(line);
    fawryGrand += totals;
    const name = resigned ? `★ ${line.employee?.name ?? ''}` : (line.employee?.name ?? '');
    applyStyle(fawrySheet.getCell(fawryRow, 1), cf);
    fawrySheet.getCell(fawryRow, 1).value = line.employeeCode || line.employee?.code || '';
    applyStyle(fawrySheet.getCell(fawryRow, 2), cf);
    fawrySheet.getCell(fawryRow, 2).value = fawryWorkPhone(line);
    applyStyle(fawrySheet.getCell(fawryRow, 3), cf);
    fawrySheet.getCell(fawryRow, 3).value = name;
    applyStyle(fawrySheet.getCell(fawryRow, 4), cf);
    fawrySheet.getCell(fawryRow, 4).value = line.positionName || line.employee?.jobTitle || '';
    applyStyle(fawrySheet.getCell(fawryRow, 5), mf);
    fawrySheet.getCell(fawryRow, 5).value = totals;
    fawryRow++;
  }
  applyStyle(fawrySheet.getCell(fawryRow, 1), totalFmt);
  fawrySheet.getCell(fawryRow, 1).value = 'الإجمالي';
  for (let c = 2; c <= 4; c++) applyStyle(fawrySheet.getCell(fawryRow, c), totalFmt);
  applyStyle(fawrySheet.getCell(fawryRow, 5), totalFmt);
  fawrySheet.getCell(fawryRow, 5).value = round2(fawryGrand);

  return {
    base64: await workbookToBase64(workbook),
    filename: buildCashFawryXlsxFilename(payroll),
  };
}

export function exportFileResponse(base64: string, filename: string) {
  return {
    file: base64,
    base64,
    filename,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

/**
 * Point-in-time resigned/archived state, reconstructed from archive timestamps.
 * Used when backfilling already-sent payrolls so the frozen «yellow» state matches
 * what the sheet looked like at Odoo send time (archives done later don't count).
 */
function resignedAsOfDate(
  emp: EmployeeProfile | null | undefined,
  asOf: Date,
): boolean {
  if (!emp) return false;
  // Start from the current resigned state; a restored (active) employee was not
  // yellow at send. Then drop anyone whose archive/departure happened *after* send.
  if (!isResigned(emp)) return false;
  if (emp.archivedAt && emp.archivedAt.getTime() > asOf.getTime()) return false;
  if (emp.departureDate && emp.departureDate.getTime() > asOf.getTime()) return false;
  return true;
}

/**
 * Lock Cash/Fawry + resigned(yellow) classification per payroll line.
 * - overwrite=true (confirm): always re-freeze from live employee state.
 * - overwrite=false (Odoo send / backfill): only fill nulls.
 * - ignoreResignation=true (backfill for already-sent): payment method uses
 *   hasFawryAccount only, so later archives don't pull people off Fawry.
 * - resignedAsOf: reconstruct the frozen resigned/yellow state as of this date
 *   (send time) instead of the live state — for backfilling already-sent sheets.
 */
export async function freezePayrollPaymentMethods(
  payrollId: string,
  options?: {
    overwrite?: boolean;
    ignoreResignation?: boolean;
    resignedAsOf?: Date | null;
  },
): Promise<number> {
  const overwrite = options?.overwrite === true;
  const ignoreResignation = options?.ignoreResignation === true;
  const resignedAsOf = options?.resignedAsOf ?? null;
  const lines = await prisma.payrollLine.findMany({
    where: { payrollId },
    include: { employee: true },
  });
  let updated = 0;
  for (const line of lines) {
    const data: { paymentMethod?: string; resignedFrozen?: boolean } = {};

    // Cash/Fawry
    if (overwrite || !line.paymentMethod) {
      const method = ignoreResignation
        ? hasFawryAccount(line) ? 'فوري' : 'كاش'
        : computeLivePaymentMethod(line);
      if (line.paymentMethod !== method) data.paymentMethod = method;
    }

    // Resigned / archived (yellow)
    const currentResigned = (line as { resignedFrozen?: boolean | null }).resignedFrozen;
    if (overwrite || currentResigned === null || currentResigned === undefined) {
      const resignedValue = resignedAsOf
        ? resignedAsOfDate(line.employee, resignedAsOf)
        : isResigned(line.employee);
      if (currentResigned !== resignedValue) data.resignedFrozen = resignedValue;
    }

    if (Object.keys(data).length === 0) continue;
    await prisma.payrollLine.update({
      where: { id: line.id },
      data,
    });
    updated += 1;
  }
  return updated;
}
