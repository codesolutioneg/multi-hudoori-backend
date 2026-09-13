/**
 * Pull shifts, shift grids, payroll, deductions, and advances from Odoo
 * via biotime_flutter_api JSON-RPC (read-only on Odoo side).
 */
import {
  AdvanceState,
  DeductionState,
  PayrollState,
  ShiftGridState,
} from '@prisma/client';
import { prisma } from '../../prisma/client';
import { logger } from '../../utils/logger';
import { floatToTimeString, computeIsOvernight } from '../shiftCalculations.service';
import * as odooClient from './odooClient.service';

export type OdooPullStats = {
  employees: number;
  shifts: number;
  assignments: number;
  shiftGrids: number;
  gridLines: number;
  deductions: number;
  advancesShort: number;
  advancesLong: number;
  payrolls: number;
  payrollLines: number;
  skipped: number;
  errors: number;
};

export type OdooPullOptions = {
  employees?: boolean;
  shifts?: boolean;
  assignments?: boolean;
  shiftGrids?: boolean;
  odooGridId?: number;
  gridLimit?: number;
  deductions?: boolean;
  advancesShort?: boolean;
  advancesLong?: boolean;
  payrolls?: boolean;
  listLimit?: number;
};

const DEFAULT_LIMIT = 500;

function parseDate(value: string | undefined | false): Date | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapGridState(state: string): ShiftGridState {
  if (state === 'confirmed') return ShiftGridState.confirmed;
  if (state === 'grid') return ShiftGridState.grid;
  return ShiftGridState.setup;
}

function mapPayrollState(state: string): PayrollState {
  if (state === 'confirmed') return PayrollState.confirmed;
  if (state === 'calculated') return PayrollState.calculated;
  return PayrollState.draft;
}

function mapDeductionState(state: string): DeductionState {
  if (state === 'applied') return DeductionState.linked;
  if (state === 'cancelled') return DeductionState.cancelled;
  return DeductionState.draft;
}

function mapAdvanceShortState(state: string): AdvanceState {
  if (state === 'applied') return AdvanceState.applied;
  if (state === 'cancelled') return AdvanceState.cancelled;
  if (state === 'pending') return AdvanceState.pending;
  return AdvanceState.pending;
}

function mapAdvanceLongState(state: string): AdvanceState {
  if (state === 'done') return AdvanceState.done;
  if (state === 'cancelled') return AdvanceState.cancelled;
  if (state === 'running') return AdvanceState.running;
  if (state === 'draft') return AdvanceState.draft;
  return AdvanceState.draft;
}

async function saveOdooMap(entityType: string, localId: string, odooId: string | number) {
  const id = String(odooId);
  await prisma.odooSyncMap.upsert({
    where: { entityType_localId: { entityType, localId } },
    create: { entityType, localId, odooId: id },
    update: { odooId: id, syncedAt: new Date() },
  });
}

async function findLocalByOdooMap(entityType: string, odooId: number | string): Promise<string | null> {
  const row = await prisma.odooSyncMap.findFirst({
    where: { entityType, odooId: String(odooId) },
  });
  return row?.localId ?? null;
}

async function resolveLocalEmployee(
  odooEmployeeId: number | false | undefined,
  employeeCode?: string,
): Promise<string | null> {
  if (odooEmployeeId) {
    const mapped = await findLocalByOdooMap('employee', odooEmployeeId);
    if (mapped) return mapped;
  }

  const code = (employeeCode ?? '').trim();
  if (code) {
    const byCode = await prisma.employeeProfile.findFirst({
      where: {
        OR: [
          { identificationId: code },
          { code: code },
          { barcode: code },
          { mapping: { biotimeEmpCode: code } },
        ],
      },
      select: { id: true },
    });
    if (byCode) {
      if (odooEmployeeId) await saveOdooMap('employee', byCode.id, odooEmployeeId);
      return byCode.id;
    }
  }

  if (odooEmployeeId) {
    const byOdooOnly = await prisma.employeeProfile.findFirst({
      where: { mapping: { biotimeEmpId: Number(odooEmployeeId) } },
      select: { id: true },
    });
    if (byOdooOnly) {
      await saveOdooMap('employee', byOdooOnly.id, odooEmployeeId);
      return byOdooOnly.id;
    }
  }

  return null;
}

