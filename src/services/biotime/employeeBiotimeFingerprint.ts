import crypto from 'crypto';
import { EmployeeMapping, EmployeeProfile, Department } from '@prisma/client';

/** Profile fields that affect what we send to BioTime personnel API (essential HR identity only). */
export const BIOTIME_PUSH_PROFILE_FIELDS = new Set([
  'name',
  'displayName',
  'code',
  'identificationId',
  'barcode',
  'departmentId',
  'workEmail',
  'workPhone',
  'mobilePhone',
  'gender',
]);

/** Request/API param keys that should mark an employee dirty for BioTime push. */
export const BIOTIME_PUSH_PARAM_KEYS = new Set([
  ...BIOTIME_PUSH_PROFILE_FIELDS,
  'pushToBiotime',
]);

export type EmployeePushRow = EmployeeProfile & {
  mapping: EmployeeMapping | null;
  department: Department | null;
};

/** Minimal snapshot mirrored to BioTime — payroll/insurance/location fields are excluded. */
export type BioTimePushSnapshot = {
  empCode: string;
  firstName: string;
  lastName: string;
  departmentId: number | null;
  email: string;
  mobile: string;
  gender: string;
};

export type BioTimePushDecision = {
  needed: boolean;
  create: boolean;
  reason: 'no_code' | 'unchanged' | 'create' | 'delta';
  hash: string;
  snapshot: BioTimePushSnapshot;
  baseline: BioTimePushSnapshot | null;
};

export function splitEmployeeName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '.', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || '' };
}

export function genderToBiotime(gender?: string | null): string | undefined {
  if (!gender) return undefined;
  const g = gender.toLowerCase();
  if (g === 'male' || g === 'm' || g === 'ذكر') return 'M';
  if (g === 'female' || g === 'f' || g === 'أنثى' || g === 'انثى') return 'F';
  return undefined;
}

export function resolveEmpCode(employee: EmployeePushRow): string {
  return (
    employee.code?.trim() ||
    employee.identificationId?.trim() ||
    employee.mapping?.biotimeEmpCode?.trim() ||
    ''
  );
}

