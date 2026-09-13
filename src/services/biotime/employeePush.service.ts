import { prisma } from '../../prisma/client';
import { logger } from '../../utils/logger';
import {
  BioTimePushSnapshot,
  EmployeePushRow,
  evaluateBioTimePush,
  snapshotDiffToUpdatePayload,
  snapshotToCreatePayload,
  splitEmployeeName,
  diffPushSnapshots,
} from './employeeBiotimeFingerprint';
import { BioTimeConnector } from './biotimeConnector.service';

export type EmployeePushResult = {
  pushed: number;
  failed: number;
  skipped: number;
};

async function loadEmployee(employeeId: string): Promise<EmployeePushRow> {
  const employee = await prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    include: { mapping: true, department: true },
  });
  if (!employee) throw new Error('Employee not found');
  return employee;
}

async function persistPushSuccess(
  employee: EmployeePushRow,
  snapshot: BioTimePushSnapshot,
  hash: string,
  biotimeId: number,
): Promise<void> {
  const { firstName, lastName } = splitEmployeeName(employee.displayName ?? employee.name);

  if (employee.mapping) {
    await prisma.employeeMapping.update({
      where: { id: employee.mapping.id },
      data: {
        biotimeEmpId: biotimeId,
        biotimeEmpCode: snapshot.empCode || employee.mapping.biotimeEmpCode,
        firstName,
        lastName,
        email: snapshot.email || employee.mapping.email,
        mobile: snapshot.mobile || employee.mapping.mobile,
        gender: snapshot.gender || employee.mapping.gender,
        biotimeDepartmentId: snapshot.departmentId ?? employee.mapping.biotimeDepartmentId,
        pushContentHash: hash,
        lastSync: new Date(),
      },
    });
  } else {
    await prisma.employeeMapping.create({
      data: {
        employeeId: employee.id,
        biotimeEmpId: biotimeId,
        biotimeEmpCode: snapshot.empCode,
        firstName,
        lastName,
        email: snapshot.email || null,
        mobile: snapshot.mobile || null,
        gender: snapshot.gender || null,
        biotimeDepartmentId: snapshot.departmentId,
        pushContentHash: hash,
        lastSync: new Date(),
      },
    });
  }

  await prisma.employeeProfile.update({
    where: { id: employee.id },
    data: { biotimeSynced: true },
  });
}

async function markSyncedWithoutPush(employeeId: string, hash: string): Promise<void> {
  const employee = await prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    include: { mapping: true },
  });
  if (!employee?.mapping) {
    await prisma.employeeProfile.update({
      where: { id: employeeId },
      data: { biotimeSynced: true },
    });
    return;
  }

  await prisma.employeeMapping.update({
    where: { id: employee.mapping.id },
    data: { pushContentHash: hash, lastSync: employee.mapping.lastSync ?? new Date() },
  });
  await prisma.employeeProfile.update({
    where: { id: employeeId },
    data: { biotimeSynced: true },
  });
}

async function refreshBiotimeId(
  connector: BioTimeConnector,
  mapping: NonNullable<EmployeePushRow['mapping']>,
  code: string,
): Promise<number | null> {
  const row = await connector.findEmployeeByCode(code);
  if (!row?.id) return null;

  await prisma.employeeMapping.update({
    where: { id: mapping.id },
    data: { biotimeEmpId: row.id, biotimeEmpCode: code || mapping.biotimeEmpCode },
  });
  return row.id;
}

/**
 * Push one employee's essential profile fields to BioTime (create or partial update).
 * Skips the HTTP call when fingerprint matches last successful push.
 */
export async function pushEmployeeToBioTime(employeeId: string): Promise<'pushed' | 'skipped'> {
  const employee = await loadEmployee(employeeId);
  const decision = evaluateBioTimePush(employee);

  if (!decision.needed) {
    await markSyncedWithoutPush(employeeId, decision.hash);
    logger.debug(
      { employeeId, reason: decision.reason },
      'BioTime employee push skipped — already in sync',
    );
    return 'skipped';
  }

  const config = await prisma.bioTimeConfig.findFirst();
  const connector = await BioTimeConnector.fromDb();
  const { snapshot, hash, baseline, create } = decision;

  if (create) {
    const createPayload = snapshotToCreatePayload(snapshot, config?.defaultBiotimeAreaId);
    const created = (await connector.createEmployee(createPayload)) as {
      data?: { id: number };
      id?: number;
    };
    const biotimeId = created.data?.id ?? created.id;
    if (!biotimeId) throw new Error('BioTime did not return employee id after create');

    await persistPushSuccess(employee, snapshot, hash, biotimeId);
    return 'pushed';
  }

  const diff = diffPushSnapshots(snapshot, baseline);
  const payload = snapshotDiffToUpdatePayload(diff, snapshot);

  if (!Object.keys(payload).length) {
    await markSyncedWithoutPush(employeeId, hash);
    return 'skipped';
  }

  if (!employee.mapping) {
    throw new Error(`لا يوجد ربط BioTime للموظف ${employee.name}`);
  }

  let biotimeId = employee.mapping.biotimeEmpId;
  if (!biotimeId) {
    throw new Error(`لا يوجد معرف BioTime للموظف ${employee.name}`);
  }

  try {
    await connector.updateEmployee(biotimeId, payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('404') && !msg.includes('Not Found')) throw err;
    const code = snapshot.empCode;
    const refreshed = code ? await refreshBiotimeId(connector, employee.mapping, code) : null;
    if (!refreshed) throw new Error(`الموظف ${code || employee.name} غير موجود في BioTime`);
    biotimeId = refreshed;
    await connector.updateEmployee(biotimeId, payload);
  }

  await persistPushSuccess(employee, snapshot, hash, biotimeId);
  logger.info(
    { employeeId, fields: Object.keys(payload) },
    'BioTime employee delta push',
  );
  return 'pushed';
}

/** Push only employees whose essential BioTime fingerprint changed (smart batch). */
export async function pushPendingEmployeesToBioTime(): Promise<EmployeePushResult> {
  const candidates = await prisma.employeeProfile.findMany({
    where: {
      active: true,
      OR: [
        { biotimeSynced: false },
        { mapping: { pushContentHash: null, biotimeEmpId: { not: null } } },
      ],
    },
    include: { mapping: true, department: true },
    orderBy: { updatedAt: 'asc' },
  });

  const result: EmployeePushResult = { pushed: 0, failed: 0, skipped: 0 };

  for (const row of candidates) {
    const decision = evaluateBioTimePush(row);
    if (!decision.needed) {
      result.skipped++;
      continue;
    }

    try {
      const outcome = await pushEmployeeToBioTime(row.id);
      if (outcome === 'pushed') result.pushed++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      logger.warn({ err, employeeId: row.id, name: row.name }, 'BioTime employee push failed');
    }
  }

  return result;
}

/** Dry-run: how many employees would be pushed (no HTTP calls). */
export async function previewPendingBioTimePush(): Promise<{
  pending: number;
  unchanged: number;
  noCode: number;
}> {
  const candidates = await prisma.employeeProfile.findMany({
    where: { active: true },
    include: { mapping: true, department: true },
  });

  let pending = 0;
  let unchanged = 0;
  let noCode = 0;

  for (const row of candidates) {
    const decision = evaluateBioTimePush(row);
    if (decision.reason === 'no_code') noCode++;
    else if (!decision.needed) unchanged++;
    else pending++;
  }

  return { pending, unchanged, noCode };
}