type OdooEmployeeListItem = {
  id: number;
  name?: string;
  displayName?: string;
  code?: string;
  identificationId?: string;
  barcode?: string;
  job?: string;
  workPhone?: string;
  mobilePhone?: string;
  workEmail?: string;
  gender?: string;
  location?: string;
  basicSalary?: number;
  active?: boolean;
  biotimeSynced?: boolean;
};

export async function pullEmployeesFromOdoo(stats: OdooPullStats, pageSize = 200): Promise<void> {
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const data = await odooClient.odooCall<{ items?: OdooEmployeeListItem[]; total?: number }>(
      '/api/biotime/employees/list',
      { limit: pageSize, offset, includeInactive: true },
    );
    const items = data.items ?? [];
    total = data.total ?? offset + items.length;
    if (!items.length) break;

    for (const emp of items) {
      try {
        const odooId = emp.id;
        let localId = await findLocalByOdooMap('employee', odooId);

        const idCode = (emp.identificationId || '').trim();
        const profileData = {
          name: emp.name || emp.displayName || `Employee ${odooId}`,
          displayName: emp.displayName || emp.name || null,
          code: (emp.code || idCode || emp.barcode || '').trim() || null,
          identificationId: idCode || (emp.code || emp.barcode || '').trim() || null,
          barcode: (emp.barcode || '').trim() || null,
          jobTitle: (emp.job || '').trim() || null,
          workPhone: (emp.workPhone || '').trim() || null,
          mobilePhone: (emp.mobilePhone || '').trim() || null,
          workEmail: (emp.workEmail || '').trim() || null,
          gender: (emp.gender || '').trim() || null,
          location: (emp.location || '').trim() || null,
          basicSalary: Number(emp.basicSalary ?? 0),
          active: emp.active !== false,
          biotimeSynced: Boolean(emp.biotimeSynced),
        };

        if (!localId) {
          const matchCode = profileData.identificationId || profileData.code || profileData.barcode;
          if (matchCode) {
            const existing = await prisma.employeeProfile.findFirst({
              where: {
                OR: [
                  { identificationId: matchCode },
                  { code: matchCode },
                  { barcode: matchCode },
                ],
              },
              select: { id: true },
            });
            if (existing) localId = existing.id;
          }
        }

        if (localId) {
          await prisma.employeeProfile.update({ where: { id: localId }, data: profileData });
        } else {
          const created = await prisma.employeeProfile.create({ data: profileData });
          localId = created.id;
        }

        await saveOdooMap('employee', localId, odooId);
        stats.employees += 1;
      } catch (err) {
        stats.errors += 1;
        logger.warn({ err, odooId: emp.id }, 'pull employee failed');
      }
    }

    offset += items.length;
    if (items.length < pageSize) break;
  }
}

async function resolveLocalShift(
  odooShiftId: number | false | undefined,
  shiftCode?: string,
): Promise<string | null> {
  if (odooShiftId) {
    const mapped = await findLocalByOdooMap('shift', odooShiftId);
    if (mapped) return mapped;
  }

  const code = (shiftCode ?? '').trim();
  if (code) {
    const byCode = await prisma.shift.findFirst({
      where: { OR: [{ code }, { name: code }] },
      select: { id: true },
    });
    if (byCode) {
      if (odooShiftId) await saveOdooMap('shift', byCode.id, odooShiftId);
      return byCode.id;
    }
  }

  return null;
}

async function resolveLocalShiftGrid(odooGridId: number): Promise<string | null> {
  return findLocalByOdooMap('shift_grid', odooGridId);
}

