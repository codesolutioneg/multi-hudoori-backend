import crypto from 'crypto';
import { AdvanceState, DeductionState, PayrollState } from '@prisma/client';
import { prisma } from '../../prisma/client';
import { logger } from '../../utils/logger';
import * as odooClient from './odooClient.service';

const DEDUCTION_TYPE_MAP: Record<string, string> = {
  manual_debit: 'manual_debit',
  grouped_checks: 'grouped_checks',
  personal_checks: 'personal_checks',
  check: 'personal_checks',
  health_certificates: 'health_certificates',
  fraction: 'fraction',
  fines: 'fines',
  documents: 'documents',
  admin: 'admin',
  previous_settlements: 'previous_settlements',
  previous_insurance: 'previous_insurance',
};

type PushStats = {
  employees: number;
  deductions: number;
  advancesShort: number;
  advancesLong: number;
  payrolls: number;
  skipped: number;
  errors: number;
};

function contentHash(obj: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function getMap(entityType: string, localId: string) {
  return prisma.odooSyncMap.findUnique({
    where: { entityType_localId: { entityType, localId } },
  });
}

async function saveMap(
  entityType: string,
  localId: string,
  odooId: string,
  hash?: string,
): Promise<void> {
  await prisma.odooSyncMap.upsert({
    where: { entityType_localId: { entityType, localId } },
    create: { entityType, localId, odooId, contentHash: hash },
    update: { odooId, contentHash: hash, syncedAt: new Date() },
  });
}

async function employeeCode(localEmployeeId: string): Promise<string | null> {
  const emp = await prisma.employeeProfile.findUnique({
    where: { id: localEmployeeId },
    include: { mapping: true },
  });
  if (!emp) return null;
  const code = emp.mapping?.biotimeEmpCode ?? emp.code ?? emp.identificationId;
  return code?.trim() || null;
}

async function resolveOdooEmployeeId(localEmployeeId: string): Promise<number | null> {
  const mapped = await getMap('employee', localEmployeeId);
  if (mapped) {
    const id = parseInt(mapped.odooId, 10);
    if (id > 0) return id;
  }

  const code = await employeeCode(localEmployeeId);
  if (!code) return null;

  const odooId = await odooClient.odooFindEmployeeIdByCode(code);
  if (odooId) await saveMap('employee', localEmployeeId, String(odooId));
  return odooId;
}

async function shouldPush(
  entityType: string,
  localId: string,
  hash: string,
): Promise<boolean> {
  const mapped = await getMap(entityType, localId);
  if (!mapped) return true;
  return mapped.contentHash !== hash;
}

export async function getOdooPushStatus() {
  const config = await odooClient.getOdooConfig();
  const [
    deductionTotal,
    advanceShortTotal,
    advanceLongTotal,
    payrollTotal,
    employeeTotal,
    maps,
  ] = await Promise.all([
    prisma.deduction.count({ where: { state: { not: DeductionState.cancelled } } }),
    prisma.advanceShort.count({ where: { state: { not: AdvanceState.cancelled } } }),
    prisma.advanceLong.count({ where: { state: { not: AdvanceState.cancelled } } }),
    prisma.payroll.count({
      where: { state: { in: [PayrollState.calculated, PayrollState.confirmed] } },
    }),
    prisma.employeeProfile.count({ where: { active: true } }),
    prisma.odooSyncMap.groupBy({ by: ['entityType'], _count: { _all: true } }),
  ]);

  const syncedByType = Object.fromEntries(
    maps.map((m) => [m.entityType, m._count._all]),
  );

  return {
    config: odooClient.odooConfigJson(config),
    totals: {
      employees: employeeTotal,
      deductions: deductionTotal,
      advancesShort: advanceShortTotal,
      advancesLong: advanceLongTotal,
      payrolls: payrollTotal,
    },
    synced: syncedByType,
  };
}

async function pushEmployees(stats: PushStats, report: (msg: string, pct: number) => Promise<void>) {
  const employees = await prisma.employeeProfile.findMany({
    where: { active: true },
    include: { mapping: true },
  });

  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];
    const hash = contentHash({
      name: emp.name,
      displayName: emp.displayName,
      workPhone: emp.workPhone,
      mobilePhone: emp.mobilePhone,
      workEmail: emp.workEmail,
      active: emp.active,
    });

    if (!(await shouldPush('employee_profile', emp.id, hash))) {
      stats.skipped++;
      continue;
    }

    const odooId = await resolveOdooEmployeeId(emp.id);
    if (!odooId) {
      stats.skipped++;
      continue;
    }

    try {
      await odooClient.odooCall('/api/biotime/employees/update', {
        employeeId: odooId,
        name: emp.displayName ?? emp.name,
        identificationId: emp.identificationId ?? emp.code ?? undefined,
        workPhone: emp.workPhone ?? '',
        mobilePhone: emp.mobilePhone ?? '',
        workEmail: emp.workEmail ?? '',
        gender: emp.gender ?? '',
        active: emp.active,
      });
      await saveMap('employee_profile', emp.id, String(odooId), hash);
      stats.employees++;
    } catch (err) {
      stats.errors++;
      logger.warn({ err, employeeId: emp.id }, 'Odoo employee push failed');
    }

    if (i % 5 === 0) {
      await report(`موظفون: ${stats.employees}…`, 10 + Math.floor((i / employees.length) * 20));
    }
  }
}

