import { prisma } from '../prisma/client';
import { NotFoundError } from '../utils/errors';

/** Calendar year bounds as UTC instants for @db.Date / timestamp comparisons. */
function yearBounds(year: number) {
  return {
    dateFrom: new Date(Date.UTC(year, 0, 1)),
    dateTo: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
  };
}

export async function getEmployeeLeaveSummary(employeeId: string, year?: number) {
  const emp = await prisma.employeeProfile.findUnique({ where: { id: employeeId } });
  if (!emp) throw new NotFoundError('Employee not found');

  const y = year ?? new Date().getUTCFullYear();
  const { dateFrom, dateTo } = yearBounds(y);

  const [attendances, gridLines] = await Promise.all([
    prisma.attendance.findMany({
      where: {
        employeeId,
        date: { gte: dateFrom, lte: dateTo },
        status: 'leave',
      },
      orderBy: { date: 'asc' },
    }),
    prisma.shiftGridLine.findMany({
      where: {
        employeeId,
        isAnnualLeave: true,
        date: { gte: dateFrom, lte: dateTo },
      },
      orderBy: { date: 'asc' },
    }),
  ]);

  const dateMap = new Map<string, { date: string; source: string }>();
  for (const row of attendances) {
    const d = row.date.toISOString().slice(0, 10);
    dateMap.set(d, { date: d, source: 'attendance' });
  }
  for (const row of gridLines) {
    const d = row.date.toISOString().slice(0, 10);
    if (!dateMap.has(d)) dateMap.set(d, { date: d, source: 'shift_grid' });
  }

  const dates = Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const usedLeaveDays = dates.length;
  const leaveStartingBalance = emp.leaveStartingBalance ?? 0;
  const remainingLeaveBalance = leaveStartingBalance - usedLeaveDays;

  return {
    year: y,
    leaveStartingBalance,
    usedLeaveDays,
    remainingLeaveBalance,
    dates,
  };
}