async function resolveLocalPayroll(odooPayrollId: number): Promise<string | null> {
  return findLocalByOdooMap('payroll', odooPayrollId);
}

async function resolveLocalDevice(odooDeviceId: number | false | undefined): Promise<string | null> {
  if (!odooDeviceId) return null;
  const mapped = await findLocalByOdooMap('device', odooDeviceId);
  if (mapped) return mapped;
  const device = await prisma.device.findFirst({ where: { biotimeId: Number(odooDeviceId) } });
  if (device) {
    await saveOdooMap('device', device.id, odooDeviceId);
    return device.id;
  }
  return null;
}

type OdooShift = {
  id: number;
  name?: string;
  code?: string;
  startTime?: number;
  endTime?: number;
  breakDuration?: number;
  checkInGrace?: number;
  checkOutGrace?: number;
  sequence?: number;
  active?: boolean;
};

export async function pullShiftsFromOdoo(stats: OdooPullStats): Promise<void> {
  const data = await odooClient.odooCall<{ items?: OdooShift[] }>('/api/biotime/shifts/list');
  const items = data.items ?? [];

  for (const s of items) {
    try {
      const startFloat = Number(s.startTime ?? 8);
      const endFloat = Number(s.endTime ?? 17);
      const startTime = floatToTimeString(startFloat);
      const endTime = floatToTimeString(endFloat);
      const isOvernight = computeIsOvernight(startFloat, endFloat);
      const code = (s.code ?? s.name ?? `S${s.id}`).trim();

      let local = await prisma.shift.findFirst({
        where: { OR: [{ code }, { name: s.name ?? code }] },
      });

      const payload = {
        name: s.name ?? code,
        code,
        startTime,
        endTime,
        isOvernight,
        gracePeriodIn: Math.round(Number(s.checkInGrace ?? 20)),
        gracePeriodOut: Math.round(Number(s.checkOutGrace ?? 15)),
        breakDuration: Number(s.breakDuration ?? 0),
        sequence: Number(s.sequence ?? 10),
        active: s.active !== false,
      };

      if (local) {
        local = await prisma.shift.update({ where: { id: local.id }, data: payload });
      } else {
        local = await prisma.shift.create({ data: payload });
      }

      await saveOdooMap('shift', local.id, s.id);
      stats.shifts += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn({ err, shiftId: s.id }, 'pull shift failed');
    }
  }
}

type OdooAssignment = {
  id: number;
  employeeId?: number | false;
  shiftId?: number | false;
  assignmentType?: string;
  dateFrom?: string;
  dateTo?: string;
  active?: boolean;
  weekly?: Record<string, { shiftId?: number | false; isOff?: boolean }>;
};

const WEEKDAY_MAP: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

