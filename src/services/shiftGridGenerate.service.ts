import { ShiftGridState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { employeesForLocation, relocateEmployeesToGridLocation } from './location.service';
import { getEmployeeShiftForDate } from './shiftGridAssignment.service';

export async function resolveGridEmployees(
  grid: {
    id: string;
    selectionMethod: string;
    locationId: string | null;
    gridLocation: string | null;
    deviceId: string | null;
    employeeIds?: string[];
    departmentIds?: string[];
  },
  options?: { employeeIds?: string[]; departmentIds?: string[] },
) {
  const manualIds = options?.employeeIds?.filter(Boolean) ?? grid.employeeIds ?? [];
  if (manualIds.length > 0) {
    const employees = await prisma.employeeProfile.findMany({
      where: { id: { in: manualIds }, active: true },
      include: { mapping: true },
    });
    if (grid.selectionMethod === 'device' && grid.deviceId) {
      return employees.filter((e) => e.biotimeDeviceId === grid.deviceId);
    }
    return employees;
  }

  if (grid.selectionMethod === 'manual' && (grid.employeeIds?.length ?? 0) > 0) {
    return prisma.employeeProfile.findMany({
      where: { id: { in: grid.employeeIds }, active: true },
      include: { mapping: true },
    });
  }

  if (grid.selectionMethod === 'device' && grid.deviceId) {
    const device = await prisma.device.findUnique({ where: { id: grid.deviceId } });
    const byDeviceField = await prisma.employeeProfile.findMany({
      where: { active: true, biotimeDeviceId: grid.deviceId },
      include: { mapping: true },
    });
    if (byDeviceField.length > 0) return byDeviceField;

    if (device?.serialNumber) {
      const txs = await prisma.transaction.findMany({
        where: { terminalSn: device.serialNumber },
        select: { empCode: true },
        distinct: ['empCode'],
      });
      const codes = txs.map((t) => t.empCode).filter(Boolean) as string[];
      if (codes.length > 0) {
        return prisma.employeeProfile.findMany({
          where: {
            active: true,
            OR: [
              { code: { in: codes } },
              { mapping: { biotimeEmpCode: { in: codes } } },
            ],
          },
          include: { mapping: true },
        });
      }
    }
    return [];
  }

  if ((grid.selectionMethod === 'location' || grid.locationId) && grid.locationId) {
    return employeesForLocation(grid.locationId, true);
  }

  if (grid.gridLocation?.trim()) {
    const locNorm = grid.gridLocation.trim().toLowerCase();
    const all = await prisma.employeeProfile.findMany({ where: { active: true }, include: { mapping: true } });
    return all.filter((e) => (e.location ?? '').trim().toLowerCase() === locNorm);
  }

  const deptIds = options?.departmentIds?.filter(Boolean) ?? grid.departmentIds ?? [];
  if (deptIds.length > 0 || grid.selectionMethod === 'department') {
    const ids = deptIds.length > 0 ? deptIds : (grid.departmentIds ?? []);
    if (ids.length === 0) return [];
    return prisma.employeeProfile.findMany({
      where: { active: true, departmentId: { in: ids } },
      include: { mapping: true },
    });
  }

  return prisma.employeeProfile.findMany({ where: { active: true }, include: { mapping: true } });
}

function sortEmployeesForGrid<T extends { jobTitle?: string | null; name: string }>(employees: T[]): T[] {
  return [...employees].sort((a, b) => {
    const ja = a.jobTitle?.trim() || 'zzz';
    const jb = b.jobTitle?.trim() || 'zzz';
    if (ja !== jb) return ja.localeCompare(jb, 'ar');
    return (a.name ?? '').localeCompare(b.name ?? '', 'ar');
  });
}

export async function generateShiftGridLines(
  gridId: string,
  options?: { employeeIds?: string[]; departmentIds?: string[] },
): Promise<number> {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) throw new Error('Grid not found');

  const manualIds = options?.employeeIds?.filter(Boolean) ?? grid.employeeIds ?? [];
  if (grid.locationId && manualIds.length > 0) {
    await relocateEmployeesToGridLocation(manualIds, grid.locationId);
  }

  const employees = await resolveGridEmployees(grid, options);
  if (!employees.length) {
    throw new Error('لم يتم العثور على موظفين. تأكد من اختيار القسم أو الموظفين أو الجهاز/الموقع.');
  }

  await prisma.shiftGridLine.deleteMany({ where: { gridId } });

  const sorted = sortEmployeesForGrid(employees);
  const empIds = sorted.map((e) => e.id);
  const assignments = await prisma.shiftAssignment.findMany({
    where: { employeeId: { in: empIds }, active: true },
  });
  const shifts = await prisma.shift.findMany({ where: { active: true } });
  const shiftsById = new Map(shifts.map((s) => [s.id, s]));
  const assignmentsByEmp = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const list = assignmentsByEmp.get(a.employeeId) ?? [];
    list.push(a);
    assignmentsByEmp.set(a.employeeId, list);
  }

  const dayMs = 86400000;
  const rows: {
    gridId: string;
    employeeId: string;
    date: Date;
    shiftId: string | null;
    isOff: boolean;
  }[] = [];

  let d = new Date(grid.dateFrom);
  while (d <= grid.dateTo) {
    for (const emp of sorted) {
      if (!emp.active && emp.departureDate && d > emp.departureDate) continue;
      if (emp.hiringDate && d < emp.hiringDate) continue;

      const empAssignments = assignmentsByEmp.get(emp.id) ?? [];
      const { shift, isOff } = getEmployeeShiftForDate(empAssignments, new Date(d), shiftsById);
      rows.push({
        gridId,
        employeeId: emp.id,
        date: new Date(d),
        shiftId: shift?.id ?? null,
        isOff,
      });
    }
    d = new Date(d.getTime() + dayMs);
  }

  if (rows.length > 0) {
    await prisma.shiftGridLine.createMany({ data: rows });
  }

  await prisma.shiftGrid.update({
    where: { id: gridId },
    data: { state: ShiftGridState.grid },
  });

  return rows.length;
}
