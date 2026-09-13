import { UserRole } from '@prisma/client';
import { prisma } from '../prisma/client';
import { NotFoundError } from '../utils/errors';

export type DeleteEmployeeResult = {
  employeeId: string;
  employeeName: string;
  deletedAppUser: boolean;
  /** Direct reports re-attached to the deleted manager's own manager. */
  reparentedReports: number;
};

/** Permanently remove an employee profile and related HR data. Optionally removes linked app user. */
export async function deleteEmployee(employeeId: string): Promise<DeleteEmployeeResult> {
  const employee = await prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    select: { id: true, name: true, userId: true, managerId: true },
  });
  if (!employee) {
    throw new NotFoundError('Employee not found', 'NOT_FOUND');
  }

  const linkedUserId = employee.userId;
  let reparentedReports = 0;

  await prisma.$transaction(async (tx) => {
    const longAdvanceIds = (
      await tx.advanceLong.findMany({ where: { employeeId }, select: { id: true } })
    ).map((row) => row.id);
    if (longAdvanceIds.length) {
      await tx.advanceLongPayment.deleteMany({ where: { advanceId: { in: longAdvanceIds } } });
    }

    await tx.payrollLine.deleteMany({ where: { employeeId } });
    await tx.deduction.deleteMany({ where: { employeeId } });
    await tx.advanceShort.deleteMany({ where: { employeeId } });
    await tx.advanceLong.deleteMany({ where: { employeeId } });
    await tx.leaveRequest.deleteMany({ where: { employeeId } });
    await tx.loanRequest.deleteMany({ where: { employeeId } });
    await tx.shiftChangeRequest.deleteMany({ where: { employeeId } });
    await tx.salaryRequest.deleteMany({ where: { employeeId } });
    await tx.certificateRequest.deleteMany({ where: { employeeId } });
    await tx.attendanceEditRequest.deleteMany({ where: { employeeId } });
    await tx.overtimeAnalysis.deleteMany({ where: { employeeId } });
    await tx.attendance.deleteMany({ where: { employeeId } });
    await tx.shiftGridLine.deleteMany({ where: { employeeId } });
    await tx.shiftAssignment.deleteMany({ where: { employeeId } });
    await tx.transaction.deleteMany({ where: { employeeId } });

    const grids = await tx.shiftGrid.findMany({
      where: { employeeIds: { has: employeeId } },
      select: { id: true, employeeIds: true },
    });
    for (const grid of grids) {
      await tx.shiftGrid.update({
        where: { id: grid.id },
        data: { employeeIds: grid.employeeIds.filter((id) => id !== employeeId) },
      });
    }

    await tx.odooSyncMap.deleteMany({
      where: {
        OR: [
          { entityType: 'employee', localId: employeeId },
          { entityType: 'employee_profile', localId: employeeId },
        ],
      },
    });

    await tx.employeeMapping.deleteMany({ where: { employeeId } });

    // The manager self-relation is ON DELETE SET NULL, so deleting someone would
    // silently blank the manual org-chart placement of every person under them.
    // Hand them to their grandparent instead, which is what actually happens when
    // a manager leaves — and only then let the delete cascade run.
    const reports = await tx.employeeProfile.updateMany({
      where: { managerId: employeeId },
      data: { managerId: employee.managerId ?? null },
    });
    reparentedReports = reports.count;

    await tx.employeeProfile.delete({ where: { id: employeeId } });

    if (linkedUserId) {
      const user = await tx.user.findUnique({ where: { id: linkedUserId } });
      if (user && user.role !== UserRole.PLATFORM_ADMIN) {
        await tx.apiToken.deleteMany({ where: { userId: linkedUserId } });
        await tx.user.delete({ where: { id: linkedUserId } });
      }
    }
  });

  let deletedAppUser = false;
  if (linkedUserId) {
    const stillExists = await prisma.user.findUnique({ where: { id: linkedUserId } });
    deletedAppUser = !stillExists;
  }

  return {
    employeeId,
    employeeName: employee.name,
    deletedAppUser,
    reparentedReports,
  };
}