export async function pullShiftAssignmentsFromOdoo(
  stats: OdooPullStats,
  limit = DEFAULT_LIMIT,
): Promise<void> {
  const data = await odooClient.odooCall<{ items?: OdooAssignment[] }>(
    '/api/biotime/shift-assignments/list',
    { limit },
  );
  const items = data.items ?? [];

  for (const a of items) {
    try {
      const employeeId = await resolveLocalEmployee(a.employeeId);
      if (!employeeId) {
        stats.skipped += 1;
        continue;
      }

      const dateFrom = parseDate(a.dateFrom);
      if (!dateFrom) {
        stats.skipped += 1;
        continue;
      }

      let shiftId: string | null = null;
      if (a.shiftId) {
        shiftId = await resolveLocalShift(a.shiftId);
      } else if (a.weekly) {
        for (const cfg of Object.values(a.weekly)) {
          if (cfg?.shiftId) {
            shiftId = await resolveLocalShift(cfg.shiftId);
            if (shiftId) break;
          }
        }
      }
      if (!shiftId) {
        stats.skipped += 1;
        continue;
      }

      let weekDays: string | null = null;
      if (a.weekly && a.assignmentType === 'weekly') {
        const days: number[] = [];
        for (const [day, cfg] of Object.entries(a.weekly)) {
          if (cfg?.shiftId || cfg?.isOff) {
            const n = WEEKDAY_MAP[day];
            if (n !== undefined) days.push(n);
          }
        }
        if (days.length) weekDays = days.sort((x, y) => x - y).join(',');
      }

      const existingMap = await findLocalByOdooMap('shift_assignment', a.id);
      const payload = {
        employeeId,
        shiftId,
        dateFrom,
        dateTo: parseDate(a.dateTo ?? undefined),
        assignmentType: a.assignmentType ?? 'permanent',
        weekDays,
        active: a.active !== false,
      };

      let localId: string;
      if (existingMap) {
        await prisma.shiftAssignment.update({ where: { id: existingMap }, data: payload });
        localId = existingMap;
      } else {
        const created = await prisma.shiftAssignment.create({ data: payload });
        localId = created.id;
      }

      await saveOdooMap('shift_assignment', localId, a.id);
      stats.assignments += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn({ err, assignmentId: a.id }, 'pull assignment failed');
    }
  }
}

type OdooGridSummary = {
  id: number;
  name?: string;
  dateFrom?: string;
  dateTo?: string;
  state?: string;
  selectionMethod?: string;
  conflictAction?: string;
  deviceId?: number | false;
};

type OdooGridCell = {
  line_id?: number;
  shift_id?: number | false;
  shift_code?: string;
  is_off?: boolean;
  is_sick?: boolean;
  is_annual_leave?: boolean;
  is_excluded?: boolean;
  is_bus_delay?: boolean;
  is_present?: boolean;
  is_finished?: boolean;
  is_resignation?: boolean;
  is_work_absence?: boolean;
  is_work_injury?: boolean;
  is_marriage_leave?: boolean;
};

type OdooGridData = {
  dates?: { date: string }[];
  job_groups?: Record<
    string,
    {
      employee_id: number;
      name?: string;
      code?: string;
      job_title?: string;
      cells?: Record<string, OdooGridCell>;
    }[]
  >;
};

