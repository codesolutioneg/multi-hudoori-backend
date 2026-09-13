/**
 * Odoo parity: biotime_payroll/models/payroll_duplicate_and_move.py (core actions)
 */
import { PayrollState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { refreshPayrollHeaderTotals, addExcludedPayrollEmployees } from './payrollLine.service';

export type DuplicateRow = {
  lineId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  duplicateType: 'in_payroll' | 'other_payroll_same_period';
  duplicateCount: number;
  otherPayrollId?: string;
  otherPayrollName?: string;
  note: string;
};

function lineKey(line: {
  id: string;
  employeeId: string;
  employeeCode: string | null;
  employee?: { name?: string | null } | null;
}): string {
  return line.employeeId || line.employeeCode?.trim().toLowerCase() || line.id;
}

export async function listPayrollDuplicates(payrollId: string): Promise<DuplicateRow[]> {
  const payroll = await prisma.payroll.findUnique({
    where: { id: payrollId },
    include: { lines: { include: { employee: true } } },
  });
  if (!payroll) throw new NotFoundError('Payroll not found');

  const rows: DuplicateRow[] = [];
  const grouped = new Map<string, typeof payroll.lines>();

  for (const line of payroll.lines) {
    const k = lineKey(line);
    const list = grouped.get(k) ?? [];
    list.push(line);
    grouped.set(k, list);
  }

  for (const [, lines] of grouped) {
    if (lines.length > 1) {
      for (const line of lines) {
        rows.push({
          lineId: line.id,
          employeeId: line.employeeId,
          employeeCode: line.employeeCode ?? '',
          employeeName: line.employee?.name ?? '',
          duplicateType: 'in_payroll',
          duplicateCount: lines.length,
          note: `مكرر ${lines.length} مرات داخل الكشف`,
        });
      }
    }
  }

  for (const line of payroll.lines) {
    const others = await prisma.payrollLine.findMany({
      where: {
        employeeId: line.employeeId,
        payrollId: { not: payrollId },
        payroll: {
          dateFrom: payroll.dateFrom,
          dateTo: payroll.dateTo,
        },
      },
      include: { payroll: true },
    });
    for (const other of others) {
      rows.push({
        lineId: line.id,
        employeeId: line.employeeId,
        employeeCode: line.employeeCode ?? '',
        employeeName: line.employee?.name ?? '',
        duplicateType: 'other_payroll_same_period',
        duplicateCount: 1,
        otherPayrollId: other.payrollId,
        otherPayrollName: other.payroll.name ?? '',
        note: `موجود أيضاً في ${other.payroll.name ?? other.payrollId}`,
      });
    }
  }

  return rows;
}

export async function movePayrollLine(params: {
  lineId: string;
  targetPayrollId?: string;
  action: 'move' | 'delete';
}) {
  const line = await prisma.payrollLine.findUnique({
    where: { id: params.lineId },
    include: { payroll: true },
  });
  if (!line) throw new NotFoundError('Payroll line not found');
  if (line.payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن تعديل سطر في كشف مؤكد', 400, 'ACTION_ERROR');
  }

  const sourcePayrollId = line.payrollId;

  if (params.action === 'delete') {
    await prisma.payrollLine.delete({ where: { id: line.id } });
    await addExcludedPayrollEmployees(sourcePayrollId, [line.employeeId]);
    await refreshPayrollHeaderTotals(sourcePayrollId);
    return { message: 'تم حذف السطر المكرر' };
  }

  if (!params.targetPayrollId) {
    throw new AppError('حدد كشف الرواتب الهدف', 400, 'VALIDATION_ERROR');
  }

  const target = await prisma.payroll.findUnique({ where: { id: params.targetPayrollId } });
  if (!target) throw new NotFoundError('Target payroll not found');
  if (target.state === PayrollState.confirmed) {
    throw new AppError('كشف الهدف مؤكد', 400, 'ACTION_ERROR');
  }

  const conflict = await prisma.payrollLine.findUnique({
    where: { payrollId_employeeId: { payrollId: params.targetPayrollId, employeeId: line.employeeId } },
  });
  if (conflict) {
    throw new AppError('الموظف موجود بالفعل في كشف الهدف', 400, 'ACTION_ERROR');
  }

  await prisma.payrollLine.update({
    where: { id: line.id },
    data: { payrollId: params.targetPayrollId },
  });

  await refreshPayrollHeaderTotals(sourcePayrollId);
  await refreshPayrollHeaderTotals(params.targetPayrollId);
  return { message: 'تم نقل السطر', targetPayrollId: params.targetPayrollId };
}