function norm(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

export function snapshotFromEmployee(employee: EmployeePushRow): BioTimePushSnapshot {
  const display = employee.displayName ?? employee.name;
  const { firstName, lastName } = splitEmployeeName(display);
  const code = resolveEmpCode(employee);
  const email = norm(employee.workEmail ?? employee.mapping?.email);
  const mobile = norm(employee.workPhone ?? employee.mobilePhone ?? employee.mapping?.mobile);
  const gender = norm(genderToBiotime(employee.gender ?? employee.mapping?.gender) ?? '');

  return {
    empCode: code,
    firstName: firstName || code || 'Employee',
    lastName,
    departmentId: employee.department?.biotimeDeptId ?? employee.mapping?.biotimeDepartmentId ?? null,
    email,
    mobile,
    gender,
  };
}

/** Last-known pushed state — derived from mapping cache (legacy rows without pushContentHash). */
export function snapshotFromMapping(employee: EmployeePushRow): BioTimePushSnapshot | null {
  const mapping = employee.mapping;
  if (!mapping) return null;

  const firstName = norm(mapping.firstName);
  const lastName = norm(mapping.lastName);
  if (!firstName && !mapping.biotimeEmpId) return null;

  return {
    empCode: norm(mapping.biotimeEmpCode ?? employee.code ?? employee.identificationId),
    firstName: firstName || '.',
    lastName,
    departmentId: mapping.biotimeDepartmentId ?? employee.department?.biotimeDeptId ?? null,
    email: norm(mapping.email),
    mobile: norm(mapping.mobile),
    gender: norm(genderToBiotime(mapping.gender) ?? ''),
  };
}

export function computePushFingerprint(snapshot: BioTimePushSnapshot): string {
  const ordered: BioTimePushSnapshot = {
    empCode: snapshot.empCode,
    firstName: snapshot.firstName,
    lastName: snapshot.lastName,
    departmentId: snapshot.departmentId,
    email: snapshot.email,
    mobile: snapshot.mobile,
    gender: snapshot.gender,
  };
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex').slice(0, 16);
}

export function diffPushSnapshots(
  current: BioTimePushSnapshot,
  baseline: BioTimePushSnapshot | null,
): Partial<BioTimePushSnapshot> {
  if (!baseline) return { ...current };

  const diff: Partial<BioTimePushSnapshot> = {};
  (Object.keys(current) as (keyof BioTimePushSnapshot)[]).forEach((key) => {
    if (current[key] !== baseline[key]) {
      (diff as Record<string, unknown>)[key] = current[key];
    }
  });
  return diff;
}

/** Map only changed essential fields to BioTime PATCH body (partial update). */
export function snapshotDiffToUpdatePayload(
  diff: Partial<BioTimePushSnapshot>,
  current: BioTimePushSnapshot,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if ('firstName' in diff || 'lastName' in diff || 'empCode' in diff) {
    payload.first_name = current.firstName;
    payload.last_name = current.lastName;
  }
  if ('departmentId' in diff && current.departmentId != null) {
    payload.department = current.departmentId;
  }
  if ('email' in diff && current.email) {
    payload.email = current.email;
  }
  if ('mobile' in diff && current.mobile) {
    payload.mobile = current.mobile;
  }
  if ('gender' in diff && current.gender) {
    payload.gender = current.gender;
  }

  return payload;
}

export function snapshotToCreatePayload(
  snapshot: BioTimePushSnapshot,
  defaultAreaId?: number | null,
): Record<string, unknown> {
  if (!snapshot.empCode) {
    throw new Error('Employee code is required to create in BioTime');
  }

  const payload: Record<string, unknown> = {
    emp_code: snapshot.empCode,
    first_name: snapshot.firstName,
    last_name: snapshot.lastName,
    area: [defaultAreaId || 1],
  };

  if (snapshot.departmentId != null) payload.department = snapshot.departmentId;
  if (snapshot.email) payload.email = snapshot.email;
  if (snapshot.mobile) payload.mobile = snapshot.mobile;
  if (snapshot.gender) payload.gender = snapshot.gender;

  return payload;
}

export function evaluateBioTimePush(employee: EmployeePushRow): BioTimePushDecision {
  const snapshot = snapshotFromEmployee(employee);
  const hash = computePushFingerprint(snapshot);
  const baseline = snapshotFromMapping(employee);
  const code = snapshot.empCode;
  const hasBioTimeId = Boolean(employee.mapping?.biotimeEmpId);

  if (!code && !hasBioTimeId) {
    return { needed: false, create: false, reason: 'no_code', hash, snapshot, baseline };
  }

  if (!hasBioTimeId) {
    return { needed: true, create: true, reason: 'create', hash, snapshot, baseline };
  }

  const storedHash = employee.mapping?.pushContentHash;
  if (storedHash && storedHash === hash && employee.biotimeSynced) {
    return { needed: false, create: false, reason: 'unchanged', hash, snapshot, baseline };
  }

  if (!storedHash && baseline) {
    const baselineHash = computePushFingerprint(baseline);
    if (baselineHash === hash && employee.biotimeSynced) {
      return { needed: false, create: false, reason: 'unchanged', hash, snapshot, baseline };
    }
  }

  if (employee.biotimeSynced && storedHash === hash) {
    return { needed: false, create: false, reason: 'unchanged', hash, snapshot, baseline };
  }

  return { needed: true, create: false, reason: 'delta', hash, snapshot, baseline };
}

export function paramKeysAffectBioTimePush(params: Record<string, unknown>): boolean {
  return Object.keys(params).some((key) => BIOTIME_PUSH_PARAM_KEYS.has(key));
}