export async function pullShiftGridsFromOdoo(
  stats: OdooPullStats,
  options: { odooGridId?: number; limit?: number } = {},
): Promise<void> {
  let grids: OdooGridSummary[] = [];

  if (options.odooGridId) {
    const one = await odooClient.odooCall<{ grid?: OdooGridSummary }>('/api/biotime/shift-grid/get', {
      gridId: options.odooGridId,
    });
    if (one.grid) grids = [one.grid];
  } else {
    const list = await odooClient.odooCall<{ items?: OdooGridSummary[] }>(
      '/api/biotime/shift-grid/list',
      { limit: options.limit ?? 20 },
    );
    grids = list.items ?? [];
  }

  for (const g of grids) {
    try {
      const detail = await odooClient.odooCall<{ grid?: OdooGridSummary; data?: OdooGridData }>(
        '/api/biotime/shift-grid/get',
        { gridId: g.id },
      );
      const grid = detail.grid ?? g;
      const data = detail.data ?? {};

      const dateFrom = parseDate(grid.dateFrom);
      const dateTo = parseDate(grid.dateTo);
      if (!dateFrom || !dateTo) {
        stats.skipped += 1;
        continue;
      }

      const deviceId = await resolveLocalDevice(grid.deviceId);
      const existingId = await findLocalByOdooMap('shift_grid', g.id);

      const employeeIds: string[] = [];
      const gridPayload = {
        name: grid.name ?? `Grid ${g.id}`,
        dateFrom,
        dateTo,
        state: mapGridState(grid.state ?? 'setup'),
        selectionMethod: grid.selectionMethod ?? 'manual',
        conflictAction: grid.conflictAction ?? 'replace',
        deviceId,
        employeeIds,
        departmentIds: [] as string[],
      };

      let localGridId: string;
      if (existingId) {
        await prisma.shiftGrid.update({ where: { id: existingId }, data: gridPayload });
        localGridId = existingId;
        await prisma.shiftGridLine.deleteMany({ where: { gridId: localGridId } });
      } else {
        const created = await prisma.shiftGrid.create({ data: gridPayload });
        localGridId = created.id;
      }

      await saveOdooMap('shift_grid', localGridId, g.id);
      stats.shiftGrids += 1;

      const jobGroups = data.job_groups ?? {};
      for (const rows of Object.values(jobGroups)) {
        for (const row of rows) {
          const employeeId = await resolveLocalEmployee(row.employee_id, row.code);
          if (!employeeId) {
            stats.skipped += 1;
            continue;
          }
          if (!employeeIds.includes(employeeId)) employeeIds.push(employeeId);

          const cells = row.cells ?? {};
          for (const [dateStr, cell] of Object.entries(cells)) {
            const date = parseDate(dateStr);
            if (!date) continue;

            let shiftId: string | null = null;
            if (cell.shift_id) {
              shiftId = await resolveLocalShift(cell.shift_id, cell.shift_code);
            }

            await prisma.shiftGridLine.upsert({
              where: {
                gridId_employeeId_date: {
                  gridId: localGridId,
                  employeeId,
                  date,
                },
              },
              create: {
                gridId: localGridId,
                employeeId,
                date,
                shiftId,
                isOff: Boolean(cell.is_off),
                isSick: Boolean(cell.is_sick),
                isAnnualLeave: Boolean(cell.is_annual_leave),
                isExcluded: Boolean(cell.is_excluded),
                isBusDelay: Boolean(cell.is_bus_delay),
                isPresent: Boolean(cell.is_present) || Boolean(cell.is_marriage_leave),
                isFinished: Boolean(cell.is_finished),
                isResignation: Boolean(cell.is_resignation),
                isWorkAbsence: Boolean(cell.is_work_absence),
                isWorkInjury: Boolean(cell.is_work_injury),
                isMarriageLeave: Boolean(cell.is_marriage_leave),
              },
              update: {
                shiftId,
                isOff: Boolean(cell.is_off),
                isSick: Boolean(cell.is_sick),
                isAnnualLeave: Boolean(cell.is_annual_leave),
                isExcluded: Boolean(cell.is_excluded),
                isBusDelay: Boolean(cell.is_bus_delay),
                isPresent: Boolean(cell.is_present) || Boolean(cell.is_marriage_leave),
                isFinished: Boolean(cell.is_finished),
                isResignation: Boolean(cell.is_resignation),
                isWorkAbsence: Boolean(cell.is_work_absence),
                isWorkInjury: Boolean(cell.is_work_injury),
                isMarriageLeave: Boolean(cell.is_marriage_leave),
              },
            });
            stats.gridLines += 1;
          }
        }
      }

      await prisma.shiftGrid.update({
        where: { id: localGridId },
        data: { employeeIds },
      });
    } catch (err) {
      stats.errors += 1;
      logger.warn({ err, gridId: g.id }, 'pull shift grid failed');
    }
  }
}

type OdooDeduction = {
  id: number;
  deductionType?: string;
  employeeId?: number;
  employeeCode?: string;
  date?: string;
  amount?: number;
  state?: string;
  note?: string;
  payrollId?: number | false;
};

