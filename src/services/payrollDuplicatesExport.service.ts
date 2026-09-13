/**
 * Odoo parity: biotime_payroll/reports/payroll_duplicates_xlsx.py
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

type PayrollBundle = {
  id: string;
  name: string | null;
  dateFrom: Date;
  dateTo: Date;
  deviceName: string;
  lines: LineWithEmployee[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function empKey(line: LineWithEmployee): string {
  return (line.employeeCode || '').trim().toLowerCase()
    || (line.employee?.name || '').trim().toLowerCase()
    || line.employeeId;
}

function isResigned(emp: EmployeeProfile | null | undefined): boolean {
  return Boolean(emp && (!emp.active || emp.departureDate));
}

/** Frozen-first, so a payroll already sent to Odoo keeps the state it was sent with. */
function lineResigned(line: LineWithEmployee): boolean {
  const frozen = (line as { resignedFrozen?: boolean | null }).resignedFrozen;
  if (frozen === true || frozen === false) return frozen;
  return isResigned(line.employee);
}

/** Frozen payment method wins; live flags are only the pre-freeze fallback. */
function lineIsFawry(line: LineWithEmployee): boolean {
  const frozen = String(line.paymentMethod ?? '').trim();
  if (frozen === 'فوري') return true;
  if (frozen === 'كاش') return false;
  return Boolean(line.employee?.hasFawryAccount) && !isResigned(line.employee);
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const s: ExcelJS.BorderStyle = 'thin';
  return { top: { style: s }, left: { style: s }, bottom: { style: s }, right: { style: s } };
}

