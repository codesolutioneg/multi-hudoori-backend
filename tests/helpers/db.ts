import bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { prisma, prismaBase } from '../../src/prisma/client';
import { enterTenant, runWithTenant } from '../../src/tenant/context';
import { ensureBioTimeConfigFromEnv } from '../../src/bootstrap/biotimeConfig';
import { ensureOdooConfigFromEnv } from '../../src/bootstrap/odooConfig';

/**
 * Tables truncated between E2E specs, children before parents.
 * Keep in sync with prisma/schema.prisma when models are added.
 */
const TABLES = [
  'advance_requests',
  'advance_long_payments',
  'advances_long',
  'advances_short',
  'advance_loan_import_lines',
  'advance_loan_imports',
  'deductions',
  'payroll_lines',
  'payrolls',
  'overtime_analyses',
  'attendance_edit_requests',
  'certificate_requests',
  'salary_requests',
  'shift_change_requests',
  'loan_requests',
  'leave_requests',
  'attendances',
  'transactions',
  'shift_grid_lines',
  'shift_grids',
  'shift_assignments',
  'shifts',
  'employee_custodies',
  'custody_types',
  'hiring_appointments',
  'employee_mappings',
  'employee_profiles',
  'department_mappings',
  'departments',
  'job_titles',
  'job_levels',
  'archive_reasons',
  'devices',
  'insurance_companies',
  'dashboard_notification_reads',
  'audit_logs',
  'user_feature_grants',
  'api_tokens',
  'users',
  'locations',
  'odoo_sync_maps',
  'sync_jobs',
  'system_counters',
  'biotime_config',
  'odoo_config',
  'companies',
] as const;

let existingTables: string[] | null = null;
let defaultCompanyId: string | null = null;

async function resolveExistingTables(): Promise<string[]> {
  if (existingTables) return existingTables;
  const rows = await prismaBase.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `;
  const present = new Set(rows.map((r) => r.table_name));
  existingTables = TABLES.filter((t) => present.has(t));
  return existingTables;
}

/** Wipe all business data including companies (multi-tenant test DB). */
export async function resetDatabase(): Promise<void> {
  defaultCompanyId = null;
  const tables = await resolveExistingTables();
  const list = tables.map((t) => `"public"."${t}"`).join(', ');
  await prismaBase.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Ensure a default company exists for legacy helpers / non-isolation specs. */
export async function ensureDefaultCompany(): Promise<string> {
  if (defaultCompanyId) return defaultCompanyId;
  let company = await prismaBase.company.findFirst({ where: { code: 'testco' } });
  if (!company) {
    company = await prismaBase.company.create({
      data: { code: 'testco', name: 'Test Company', active: true },
    });
    await ensureBioTimeConfigFromEnv(company.id);
    await ensureOdooConfigFromEnv(company.id);
  }
  defaultCompanyId = company.id;
  return company.id;
}

export async function ensureBioTimeConfig(): Promise<void> {
  const companyId = await ensureDefaultCompany();
  await ensureBioTimeConfigFromEnv(companyId);
}

export type SeededUser = {
  userId: string;
  login: string;
  password: string;
  role: UserRole;
  token: string;
  employeeId?: string;
  locationId?: string | null;
  companyId: string;
};

/**
 * Creates a user plus a live API token, bypassing the login endpoint so that
 * specs which are not testing auth do not pay for bcrypt on every request.
 */
export async function createUser(opts: {
  login: string;
  role: UserRole;
  name?: string;
  password?: string;
  locationId?: string | null;
  companyId?: string;
  withEmployeeProfile?: boolean;
  employee?: { code?: string; name?: string; basicSalary?: number; locationId?: string | null };
}): Promise<SeededUser> {
  const companyId =
    opts.role === UserRole.PLATFORM_ADMIN
      ? null
      : opts.companyId ?? (await ensureDefaultCompany());
  const password = opts.password ?? 'Passw0rd!2026';

  const user = await prismaBase.user.create({
    data: {
      companyId,
      login: opts.login,
      email: opts.login.includes('@') ? opts.login : null,
      name: opts.name ?? opts.login,
      passwordHash: await bcrypt.hash(password, 4),
      role: opts.role,
      locationId: opts.locationId ?? null,
    },
  });

  let employeeId: string | undefined;
  if (companyId && (opts.withEmployeeProfile || opts.employee)) {
    const profile = await prismaBase.employeeProfile.create({
      data: {
        companyId,
        userId: user.id,
        name: opts.employee?.name ?? opts.name ?? opts.login,
        code: opts.employee?.code,
        basicSalary: opts.employee?.basicSalary ?? 3000,
        locationId: opts.employee?.locationId ?? opts.locationId ?? null,
      },
    });
    employeeId = profile.id;
  }

  const expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const token = `test-token-${user.id}`;
  await prismaBase.apiToken.create({
    data: { token, userId: user.id, deviceInfo: 'vitest', expiryDate },
  });

  return {
    userId: user.id,
    login: opts.login,
    password,
    role: opts.role,
    token,
    employeeId,
    locationId: user.locationId,
    companyId: companyId ?? '',
  };
}

/** One user per role, for permission-matrix specs. */
export async function createUserPerRole(): Promise<Record<UserRole, SeededUser>> {
  const companyId = await ensureDefaultCompany();
  const roles = Object.values(UserRole);
  const out = {} as Record<UserRole, SeededUser>;
  for (const role of roles) {
    out[role] = await createUser({
      login: `${role.toLowerCase()}@test.local`,
      role,
      name: role,
      companyId: role === UserRole.PLATFORM_ADMIN ? undefined : companyId,
      withEmployeeProfile: role === UserRole.EMPLOYEE,
    });
  }
  return out;
}

export async function createShift(overrides: Record<string, unknown> = {}) {
  const companyId = (overrides.companyId as string | undefined) ?? (await ensureDefaultCompany());
  return runWithTenant({ companyId, isImpersonatingCompany: false, actorUserId: 'test' }, async () => {
    enterTenant({ companyId, isImpersonatingCompany: false, actorUserId: 'test' });
    return prisma.shift.create({
      data: {
        name: 'Morning',
        startTime: '08:00',
        endTime: '17:00',
        gracePeriodIn: 20,
        gracePeriodOut: 15,
        ...overrides,
        companyId,
      } as never,
    });
  });
}

export async function createLocation(overrides: Record<string, unknown> = {}) {
  const companyId = (overrides.companyId as string | undefined) ?? (await ensureDefaultCompany());
  return runWithTenant({ companyId, isImpersonatingCompany: false, actorUserId: 'test' }, async () => {
    enterTenant({ companyId, isImpersonatingCompany: false, actorUserId: 'test' });
    return prisma.location.create({
      data: { name: 'Main Branch', code: 'LOC-001', ...overrides, companyId } as never,
    });
  });
}