export async function pullDeductionsFromOdoo(stats: OdooPullStats, limit = DEFAULT_LIMIT): Promise<void> {
  const data = await odooClient.odooCall<{ items?: OdooDeduction[] }>(
    '/api/biotime/deductions/list',
    { limit },
  );

  for (const d of data.items ?? []) {
    try {
      const employeeId = await resolveLocalEmployee(d.employeeId, d.employeeCode);
      if (!employeeId) {
        stats.skipped += 1;
        continue;
      }

      const payrollId = d.payrollId ? await resolveLocalPayroll(Number(d.payrollId)) : null;
      const date = parseDate(d.date) ?? new Date();
      const existingId = await findLocalByOdooMap('deduction', d.id);

      const payload = {
        employeeId,
        payrollId,
        type: d.deductionType ?? 'manual_debit',
        amount: Number(d.amount ?? 0),
        appliedAmount: 0,
        state: mapDeductionState(d.state ?? 'pending'),
        date,
        notes: d.note ?? null,
      };

      let localId: string;
      if (existingId) {
        await prisma.deduction.update({ where: { id: existingId }, data: payload });
        localId = existingId;
      } else {
        const created = await prisma.deduction.create({ data: payload });
        localId = created.id;
      }

      await saveOdooMap('deduction', localId, d.id);
      stats.deductions += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn({ err, deductionId: d.id }, 'pull deduction failed');
    }
  }
}

type OdooAdvanceShort = {
  id: number;
  employeeId?: number;
  employeeCode?: string;
  date?: string;
  amount?: number;
  state?: string;
  isDeducted?: boolean;
  note?: string;
  payrollId?: number | false;
};

export async function pullAdvancesShortFromOdoo(stats: OdooPullStats, limit = DEFAULT_LIMIT): Promise<void> {
  const data = await odooClient.odooCall<{ items?: OdooAdvanceShort[] }>(
    '/api/biotime/advances/short/list',
    { limit },
  );

  for (const a of data.items ?? []) {
    try {
      const employeeId = await resolveLocalEmployee(a.employeeId, a.employeeCode);
      if (!employeeId) {
        stats.skipped += 1;
        continue;
      }

      const payrollId = a.payrollId ? await resolveLocalPayroll(Number(a.payrollId)) : null;
      const existingId = await findLocalByOdooMap('advance_short', a.id);

      const payload = {
        employeeId,
        payrollId,
        amount: Number(a.amount ?? 0),
        state: mapAdvanceShortState(a.state ?? 'pending'),
        isDeducted: Boolean(a.isDeducted),
        date: parseDate(a.date) ?? new Date(),
        notes: a.note ?? null,
      };

      let localId: string;
      if (existingId) {
        await prisma.advanceShort.update({ where: { id: existingId }, data: payload });
        localId = existingId;
      } else {
        const created = await prisma.advanceShort.create({ data: payload });
        localId = created.id;
      }

      await saveOdooMap('advance_short', localId, a.id);
      stats.advancesShort += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn({ err, advanceId: a.id }, 'pull advance short failed');
    }
  }
}

type OdooAdvanceLong = {
  id: number;
  employeeId?: number;
  employeeCode?: string;
  totalAmount?: number;
  installments?: number;
  installmentAmount?: number;
  startDate?: string;
  nextDeductionDate?: string;
  state?: string;
  note?: string;
};

export async function pullAdvancesLongFromOdoo(stats: OdooPullStats, limit = DEFAULT_LIMIT): Promise<void> {
  const data = await odooClient.odooCall<{ items?: OdooAdvanceLong[] }>(
    '/api/biotime/advances/long/list',
    { limit },
  );

  for (const a of data.items ?? []) {
    try {
      const employeeId = await resolveLocalEmployee(a.employeeId, a.employeeCode);
      if (!employeeId) {
        stats.skipped += 1;
        continue;
      }

      const startDate = parseDate(a.startDate);
      const existingId = await findLocalByOdooMap('advance_long', a.id);

      const payload = {
        employeeId,
        totalAmount: Number(a.totalAmount ?? 0),
        installments: Number(a.installments ?? 1),
        installmentAmount: Number(a.installmentAmount ?? 0),
        state: mapAdvanceLongState(a.state ?? 'draft'),
        date: startDate ?? new Date(),
        startDate,
        nextDeductionDate: parseDate(a.nextDeductionDate ?? undefined),
        notes: a.note ?? null,
      };

      let localId: string;
      if (existingId) {
        await prisma.advanceLong.update({ where: { id: existingId }, data: payload });
        localId = existingId;
      } else {
        const created = await prisma.advanceLong.create({ data: payload });
        localId = created.id;
      }

      await saveOdooMap('advance_long', localId, a.id);
      stats.advancesLong += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn({ err, advanceId: a.id }, 'pull advance long failed');
    }
  }
}

