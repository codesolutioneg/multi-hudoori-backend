import { ShiftGridState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { getEmployeeShiftForDate } from './shiftGridAssignment.service';

const WEEKDAY_NAMES = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

function jsWeekdayToOdoo(jsDay: number): number {
  return jsDay === 0 ? 6 : jsDay - 1;
}

export async function resyncShiftGridDates(gridId: string): Promise<{ added: number; removed: number }> {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) throw new Error('Grid not found');
  if (!grid.dateFrom || !grid.dateTo) throw new Error('يجب تحديد تاريخ البداية والنهاية أولاً.');
  if (grid.dateTo < grid.dateFrom) throw new Error('تاريخ النهاية يجب أن يكون بعد تاريخ البداية.');

  const outOfRange = await prisma.shiftGridLine.findMany({
    where: {
      gridId,
      OR: [{ date: { lt: grid.dateFrom } }, { date: { gt: grid.dateTo } }],
    },
  });
  const removed = outOfRange.length;
  if (removed > 0) {
    await prisma.shiftGridLine.deleteMany({ where: { id: { in: outOfRange.map((l) => l.id) } } });
  }

  const existingLines = await prisma.shiftGridLine.findMany({ where: { gridId } });
  const existingKeys = new Set(
    existingLines.map((l) => `${l.employeeId}:${l.date.toISOString().slice(0, 10)}`),
  );
  const employeeIds = [...new Set(existingLines.map((l) => l.employeeId))];
  const employees = await prisma.employeeProfile.findMany({ where: { id: { in: employeeIds } } });
  const empById = new Map(employees.map((e) => [e.id, e]));

  const assignments = await prisma.shiftAssignment.findMany({
    where: { employeeId: { in: employeeIds }, active: true },
  });
  const shifts = await prisma.shift.findMany({ where: { active: true } });
  const shiftsById = new Map(shifts.map((s) => [s.id, s]));
  const assignmentsByEmp = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const list = assignmentsByEmp.get(a.employeeId) ?? [];
    list.push(a);
    assignmentsByEmp.set(a.employeeId, list);
  }

  const rows: {
    gridId: string;
    employeeId: string;
    date: Date;
    shiftId: string | null;
    isOff: boolean;
  }[] = [];

  let d = new Date(grid.dateFrom);
  while (d <= grid.dateTo) {
    const day = new Date(d);
    for (const empId of employeeIds) {
      const key = `${empId}:${day.toISOString().slice(0, 10)}`;
      if (existingKeys.has(key)) continue;
      const emp = empById.get(empId);
      if (emp && !emp.active && emp.departureDate && day > emp.departureDate) continue;
      if (emp?.hiringDate && day < emp.hiringDate) continue;

      const empAssignments = assignmentsByEmp.get(empId) ?? [];
      const { shift, isOff } = getEmployeeShiftForDate(empAssignments, day, shiftsById);
      rows.push({
        gridId,
        employeeId: empId,
        date: new Date(day),
        shiftId: shift?.id ?? null,
        isOff,
      });
    }
    d = new Date(d.getTime() + 86400000);
  }

  if (rows.length > 0) await prisma.shiftGridLine.createMany({ data: rows });
  return { added: rows.length, removed };
}

export async function confirmShiftGridAssignments(gridId: string): Promise<{ created: number; skipped: number }> {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) throw new Error('Grid not found');

  const lines = await prisma.shiftGridLine.findMany({
    where: { gridId },
    orderBy: [{ employeeId: 'asc' }, { date: 'asc' }],
  });
  if (!lines.length) throw new Error('لا يوجد بيانات في الجدول');

  const employeeIds = [...new Set(lines.map((l) => l.employeeId))];

  if (grid.conflictAction === 'replace') {
    const overlapping = await prisma.shiftAssignment.findMany({
      where: {
        employeeId: { in: employeeIds },
        active: true,
        dateFrom: { lte: grid.dateTo },
        OR: [{ dateTo: null }, { dateTo: { gte: grid.dateFrom } }],
      },
    });
    for (const assignment of overlapping) {
      if (assignment.dateFrom < grid.dateFrom) {
        const newTo = new Date(grid.dateFrom.getTime() - 86400000);
        await prisma.shiftAssignment.update({
          where: { id: assignment.id },
          data: { dateTo: newTo },
        });
      } else {
        await prisma.shiftAssignment.update({
          where: { id: assignment.id },
          data: { active: false },
        });
      }
    }
  }

  let created = 0;
  let skipped = 0;

  for (const empId of employeeIds) {
    if (grid.conflictAction === 'skip') {
      const existing = await prisma.shiftAssignment.findFirst({
        where: {
          employeeId: empId,
          active: true,
          dateFrom: { lte: grid.dateTo },
          OR: [{ dateTo: null }, { dateTo: { gte: grid.dateFrom } }],
        },
      });
      if (existing) {
        skipped++;
        continue;
      }
    }

    const empLines = lines.filter((l) => l.employeeId === empId);
    const weeklyFields: Record<string, string | boolean | null> = {};

    for (let odooWd = 0; odooWd < 7; odooWd++) {
      const dayName = WEEKDAY_NAMES[odooWd];
      const dayLines = empLines.filter((l) => jsWeekdayToOdoo(l.date.getDay()) === odooWd);
      const offDays = dayLines.filter((l) => l.isOff);
      const shiftLines = dayLines.filter((l) => l.shiftId);

      if (offDays.length > dayLines.length / 2) {
        weeklyFields[`${dayName}IsOff`] = true;
      } else if (shiftLines.length > 0) {
        const counts = new Map<string, number>();
        for (const sl of shiftLines) {
          if (!sl.shiftId) continue;
          counts.set(sl.shiftId, (counts.get(sl.shiftId) ?? 0) + 1);
        }
        const mostCommon = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (mostCommon) {
          weeklyFields[`${dayName}ShiftId`] = mostCommon;
          weeklyFields[`${dayName}IsOff`] = false;
        }
      }
    }

    const allShifts = empLines.filter((l) => l.shiftId).map((l) => l.shiftId!);
    let fallbackShiftId: string | null = null;
    if (allShifts.length > 0) {
      const counts = new Map<string, number>();
      for (const sid of allShifts) counts.set(sid, (counts.get(sid) ?? 0) + 1);
      fallbackShiftId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }

    try {
      await prisma.shiftAssignment.create({
        data: {
          employeeId: empId,
          assignmentType: 'weekly_period',
          dateFrom: grid.dateFrom,
          dateTo: grid.dateTo,
          active: true,
          shiftId: fallbackShiftId,
          ...(weeklyFields as Record<string, unknown>),
        },
      });
      created++;
    } catch {
      skipped++;
    }
  }

  await prisma.shiftGrid.update({
    where: { id: gridId },
    data: { state: ShiftGridState.confirmed },
  });

  return { created, skipped };
}

export async function closeShiftGrid(gridId: string): Promise<void> {
  await prisma.shiftGrid.update({
    where: { id: gridId },
    data: { state: ShiftGridState.confirmed },
  });
}

export async function reopenShiftGrid(gridId: string): Promise<void> {
  await prisma.shiftGrid.update({
    where: { id: gridId },
    data: { state: ShiftGridState.grid },
  });
}

export async function backShiftGridToSetup(gridId: string): Promise<void> {
  await prisma.shiftGrid.update({
    where: { id: gridId },
    data: { state: ShiftGridState.setup },
  });
}
