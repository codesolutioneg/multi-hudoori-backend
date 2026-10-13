/**
 * Non-destructive smoke against the running API + production DB (Vicanza).
 * Run: cd backend && npx tsx scripts/vicanza-live-smoke.ts
 *
 * Read-only + optional leave create then HR reject (cleanup).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.SMOKE_API_BASE ?? 'http://127.0.0.1:3003';
const COMPANY_CODE = 'vicanza';

type RoleSmoke = {
  label: string;
  login: string;
  password: string;
};

const prisma = new PrismaClient();

async function jsonRpc(
  path: string,
  params: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; result?: { success?: boolean; error_code?: string; message?: string } }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', params, id: 1 }),
  });
  const body = (await res.json()) as {
    result?: { success?: boolean; error_code?: string; message?: string };
  };
  return { status: res.status, result: body.result };
}

async function login(login: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      params: { companyCode: COMPANY_CODE, login, password },
      id: 1,
    }),
  });
  const body = (await res.json()) as {
    result?: { success?: boolean; error_code?: string; message?: string; data?: { token?: string } };
  };
  if (res.status >= 500) throw new Error(`login HTTP ${res.status}`);
  if (!body.result?.success) {
    throw new Error(`login failed: ${body.result?.error_code} ${body.result?.message}`);
  }
  const token = body.result.data?.token;
  if (!token) throw new Error('no token in login response');
  return token;
}

async function resolveAccounts(): Promise<RoleSmoke[]> {
  const company = await prisma.company.findFirst({ where: { code: COMPANY_CODE } });
  if (!company) throw new Error('vicanza company not found');

  async function credsForRole(role: string, preferLogin?: string): Promise<RoleSmoke | null> {
    const user = preferLogin
      ? await prisma.user.findFirst({
          where: { companyId: company.id, active: true, role: role as never, login: preferLogin },
        })
      : await prisma.user.findFirst({
          where: { companyId: company.id, active: true, role: role as never },
          orderBy: { createdAt: 'asc' },
        });
    if (!user) return null;
    const login = user.login;
    let password = login;
    const emp = await prisma.employeeProfile.findFirst({
      where: { userId: user.id },
      select: { workEmailPassword: true },
    });
    if (emp?.workEmailPassword?.trim()) password = emp.workEmailPassword.trim();
    return { label: role, login, password };
  }

  const employee =
    (await credsForRole('EMPLOYEE', 'ahmedyousef@cai.com')) ??
    (await credsForRole('EMPLOYEE'));

  const bm =
    (await credsForRole('BRANCH_MANAGER', 't@t.com')) ?? (await credsForRole('BRANCH_MANAGER'));

  let hr: RoleSmoke | null = null;
  const envHrLogin = process.env.SMOKE_HR_LOGIN?.trim();
  const envHrPassword = process.env.SMOKE_HR_PASSWORD?.trim();
  if (envHrLogin && envHrPassword) {
    hr = { label: 'HR_MANAGER', login: envHrLogin, password: envHrPassword };
  }
  const hrRoles = ['HR_MANAGER', 'HR_SUPERVISOR', 'HR_USER'] as const;
  for (const role of hrRoles) {
    if (hr) break;
    const hrUsers = await prisma.user.findMany({
      where: { companyId: company.id, active: true, role },
      select: { login: true },
      take: 15,
    });
    for (const u of hrUsers) {
      const candidate = await credsForRole(role, u.login);
      if (!candidate) continue;
      try {
        await login(candidate.login, candidate.password);
        hr = { ...candidate, label: role };
        break;
      } catch {
        /* password may not equal login on live accounts */
      }
    }
  }

  if (!hr) {
    throw new Error(
      'No HR staff login succeeded (set SMOKE_HR_LOGIN + SMOKE_HR_PASSWORD or use login=password HR account)',
    );
  }
  const out = [employee, hr, bm].filter(Boolean) as RoleSmoke[];
  if (!out.length) throw new Error('no vicanza users for smoke');
  return out;
}

