/**
 * Durable employee archive/restore with audit metadata.
 * Archiving is the primary way to deactivate an employee: it records when and
 * why, closes shift assignments, and locks the linked app account out.
 */
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { utcDateOnly } from '../utils/payrollPeriod';
import { logger } from '../utils/logger';
import { invalidateNoPunchCache } from './noPunchAlerts.service';

const EMPLOYEE_INCLUDE = { department: true, mapping: true, workLocation: true } as const;

export async function archiveEmployee(
  employeeId: string,
  reason: string,
  actor?: string,
  archivedAtInput?: Date | string | null,
) {
  const trimmedReason = String(reason ?? '').trim();
  if (!trimmedReason) {
    throw new AppError('سبب الأرشفة مطلوب', 400, 'VALIDATION');
  }

  const existing = await prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    select: { id: true, active: true, archivedAt: true, userId: true },
  });
  if (!existing) throw new NotFoundError('Employee not found');

  const parsedInput =
    archivedAtInput != null && String(archivedAtInput).trim()
      ? new Date(String(archivedAtInput))
      : null;
  if (parsedInput && Number.isNaN(parsedInput.getTime())) {
    throw new AppError('تاريخ/وقت الإنهاء غير صالح', 400, 'VALIDATION');
  }

  const archivedAt =
    parsedInput ??
    (existing.active ? new Date() : (existing.archivedAt ?? new Date()));

  const employee = await prisma.$transaction(async (tx) => {
    const updated = await tx.employeeProfile.update({
      where: { id: employeeId },
      data: {
        active: false,
        archivedAt,
        archiveReason: trimmedReason,
        departureDate: utcDateOnly(archivedAt),
      },
      include: EMPLOYEE_INCLUDE,
    });

    await tx.shiftAssignment.updateMany({
      where: { employeeId, active: true },
      data: { active: false },
    });

    if (existing.userId) {
      await tx.user.update({ where: { id: existing.userId }, data: { active: false } });
      await tx.apiToken.deleteMany({ where: { userId: existing.userId } });
    }

    return updated;
  });

  invalidateNoPunchCache();
  logger.info(
    { employeeId, reason: trimmedReason, actor: actor ?? null, archivedAt },
    'Employee archived',
  );
  return employee;
}

export async function restoreEmployee(employeeId: string) {
  const existing = await prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    select: { id: true, userId: true },
  });
  if (!existing) throw new NotFoundError('Employee not found');

  const employee = await prisma.$transaction(async (tx) => {
    // archivedAt / archiveReason are kept on purpose as an audit trail.
    const updated = await tx.employeeProfile.update({
      where: { id: employeeId },
      data: { active: true, departureDate: null },
      include: EMPLOYEE_INCLUDE,
    });

    if (existing.userId) {
      await tx.user.update({ where: { id: existing.userId }, data: { active: true } });
    }

    return updated;
  });

  invalidateNoPunchCache();
  logger.info({ employeeId }, 'Employee restored from archive');
  return employee;
}