function applyStyle(cell: ExcelJS.Cell, style: Partial<ExcelJS.Style>) {
  Object.assign(cell, { style: { ...cell.style, ...style } });
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

async function loadPayrollBundle(payrollId: string): Promise<PayrollBundle> {
  const payroll = await prisma.payroll.findUnique({
    where: { id: payrollId },
    include: {
      lines: {
        include: {
          employee: { include: { department: true, workLocation: true } },
        },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!payroll) throw new NotFoundError('Payroll not found');

  let deviceName = '';
  if (payroll.deviceId) {
    const device = await prisma.device.findUnique({ where: { id: payroll.deviceId } });
    deviceName = device?.name || device?.alias || '';
  }

  return {
    id: payroll.id,
    name: payroll.name,
    dateFrom: payroll.dateFrom,
    dateTo: payroll.dateTo,
    deviceName,
    lines: payroll.lines,
  };
}

type DupMeta = { count: number; types: Set<string> };

function buildDuplicateMeta(payrolls: PayrollBundle[]): Map<string, DupMeta> {
  const meta = new Map<string, DupMeta>();

  for (const payroll of payrolls) {
    const grouped = new Map<string, LineWithEmployee[]>();
    for (const line of payroll.lines) {
      const key = empKey(line);
      if (!key) continue;
      const list = grouped.get(key) ?? [];
      list.push(line);
      grouped.set(key, list);
    }
    for (const [key, lines] of grouped) {
      if (lines.length <= 1) continue;
      const mkey = `${payroll.id}::${key}`;
      const entry = meta.get(mkey) ?? { count: 0, types: new Set<string>() };
      entry.count = Math.max(entry.count, lines.length);
      entry.types.add('داخل نفس الكشف');
      meta.set(mkey, entry);
    }
  }

  const globalGrouped = new Map<string, Set<string>>();
  for (const payroll of payrolls) {
    for (const line of payroll.lines) {
      const key = empKey(line);
      if (!key) continue;
      const set = globalGrouped.get(key) ?? new Set<string>();
      set.add(payroll.id);
      globalGrouped.set(key, set);
    }
  }
  for (const [key, pidSet] of globalGrouped) {
    if (pidSet.size <= 1) continue;
    for (const pid of pidSet) {
      const mkey = `${pid}::${key}`;
      const entry = meta.get(mkey) ?? { count: 0, types: new Set<string>() };
      entry.count = Math.max(entry.count, pidSet.size);
      entry.types.add('بين الكشوف المحددة');
      meta.set(mkey, entry);
    }
  }

  return meta;
}

function lineRowValues(
  payroll: PayrollBundle,
  line: LineWithEmployee,
  duplicateType: string,
): (string | number)[] {
  const emp = line.employee;
  const resigned = lineResigned(line);
  let basic = line.basicSalary || emp?.basicSalary || 0;
  if (!basic && line.workingDays && line.workDaysSalary) {
    basic = round2((line.workDaysSalary / line.workingDays) * 30);
  }
  const daily = basic ? basic / 30 : 0;

  let workDaysSal: number;
  let overtimeAmt: number;
  let totalEarn: number;
  if (line.basicSalary) {
    workDaysSal = line.workDaysSalary || 0;
    overtimeAmt = line.overtimeAmount || 0;
    totalEarn = line.totalEarnings || 0;
  } else {
    workDaysSal = round2(daily * (line.workingDays || 0));
    overtimeAmt = round2(daily * (line.overtimeHours || 0));
    totalEarn = round2(workDaysSal + overtimeAmt);
  }

  const lateVal = round2(line.lateDeduction || 0);
  const punchRepVal = round2((line.punchDeductionCheckin || 0) + (line.punchDeductionCheckout || 0));
  const lateCheckoutMoney = round2(line.lateCheckoutDeduction || 0);
  const sickDedVal = round2(line.sickDeduction || 0);
  const absentDedVal = round2(line.absentDeduction || 0);
  const penaltyVal = round2((daily * (line.adminDeduction || 0)) + (line.penaltyDeductionValue || 0));
  const socialIns = (emp?.insuranceSalary && emp.insuranceSalary > 0) ? emp.insuranceSalary : (line.socialInsurance || 0);
  const medicalIns = (emp?.medicalInsuranceSalary && emp.medicalInsuranceSalary > 0)
    ? emp.medicalInsuranceSalary
    : (line.medicalInsurance || 0);

  const excelTotalDeductions = round2(
    socialIns + medicalIns + lateVal + punchRepVal + lateCheckoutMoney + sickDedVal
    + absentDedVal + penaltyVal + (line.advanceLongTotal || 0) + (line.advanceShortTotal || 0)
    + (line.deductionChecks || 0) + (line.manualDebit || 0)
    + (line.healthCertificatesDeduction || 0) + (line.fractionDeduction || 0)
    + (line.fines || 0) + (line.documentsDeduction || 0)
    + (line.groupedChecks || 0)
    + (line.previousSettlements || 0) + (line.previousInsurance || 0),
  );
  const excelNet = round2(totalEarn - excelTotalDeductions);
  const fawryCommission = lineIsFawry(line) ? round2(excelNet * 0.0015) : 0;
  const grandTotal = round2(excelNet + fawryCommission);

  const nameVal = resigned ? `★ ${line.employee?.name || ''}` : (line.employee?.name || '');
  const hiring = emp?.hiringDate ? emp.hiringDate.toISOString().slice(0, 10) : '';
  const departure = emp?.departureDate ? emp.departureDate.toISOString().slice(0, 10) : '';

  return [
    payroll.name || '',
    payroll.deviceName,
    duplicateType,
    line.employeeCode || '',
    nameVal,
    line.departmentName || emp?.department?.name || '',
    line.positionName || emp?.jobTitle || '',
    hiring,
    departure,
    basic,
    line.workingDays || 0,
    round2(line.overtimeHours || 0),
    workDaysSal,
    overtimeAmt,
    totalEarn,
    socialIns,
    medicalIns,
    line.lateDeduction || 0,
    lateVal,
    line.punchDeductionCheckin || 0,
    punchRepVal,
    line.lateCheckoutDeduction || 0,
    lateCheckoutMoney,
    line.sickDayCount || 0,
    sickDedVal,
    line.absentCount || line.absentDays || 0,
    absentDedVal,
    line.adminDeduction || 0,
    penaltyVal,
    line.advanceLongTotal || 0,
    line.advanceShortTotal || 0,
    line.deductionChecks || 0,
    line.manualDebit || 0,
    line.healthCertificatesDeduction || 0,
    line.fractionDeduction || 0,
    line.fines || 0,
    line.documentsDeduction || 0,
    excelTotalDeductions,
    excelNet,
    lineIsFawry(line) ? 'نعم' : 'لا',
    fawryCommission,
    grandTotal,
  ];
}

const HEADERS = [
  'مرجع كشف\nالرواتب', 'اسم البصمة', 'نوع التكرار',
  'كود\nالموظف', 'Employee Name', 'Department', 'Position',
  'Date Of\nJoining', 'Last\nWorking', 'Basic Salary', 'أيام العمل', 'عدد\nالإضافي',
  'راتب أيام\nالعمل', 'مبلغ\nالإضافي', 'إجمالي\nالاستحقاقات',
  'تأمينات\nاجتماعية', 'تأمين\nطبي', 'خصم\nالتأخير', 'قيمة خصم\nالتأخير',
  'عدم\nبصمة', 'قيمة تكرار\nالبصمة', 'تأخير\nالانصراف', 'قيمة تأخير\nالانصراف',
  'أيام الإجازة\nالمرضية', 'قيمة الإجازة\nالمرضية', 'غياب بدون\nإذن', 'خصم\nالغياب',
  'خصم\nاداري', 'قيمة خصم\nالجزاء', 'قسط سلفة\nطويلة الاجل', 'سلف من\nالراتب',
  'شيكات\nشخصية', 'مانيول\nديبت', 'شهادات\nصحية', 'كسر', 'خصومات', 'خصم\nاوراق',
  'إجمالي\nالاستقطاعات', 'صافي\nالراتب', 'Fawry', 'عمولة\nفوري', 'الإجمالي',
];

const EARNINGS_START = 12;
const EARNINGS_END = 14;
const DEDUCTIONS_START = 15;
const DEDUCTIONS_END = 36;

export async function exportPayrollDuplicatesXlsx(payrollId: string): Promise<string> {
  const primary = await loadPayrollBundle(payrollId);

  const samePeriod = await prisma.payroll.findMany({
    where: {
      dateFrom: primary.dateFrom,
      dateTo: primary.dateTo,
      id: { not: payrollId },
    },
    include: {
      lines: {
        include: {
          employee: { include: { department: true, workLocation: true } },
        },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      },
    },
  });

  const payrolls: PayrollBundle[] = [primary];
  for (const p of samePeriod) {
    let deviceName = '';
    if (p.deviceId) {
      const device = await prisma.device.findUnique({ where: { id: p.deviceId } });
      deviceName = device?.name || device?.alias || '';
    }
    payrolls.push({
      id: p.id,
      name: p.name,
      dateFrom: p.dateFrom,
      dateTo: p.dateTo,
      deviceName,
      lines: p.lines,
    });
  }

  const dupMeta = buildDuplicateMeta(payrolls);
  const empGroups = new Map<string, { payroll: PayrollBundle; line: LineWithEmployee; meta: DupMeta }[]>();

  for (const payroll of payrolls) {
    for (const line of payroll.lines) {
      const key = empKey(line);
      if (!key) continue;
      const mkey = `${payroll.id}::${key}`;
      const meta = dupMeta.get(mkey);
      if (!meta) continue;
      const list = empGroups.get(key) ?? [];
      list.push({ payroll, line, meta });
      empGroups.set(key, list);
    }
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Duplicates', { views: [{ rightToLeft: true }] });
  const lastCol = HEADERS.length;

  const titleFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 14, color: { argb: 'FFFF0000' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
  };
  const periodFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 11, color: { argb: 'FFFF0000' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
  };
  const earningsHdr: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 11, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B050' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
  };
  const deductionsHdr: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 11, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
  };
  const colHeaderFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 9 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    border: thinBorder(),
  };
  const cellFmt: Partial<ExcelJS.Style> = {
    font: { size: 9 },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
  };
  const moneyFmt: Partial<ExcelJS.Style> = { ...cellFmt, numFmt: '#,##0.##' };
  const greenMoneyFmt: Partial<ExcelJS.Style> = {
    ...moneyFmt,
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } },
  };
  const groupSepFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 10, color: { argb: 'FF7F6000' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } },
    alignment: { horizontal: 'right', vertical: 'middle' },
    border: thinBorder(),
  };
  const dupTypeFmt: Partial<ExcelJS.Style> = {
    font: { bold: true, size: 9, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: thinBorder(),
  };

  for (let i = 0; i < HEADERS.length; i++) {
    sheet.getColumn(i + 1).width = i < 3 ? 18 : 10;
  }

  const titles = payrolls.map((p) => p.name || '').join(' | ');
  sheet.mergeCells(1, 1, 1, lastCol);
  applyStyle(sheet.getCell(1, 1), titleFmt);
  sheet.getCell(1, 1).value = empGroups.size
    ? `تقرير الموظفين المكررين - ${titles}`
    : 'تقرير الموظفين المكررين';

  const dates = payrolls.map((p) => `${p.dateFrom.toISOString().slice(0, 10)} → ${p.dateTo.toISOString().slice(0, 10)}`).join(' | ');
  sheet.mergeCells(2, 1, 2, lastCol);
  applyStyle(sheet.getCell(2, 1), periodFmt);
  sheet.getCell(2, 1).value = `الفترة: ${dates}`;

  if (!empGroups.size) {
    sheet.mergeCells(4, 1, 4, lastCol);
    applyStyle(sheet.getCell(4, 1), cellFmt);
    sheet.getCell(4, 1).value = 'لا يوجد موظفون مكررون في الكشوف المحددة.';
    return workbookToBase64(workbook);
  }

  sheet.mergeCells(3, EARNINGS_START + 1, 3, EARNINGS_END + 1);
  applyStyle(sheet.getCell(3, EARNINGS_START + 1), earningsHdr);
  sheet.getCell(3, EARNINGS_START + 1).value = 'الاستحقاقات/EARNINGS';

  sheet.mergeCells(3, DEDUCTIONS_START + 1, 3, DEDUCTIONS_END + 1);
  applyStyle(sheet.getCell(3, DEDUCTIONS_START + 1), deductionsHdr);
  sheet.getCell(3, DEDUCTIONS_START + 1).value = 'الاستقطاعات/DEDUCTIONS';

  for (let c = 0; c < HEADERS.length; c++) {
    applyStyle(sheet.getCell(4, c + 1), colHeaderFmt);
    sheet.getCell(4, c + 1).value = HEADERS[c];
  }
  sheet.getRow(4).height = 35;

  let row = 6;
  for (const empKeySorted of [...empGroups.keys()].sort()) {
    const entries = empGroups.get(empKeySorted)!;
    const firstLine = entries[0].line;
    const sepLabel = `▶  ${firstLine.employee?.name || empKeySorted}  —  ${entries.length} سجلات مكررة`;
    sheet.mergeCells(row, 1, row, lastCol);
    applyStyle(sheet.getCell(row, 1), groupSepFmt);
    sheet.getCell(row, 1).value = sepLabel;
    row++;

    for (const { payroll, line, meta } of entries) {
      const duplicateType = [...meta.types].sort().join(' + ');
      const values = lineRowValues(payroll, line, duplicateType);
      for (let c = 0; c < values.length; c++) {
        const cell = sheet.getCell(row, c + 1);
        const v = values[c];
        if (c === 2) {
          applyStyle(cell, dupTypeFmt);
        } else if (c >= EARNINGS_START && c <= EARNINGS_END) {
          applyStyle(cell, greenMoneyFmt);
        } else if (typeof v === 'number' && c >= 9) {
          applyStyle(cell, moneyFmt);
        } else {
          applyStyle(cell, cellFmt);
        }
        cell.value = v;
      }
      row++;
    }
  }

  sheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: 5, xSplit: 3 }];
  return workbookToBase64(workbook);
}
