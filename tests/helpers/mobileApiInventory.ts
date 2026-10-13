import fs from 'node:fs';
import path from 'node:path';
import { UserRole } from '@prisma/client';
import type { RpcResult } from './api';

/** Placeholder cuid-like id — routes should return business NOT_FOUND, not HTTP 404/500. */
export const PLACEHOLDER_ID = 'cm000000000000000000000000';

export type MobilePathAudience = 'AUTH' | 'EMPLOYEE' | 'BRANCH_MANAGER' | 'HR' | 'PLATFORM_ADMIN';

export type RpcOutcomeKind =
  | 'ROUTE_OK'
  | 'BUSINESS_FAIL'
  | 'HTTP_404'
  | 'HTTP_5XX'
  | 'BAD_ENVELOPE';

const MOBILE_CLIENT = path.resolve(
  __dirname,
  '../../../mobile-app/lib/data/api/biotime_api_client.dart',
);

const DASHBOARD_CLIENT = path.resolve(
  __dirname,
  '../../../dashboard/lib/data/api/biotime_api_client.dart',
);

/** All `/api/...` string literals from the Flutter biotime client. */
export function extractApiPathsFromDart(sourcePath: string = MOBILE_CLIENT): string[] {
  const text = fs.readFileSync(sourcePath, 'utf8');
  const found = new Set<string>();
  for (const m of text.matchAll(/'(\/api\/[^']+)'/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

export function extractMobileApiPaths(): string[] {
  return extractApiPathsFromDart(MOBILE_CLIENT);
}

export function extractDashboardApiPaths(): string[] {
  if (!fs.existsSync(DASHBOARD_CLIENT)) return [];
  return extractApiPathsFromDart(DASHBOARD_CLIENT);
}

export function pathsOnlyInMobile(): string[] {
  const mobile = new Set(extractMobileApiPaths());
  const dash = new Set(extractDashboardApiPaths());
  return [...mobile].filter((p) => !dash.has(p));
}

const EMPLOYEE_PREFIXES = [
  '/api/biotime/me',
  '/api/biotime/absences/',
  '/api/biotime/attendance/my',
  '/api/biotime/my-schedule',
  '/api/biotime/mobile-punch/',
  '/api/biotime/requests/my',
  '/api/biotime/requests/leave/create',
  '/api/biotime/requests/shift-change/create',
  '/api/biotime/requests/attendance-edit/create',
  '/api/biotime/requests/salary/create',
  '/api/biotime/requests/certificate/create',
  '/api/biotime/advance-requests/eligibility',
  '/api/biotime/advance-requests/create',
  '/api/biotime/advance-requests/my',
  '/api/biotime/advance-requests/cancel',
  '/api/biotime/payroll/my',
  '/api/biotime/notifications/list',
  '/api/biotime/notifications/read',
  '/api/biotime/dashboard/stats',
  '/api/biotime/dashboard/charts',
  '/api/biotime/hiring-appointments/unread-count',
  '/api/biotime/hiring-appointments/mark-seen',
];

const BRANCH_ONLY = [
  '/api/biotime/advance-requests/branch-approve',
];

const PLATFORM_PREFIX = '/api/admin/';

/** Which seeded role should reach this route for surface smoke (one role per path). */
export function audienceForPath(apiPath: string): MobilePathAudience {
  if (apiPath.startsWith('/api/auth/')) return 'AUTH';
  if (apiPath.startsWith(PLATFORM_PREFIX)) return 'PLATFORM_ADMIN';
  if (BRANCH_ONLY.includes(apiPath)) return 'BRANCH_MANAGER';
  if (EMPLOYEE_PREFIXES.some((p) => apiPath === p || apiPath.startsWith(p))) return 'EMPLOYEE';
  if (apiPath === '/api/biotime/requests/loan/create') return 'EMPLOYEE';
  return 'HR';
}

export function roleForAudience(audience: MobilePathAudience): UserRole | null {
  switch (audience) {
    case 'AUTH':
      return null;
    case 'EMPLOYEE':
      return UserRole.EMPLOYEE;
    case 'BRANCH_MANAGER':
      return UserRole.BRANCH_MANAGER;
    case 'HR':
      return UserRole.HR_MANAGER;
    case 'PLATFORM_ADMIN':
      return UserRole.PLATFORM_ADMIN;
  }
}

const ISO = '2026-06-01';
const ISO2 = '2026-06-02';

/** Minimal JSON-RPC params so the route handler runs (business validation may still fail). */
export function minimalParamsForPath(apiPath: string): Record<string, unknown> {
  if (apiPath === '/api/auth/login') {
    return { companyCode: 'testco', login: 'surface@test.local', password: 'Passw0rd!2026' };
  }
  if (apiPath === '/api/auth/forgot-password') {
    return { login: 'surface@test.local', companyCode: 'testco' };
  }
  if (apiPath === '/api/auth/reset-password') {
    return { token: 'invalid', password: 'Passw0rd!2026' };
  }
  if (apiPath === '/api/auth/logout' || apiPath === '/api/auth/validate') {
    return {};
  }

  if (apiPath.includes('/mobile-punch/check-in') || apiPath.includes('/mobile-punch/check-out')) {
    return { latitude: 30.0444, longitude: 31.2357 };
  }

  if (apiPath.endsWith('/list') || apiPath.endsWith('/my') || apiPath.endsWith('/types')) {
    return {};
  }

  if (apiPath.includes('/reports/') && !apiPath.includes('export')) {
    return { dateFrom: ISO, dateTo: ISO2 };
  }

  if (apiPath.includes('/shift-grid/export') || apiPath.includes('/shift-grid/import')) {
    return { gridId: PLACEHOLDER_ID, dateFrom: ISO, dateTo: ISO2 };
  }

  if (apiPath === '/api/biotime/requests/leave/create') {
    return {
      leaveType: 'annual',
      dateFrom: ISO,
      dateTo: ISO,
      reason: 'surface',
    };
  }
  if (apiPath === '/api/biotime/requests/shift-change/create') {
    return {
      newShiftId: PLACEHOLDER_ID,
      dateFrom: ISO,
      dateTo: ISO,
      reason: 'surface',
    };
  }
  if (apiPath === '/api/biotime/requests/attendance-edit/create') {
    return {
      date: ISO,
      requestedCheckIn: '09:00',
      requestedCheckOut: '17:00',
      reason: 'surface',
    };
  }
  if (apiPath === '/api/biotime/requests/salary/create') {
    return { amount: 100, reason: 'surface' };
  }
  if (apiPath === '/api/biotime/requests/certificate/create') {
    return { certificateType: 'employment', reason: 'surface' };
  }
  if (apiPath === '/api/biotime/requests/loan/create') {
    return { amount: 100, repaymentMonths: 1, reason: 'surface' };
  }
  if (apiPath === '/api/biotime/advance-requests/create') {
    return { amount: 100, reason: 'surface' };
  }
  if (apiPath === '/api/biotime/advance-requests/eligibility') {
    return { amount: 100 };
  }

  if (apiPath.includes('/approve') || apiPath.includes('/reject')) {
    return { id: PLACEHOLDER_ID, reason: 'surface' };
  }

  if (apiPath.includes('/create')) {
    return { name: 'Surface', dateFrom: ISO, dateTo: ISO2 };
  }

  const params: Record<string, unknown> = {};
  if (apiPath.includes('gridId') || apiPath.includes('shift-grid')) params.gridId = PLACEHOLDER_ID;
  if (apiPath.includes('payroll')) params.payrollId = PLACEHOLDER_ID;
  if (apiPath.includes('employee')) params.employeeId = PLACEHOLDER_ID;
  if (apiPath.includes('location')) params.locationId = PLACEHOLDER_ID;
  if (apiPath.includes('shift') && !apiPath.includes('shift-grid')) params.shiftId = PLACEHOLDER_ID;
  if (apiPath.includes('/get') || apiPath.includes('/delete') || apiPath.includes('/cancel')) {
    params.id = PLACEHOLDER_ID;
  }
  if (apiPath.includes('jobId')) params.jobId = PLACEHOLDER_ID;
  if (apiPath.includes('audit')) params.id = PLACEHOLDER_ID;
  if (Object.keys(params).length === 0) {
    params.id = PLACEHOLDER_ID;
  }
  return params;
}

export function classifyRpcOutcome(res: RpcResult): RpcOutcomeKind {
  if (res.status === 404) return 'HTTP_404';
  if (res.status >= 500) return 'HTTP_5XX';
  if (res.body.jsonrpc === '2.0' && res.body.result !== undefined) {
    return res.body.result.success === true ? 'ROUTE_OK' : 'BUSINESS_FAIL';
  }
  if (res.body.result?.success === true || res.body.result?.success === false) {
    return res.body.result.success ? 'ROUTE_OK' : 'BUSINESS_FAIL';
  }
  if (typeof res.body.success === 'boolean') {
    return res.body.success ? 'ROUTE_OK' : 'BUSINESS_FAIL';
  }
  return 'BAD_ENVELOPE';
}

export function isAcceptableSurfaceOutcome(kind: RpcOutcomeKind): boolean {
  return kind === 'ROUTE_OK' || kind === 'BUSINESS_FAIL';
}