async function pushDeductions(stats: PushStats, report: (msg: string, pct: number) => Promise<void>) {
  const rows = await prisma.deduction.findMany({
    where: { state: { not: DeductionState.cancelled } },
    orderBy: { createdAt: 'asc' },
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const hash = contentHash({
      employeeId: row.employeeId,
      type: row.type,
      amount: row.amount,
      date: fmtDate(row.date),
      notes: row.notes,
      state: row.state,
    });

    if (!(await shouldPush('deduction', row.id, hash))) {
      stats.skipped++;
      continue;
    }

    const code = await employeeCode(row.employeeId);
    if (!code) {
      stats.skipped++;
      continue;
    }

    try {
      const data = await odooClient.odooCall<{ deduction?: { id: number } }>(
        '/api/biotime/deductions/create',
        {
          employeeCode: code,
          deductionType: DEDUCTION_TYPE_MAP[row.type] ?? row.type,
          amount: row.amount,
          date: fmtDate(row.date),
          note: row.notes ?? '',
        },
      );
      const odooId = data.deduction?.id;
      if (odooId) await saveMap('deduction', row.id, String(odooId), hash);
      stats.deductions++;
    } catch (err) {
      stats.errors++;
      logger.warn({ err, deductionId: row.id }, 'Odoo deduction push failed');
    }

    if (i % 10 === 0) {
      await report(`استقطاعات: ${stats.deductions}…`, 30 + Math.floor((i / rows.length) * 15));
    }
  }
}

async function pushAdvancesShort(stats: PushStats, report: (msg: string, pct: number) => Promise<void>) {
  const rows = await prisma.advanceShort.findMany({
    where: { state: AdvanceState.pending },
    orderBy: { createdAt: 'asc' },
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const hash = contentHash({
      employeeId: row.employeeId,
      amount: row.amount,
      date: fmtDate(row.date),
      notes: row.notes,
    });

    if (!(await shouldPush('advance_short', row.id, hash))) {
      stats.skipped++;
      continue;
    }

    const code = await employeeCode(row.employeeId);
    if (!code) {
      stats.skipped++;
      continue;
    }

    try {
      const data = await odooClient.odooCall<{ advance?: { id: number } }>(
        '/api/biotime/advances/short/create',
        {
          employeeCode: code,
          amount: row.amount,
          date: fmtDate(row.date),
          note: row.notes ?? '',
        },
      );
      const odooId = data.advance?.id;
      if (odooId) await saveMap('advance_short', row.id, String(odooId), hash);
      stats.advancesShort++;
    } catch (err) {
      stats.errors++;
      logger.warn({ err, advanceId: row.id }, 'Odoo short advance push failed');
    }

    if (i % 5 === 0) {
      await report(`سلف قصيرة: ${stats.advancesShort}…`, 45 + Math.floor((i / rows.length) * 10));
    }
  }
}

async function pushAdvancesLong(stats: PushStats, report: (msg: string, pct: number) => Promise<void>) {
  const rows = await prisma.advanceLong.findMany({
    where: { state: AdvanceState.running },
    orderBy: { createdAt: 'asc' },
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const hash = contentHash({
      employeeId: row.employeeId,
      totalAmount: row.totalAmount,
      installments: row.installments,
      date: fmtDate(row.date),
      notes: row.notes,
    });

    if (!(await shouldPush('advance_long', row.id, hash))) {
      stats.skipped++;
      continue;
    }

    const code = await employeeCode(row.employeeId);
    if (!code) {
      stats.skipped++;
      continue;
    }

    try {
      const data = await odooClient.odooCall<{ advance?: { id: number } }>(
        '/api/biotime/advances/long/create',
        {
          employeeCode: code,
          totalAmount: row.totalAmount,
          installments: row.installments,
          startDate: fmtDate(row.date),
          note: row.notes ?? '',
          confirm: true,
        },
      );
      const odooId = data.advance?.id;
      if (odooId) await saveMap('advance_long', row.id, String(odooId), hash);
      stats.advancesLong++;
    } catch (err) {
      stats.errors++;
      logger.warn({ err, advanceId: row.id }, 'Odoo long advance push failed');
    }

    if (i % 5 === 0) {
      await report(`سلف طويلة: ${stats.advancesLong}…`, 55 + Math.floor((i / rows.length) * 10));
    }
  }
}

async function pushPayrolls(stats: PushStats, report: (msg: string, pct: number) => Promise<void>) {
  const rows = await prisma.payroll.findMany({
    where: { state: { in: [PayrollState.calculated, PayrollState.confirmed] } },
    orderBy: { createdAt: 'asc' },
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const hash = contentHash({
      dateFrom: fmtDate(row.dateFrom),
      dateTo: fmtDate(row.dateTo),
      state: row.state,
      totalNet: row.totalNet,
    });

    if (!(await shouldPush('payroll', row.id, hash))) {
      stats.skipped++;
      continue;
    }

    try {
      const created = await odooClient.odooCall<{ payroll?: { id: number } }>(
        '/api/biotime/payroll/create',
        {
          dateFrom: fmtDate(row.dateFrom),
          dateTo: fmtDate(row.dateTo),
        },
      );
      const odooPayrollId = created.payroll?.id;
      if (!odooPayrollId) {
        stats.errors++;
        continue;
      }

      await odooClient.odooCall('/api/biotime/payroll/calculate', {
        payrollId: odooPayrollId,
      });

      if (row.state === PayrollState.confirmed) {
        await odooClient.odooCall('/api/biotime/payroll/confirm', {
          payrollId: odooPayrollId,
        });
      }

      await saveMap('payroll', row.id, String(odooPayrollId), hash);
      stats.payrolls++;
    } catch (err) {
      stats.errors++;
      logger.warn({ err, payrollId: row.id }, 'Odoo payroll push failed');
    }

    if (i % 2 === 0) {
      await report(`رواتب: ${stats.payrolls}…`, 65 + Math.floor((i / rows.length) * 30));
    }
  }
}

export async function pushAllToOdoo(
  onProgress?: (message: string, progress: number) => Promise<void>,
): Promise<string> {
  const report = async (message: string, progress: number) => {
    if (onProgress) await onProgress(message, progress);
  };

  const conn = await odooClient.testOdooConnection();
  if (!conn.ok) throw new Error(conn.message);

  const stats: PushStats = {
    employees: 0,
    deductions: 0,
    advancesShort: 0,
    advancesLong: 0,
    payrolls: 0,
    skipped: 0,
    errors: 0,
  };

  await report('رفع الموظفين…', 5);
  await pushEmployees(stats, report);

  await report('رفع الاستقطاعات…', 30);
  await pushDeductions(stats, report);

  await report('رفع السلف القصيرة…', 45);
  await pushAdvancesShort(stats, report);

  await report('رفع السلف الطويلة…', 55);
  await pushAdvancesLong(stats, report);

  await report('رفع كشوف الرواتب…', 65);
  await pushPayrolls(stats, report);

  const config = await odooClient.getOdooConfig();
  await prisma.odooConfig.update({
    where: { id: config.id },
    data: { lastPushAt: new Date() },
  });

  await report('اكتمل الرفع', 100);

  return (
    `موظفون ${stats.employees}، استقطاعات ${stats.deductions}، ` +
    `سلف قصيرة ${stats.advancesShort}، سلف طويلة ${stats.advancesLong}، ` +
    `رواتب ${stats.payrolls} — تخطي ${stats.skipped}، أخطاء ${stats.errors}`
  );
}