/** Read/list/get only — safe on live Vicanza (no writes). */
function isLiveSafeRead(path: string): boolean {
  const blocked = [
    'create',
    'approve',
    'reject',
    'delete',
    'update',
    'import',
    'export',
    'sync',
    'broadcast',
    'chat',
    'wipe',
    'confirm',
    'calculate',
    'generate',
    'send',
    'push',
    'cancel',
    'check-in',
    'check-out',
    'fcm-token',
    'branch-approve',
  ];
  return !blocked.some((b) => path.includes(b));
}

/** Mirrors mobileFeatureCatalog feature groups (read paths only). */
const FEATURE_READ_BY_ROLE: Record<string, string[]> = {
  EMPLOYEE: [
    '/api/biotime/me',
    '/api/biotime/dashboard/stats',
    '/api/biotime/dashboard/charts',
    '/api/biotime/attendance/my',
    '/api/biotime/my-schedule',
    '/api/biotime/mobile-punch/context',
    '/api/biotime/notifications/list',
    '/api/biotime/requests/my',
    '/api/biotime/advance-requests/my',
    '/api/biotime/advance-requests/eligibility',
    '/api/biotime/payroll/my',
  ],
  HR_MANAGER: [
    '/api/biotime/me',
    '/api/biotime/dashboard/stats',
    '/api/biotime/requests/pending',
    '/api/biotime/employees/list',
    '/api/biotime/locations/list',
    '/api/biotime/shifts/list',
    '/api/biotime/shift-grid/list',
    '/api/biotime/payroll/list',
    '/api/biotime/deductions/list',
    '/api/biotime/deductions/types',
    '/api/biotime/advances/short/list',
    '/api/biotime/advances/long/list',
    '/api/biotime/advance-requests/list',
    '/api/biotime/hiring-appointments/list',
    '/api/biotime/overtime/list',
    '/api/biotime/reports/documents/types',
    '/api/biotime/config/get',
    '/api/biotime/devices/list',
    '/api/biotime/absences/list',
    '/api/biotime/audit/list',
  ],
  HR_SUPERVISOR: [],
  HR_USER: [],
  BRANCH_MANAGER: [
    '/api/biotime/me',
    '/api/biotime/dashboard/stats',
    '/api/biotime/shift-grid/list',
    '/api/biotime/advance-requests/list',
    '/api/biotime/locations/list',
    '/api/biotime/hiring-appointments/list',
  ],
};

async function main() {
  const accounts = await resolveAccounts();
  const failures: string[] = [];

  for (const acct of accounts) {
    console.log(`\n=== ${acct.label} (${acct.login}) ===`);
    let token: string;
    try {
      token = await login(acct.login, acct.password);
      console.log('  login OK');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${acct.label} login: ${msg}`);
      console.log(`  login FAIL: ${msg}`);
      continue;
    }

    let paths =
      FEATURE_READ_BY_ROLE[acct.label] ??
      (acct.label === 'EMPLOYEE'
        ? FEATURE_READ_BY_ROLE.EMPLOYEE
        : acct.label === 'BRANCH_MANAGER'
          ? FEATURE_READ_BY_ROLE.BRANCH_MANAGER
          : FEATURE_READ_BY_ROLE.HR_MANAGER);
    if (!paths.length && acct.label.startsWith('HR_')) {
      paths = FEATURE_READ_BY_ROLE.HR_MANAGER;
    }
    paths = paths.filter(isLiveSafeRead);

    for (const path of paths) {
      const res = await jsonRpc(path, {}, token);
      const ok =
        res.status !== 404 &&
        res.status < 500 &&
        (res.result?.success === true ||
          (res.result?.success === false && res.result.error_code !== 'SERVER_ERROR'));
      if (!ok) {
        const line = `${acct.label} ${path} HTTP ${res.status} ${res.result?.error_code ?? ''}`;
        failures.push(line);
        console.log(`  FAIL ${line}`);
      } else {
        console.log(`  OK   ${path}`);
      }
    }
  }

  console.log('\n--- Summary ---');
  if (failures.length) {
    console.log(`${failures.length} failure(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All Vicanza live smoke checks passed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
