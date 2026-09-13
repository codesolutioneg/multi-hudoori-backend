/**
 * Odoo parity: payroll_location_transfer.py
 */
import { PayrollState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';

function normalizeLocation(v: string | null | undefined): string {
  return (v || '').trim().toLowerCase();
}

export async function listLocationTransferCandidates(payrollId: string, targetLocation: string) {
  const payroll = await prisma.payroll.findUnique({
    where: { id: payrollId },
    include: { lines: { include: { employee: { include: { workLocation: true } } }, orderBy: { sequence: 'asc' } } },
  });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن تعديل Location على كشف مؤكد', 400, 'ACTION_ERROR');
  }
  const target = targetLocation.trim();
  if (!target) throw new AppError('حدد Location الهدف', 400, 'VALIDATION_ERROR');
  if (!payroll.lines.length) throw new AppError('لا توجد سطور — احسب الكشف أولاً', 400, 'ACTION_ERROR');

  return payroll.lines.map((line) => {
    const current = line.employeeLocation?.trim()
      || line.employee?.location?.trim()
      || line.employee?.workLocation?.name?.trim()
      || '';
    const needsTransfer = normalizeLocation(current) !== normalizeLocation(target);
    return {
      lineId: line.id,
      employeeId: line.employeeId,
      employeeCode: line.employeeCode ?? '',
      employeeName: line.employee?.name ?? '',
      departmentName: line.departmentName ?? '',
      currentLocation: current,
      needsTransfer,
      selected: needsTransfer,
    };
  });
}

export async function applyLocationTransfer(params: {
  payrollId: string;
  targetLocation: string;
  lineIds: string[];
}) {
  const payroll = await prisma.payroll.findUnique({ where: { id: params.payrollId } });
  if (!payroll) throw new NotFoundError('Payroll not found');
  if (payroll.state === PayrollState.confirmed) {
    throw new AppError('لا يمكن تعديل Location على كشف مؤكد', 400, 'ACTION_ERROR');
  }

  const target = params.targetLocation.trim();
  if (!target) throw new AppError('حدد Location الهدف', 400, 'VALIDATION_ERROR');
  if (!params.lineIds.length) throw new AppError('حدد موظفاً واحداً على الأقل', 400, 'VALIDATION_ERROR');

  const lines = await prisma.payrollLine.findMany({
    where: { payrollId: params.payrollId, id: { in: params.lineIds } },
    include: { employee: true },
  });

  let updated = 0;
  for (const line of lines) {
    if (!line.employee) continue;
    await prisma.employeeProfile.update({
      where: { id: line.employeeId },
      data: { location: target },
    });
    await prisma.payrollLine.update({
      where: { id: line.id },
      data: { employeeLocation: target },
    });
    updated++;
  }

  return { updated, message: `تم نقل Location لـ ${updated} موظف إلى «${target}»` };
}