type OdooPayrollLine = {
  id: number;
  sequence?: number;
  employeeId?: number;
  employeeCode?: string;
  basicSalary?: number;
  workingDays?: number;
  overtimeHours?: number;
  workDaysSalary?: number;
  overtimeAmount?: number;
  totalEarnings?: number;
  lateDeduction?: number;
  absentDeduction?: number;
  sickDeduction?: number;
  socialInsurance?: number;
  medicalInsurance?: number;
  salaryAdvance?: number;
  longTermAdvance?: number;
  manualDebit?: number;
  fines?: number;
  totalDeductions?: number;
  netSalary?: number;
};

type OdooPayroll = {
  id: number;
  name?: string;
  state?: string;
  dateFrom?: string;
  dateTo?: string;
  shiftGridId?: number | false;
  deviceId?: number | false;
  totalEarnings?: number;
  totalDeductions?: number;
  totalNet?: number;
  journalEntryId?: number | false;
  lines?: OdooPayrollLine[];
};

export async function pullPayrollsFromOdoo(stats: OdooPullStats, limit = 50): Promise<void> {
  const list = await odooClient.odooCall<{ items?: OdooPayroll[] }>(
    '/api/biotime/payroll/list',
    { limit },
  );

  for (const p of list.items ?? []) {
    try {
      const detail = await odooClient.odooCall<{ payroll?: OdooPayroll }>(
        '/api/biotime/payroll/get',
        { payrollId: p.id },
      );
      const payroll = detail.payroll ?? p;
      const dateFrom = parseDate(payroll.dateFrom);
      const dateTo = parseDate(payroll.dateTo);
      if (!dateFrom || !dateTo) {
        stats.skipped += 1;
        continue;
      }

      const shiftGridId = payroll.shiftGridId
        ? await resolveLocalShiftGrid(Number(payroll.shiftGridId))
        : null;
      const deviceId = await resolveLocalDevice(payroll.deviceId);
      const existingId = await findLocalByOdooMap('payroll', payroll.id);

      const header = {
        name: payroll.name ?? `Payroll ${payroll.id}`,
        dateFrom,
        dateTo,
        state: mapPayrollState(payroll.state ?? 'draft'),
        shiftGridId,
        deviceId,
        totalGross: Number(payroll.totalEarnings ?? 0),
        totalNet: Number(payroll.totalNet ?? 0),
        totalDeductions: Number(payroll.totalDeductions ?? 0),
        journalEntryId: payroll.journalEntryId ? String(payroll.journalEntryId) : null,
      };

      let localPayrollId: string;
      if (existingId) {
        await prisma.payroll.update({ where: { id: existingId }, data: header });
        localPayrollId = existingId;
        await prisma.payrollLine.deleteMany({ where: { payrollId: localPayrollId } });
      } else {
        const created = await prisma.payroll.create({ data: header });
        localPayrollId = created.id;
      }

      await saveOdooMap('payroll', localPayrollId, payroll.id);
      stats.payrolls += 1;

      const seenEmployees = new Set<string>();
      for (const line of payroll.lines ?? []) {
        const employeeId = await resolveLocalEmployee(line.employeeId, line.employeeCode);
        if (!employeeId) {
          stats.skipped += 1;
          continue;
        }
        if (seenEmployees.has(employeeId)) {
          stats.skipped += 1;
          continue;
        }
        seenEmployees.add(employeeId);

        const lineData = {
          sequence: Number(line.sequence ?? 0),
          employeeCode: line.employeeCode ?? null,
          basicSalary: Number(line.basicSalary ?? 0),
          workingDays: Number(line.workingDays ?? 0),
          workDaysSalary: Number(line.workDaysSalary ?? 0),
          grossSalary: Number(line.totalEarnings ?? 0),
          totalEarnings: Number(line.totalEarnings ?? 0),
          overtimeHours: Number(line.overtimeHours ?? 0),
          overtimeAmount: Number(line.overtimeAmount ?? 0),
          lateDeduction: Number(line.lateDeduction ?? 0),
          absentDeduction: Number(line.absentDeduction ?? 0),
          sickDeduction: Number(line.sickDeduction ?? 0),
          socialInsurance: Number(line.socialInsurance ?? 0),
          medicalInsurance: Number(line.medicalInsurance ?? 0),
          advanceShortTotal: Number(line.salaryAdvance ?? 0),
          advanceLongTotal: Number(line.longTermAdvance ?? 0),
          manualDebit: Number(line.manualDebit ?? 0),
          fines: Number(line.fines ?? 0),
          totalDeductions: Number(line.totalDeductions ?? 0),
          netSalary: Number(line.netSalary ?? 0),
        };

        await prisma.payrollLine.upsert({
          where: { payrollId_employeeId: { payrollId: localPayrollId, employeeId } },
          create: { payrollId: localPayrollId, employeeId, ...lineData },
          update: lineData,
        });
        stats.payrollLines += 1;
      }
    } catch (err) {
      stats.errors += 1;
      logger.warn({ err, payrollId: p.id }, 'pull payroll failed');
    }
  }
}

