/**
 * List emp_code values from the BioTime server (not limited to Hudoori profiles).
 */
import { prisma } from '../prisma/client';
import { BioTimeConnector } from './biotime/biotimeConnector.service';
import {
  BIOTIME_LOCAL_FALLBACK_MESSAGE,
  isBioTimeConfigured,
  isBioTimeUnavailableError,
} from './biotime/biotimeAvailability.service';

/** Unique punch emp codes stored locally (profiles, mappings, transactions). */
export async function listLocalEmpCodes(): Promise<string[]> {
  const codes = new Set<string>();

  const profiles = await prisma.employeeProfile.findMany({
    select: {
      code: true,
      identificationId: true,
      barcode: true,
      mapping: { select: { biotimeEmpCode: true } },
    },
  });
  for (const row of profiles) {
    for (const raw of [
      row.code,
      row.identificationId,
      row.barcode,
      row.mapping?.biotimeEmpCode,
    ]) {
      const code = String(raw ?? '').trim();
      if (code) codes.add(code);
    }
  }

  const txCodes = await prisma.transaction.findMany({
    distinct: ['empCode'],
    select: { empCode: true },
    where: { empCode: { not: null } },
  });
  for (const row of txCodes) {
    const code = String(row.empCode ?? '').trim();
    if (code) codes.add(code);
  }

  return [...codes].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** Paginate BioTime employees and collect unique emp_code values. */
export async function listAllBiotimeEmpCodes(): Promise<string[]> {
  const connector = await BioTimeConnector.fromDb();
  const codes = new Set<string>();
  let page = 1;

  while (page <= 200) {
    const response = await connector.getEmployees(page, 200);
    const rows = response.data ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const code = String(row.emp_code ?? '').trim();
      if (code) codes.add(code);
    }
    const total = response.count ?? 0;
    if (total > 0 && page * 200 >= total) break;
    if (rows.length < 200) break;
    page += 1;
  }

  return [...codes].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * BioTime list when configured; otherwise (or on connection errors) local stored codes.
 */
export async function listAllEmpCodesForPunchReport(): Promise<{
  codes: string[];
  usedLocal: boolean;
  fallbackMessage?: string;
}> {
  if (!(await isBioTimeConfigured())) {
    const codes = await listLocalEmpCodes();
    return {
      codes,
      usedLocal: true,
      fallbackMessage: BIOTIME_LOCAL_FALLBACK_MESSAGE,
    };
  }
  try {
    const codes = await listAllBiotimeEmpCodes();
    return { codes, usedLocal: false };
  } catch (err) {
    if (!isBioTimeUnavailableError(err)) throw err;
    const codes = await listLocalEmpCodes();
    return {
      codes,
      usedLocal: true,
      fallbackMessage: BIOTIME_LOCAL_FALLBACK_MESSAGE,
    };
  }
}