export async function pullAllFromOdoo(options: OdooPullOptions = {}): Promise<OdooPullStats> {
  const stats: OdooPullStats = {
    employees: 0,
    shifts: 0,
    assignments: 0,
    shiftGrids: 0,
    gridLines: 0,
    deductions: 0,
    advancesShort: 0,
    advancesLong: 0,
    payrolls: 0,
    payrollLines: 0,
    skipped: 0,
    errors: 0,
  };

  const conn = await odooClient.testOdooConnection();
  if (!conn.ok) {
    throw new Error(`Odoo connection failed: ${conn.message}`);
  }

  const pullAll = !options.employees
    && !options.shifts
    && !options.assignments
    && !options.shiftGrids
    && !options.deductions
    && !options.advancesShort
    && !options.advancesLong
    && !options.payrolls;

  const limit = options.listLimit ?? DEFAULT_LIMIT;

  if (pullAll || options.employees) {
    logger.info('Pulling employees from Odoo…');
    await pullEmployeesFromOdoo(stats);
  }

  if (pullAll || options.shifts) {
    logger.info('Pulling shifts from Odoo…');
    await pullShiftsFromOdoo(stats);
  }

  if (pullAll || options.assignments) {
    logger.info('Pulling shift assignments from Odoo…');
    await pullShiftAssignmentsFromOdoo(stats, limit);
  }

  if (pullAll || options.shiftGrids) {
    logger.info('Pulling shift grids from Odoo…');
    await pullShiftGridsFromOdoo(stats, {
      odooGridId: options.odooGridId,
      limit: options.gridLimit ?? 20,
    });
  }

  if (pullAll || options.deductions) {
    logger.info('Pulling deductions from Odoo…');
    await pullDeductionsFromOdoo(stats, limit);
  }

  if (pullAll || options.advancesShort) {
    logger.info('Pulling short advances from Odoo…');
    await pullAdvancesShortFromOdoo(stats, limit);
  }

  if (pullAll || options.advancesLong) {
    logger.info('Pulling long advances from Odoo…');
    await pullAdvancesLongFromOdoo(stats, limit);
  }

  if (pullAll || options.payrolls) {
    logger.info('Pulling payrolls from Odoo…');
    await pullPayrollsFromOdoo(stats, limit);
  }

  return stats;
}
