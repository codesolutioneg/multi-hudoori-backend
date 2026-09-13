import { describe, it, expect, beforeAll } from 'vitest';
import { UserRole } from '@prisma/client';
import { rpc } from '../helpers/api';
import { createUserPerRole, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';

const ALL_ROLES = Object.values(UserRole);
const HR: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.HR_MANAGER,
  UserRole.HR_SUPERVISOR,
  UserRole.HR_USER,
];
const HR_OR_BRANCH: UserRole[] = [...HR, UserRole.BRANCH_MANAGER];
const HR_MANAGER_ONLY: UserRole[] = [UserRole.PLATFORM_ADMIN, UserRole.HR_MANAGER];
const PLATFORM_ONLY: UserRole[] = [UserRole.PLATFORM_ADMIN];

/**
 * One representative read-only endpoint per authorization guard. Adding a new
 * guard to the API means adding a row here.
 */
const GUARDED: { path: string; guard: string; allowed: UserRole[] }[] = [
  // requireAuth: any authenticated user
  { path: '/api/biotime/me', guard: 'requireAuth', allowed: ALL_ROLES },
  { path: '/api/biotime/dashboard/stats', guard: 'requireAuth', allowed: ALL_ROLES },
  { path: '/api/biotime/dashboard/charts', guard: 'requireAuth', allowed: ALL_ROLES },
  { path: '/api/biotime/attendance/my', guard: 'requireAuth', allowed: ALL_ROLES },

  // requireHrOrBranchManager
  { path: '/api/biotime/employees/list', guard: 'requireHrOrBranchManager', allowed: HR_OR_BRANCH },
  { path: '/api/biotime/shift-grid/list', guard: 'requireHrOrBranchManager', allowed: HR_OR_BRANCH },
  { path: '/api/biotime/locations/list', guard: 'requireHrOrBranchManager', allowed: HR_OR_BRANCH },
  { path: '/api/biotime/shifts/list', guard: 'requireHrOrBranchManager', allowed: HR_OR_BRANCH },
  { path: '/api/biotime/dashboard/notifications', guard: 'requireHrOrBranchManager', allowed: HR_OR_BRANCH },
  { path: '/api/biotime/hiring-appointments/list', guard: 'requireHrOrBranchManager', allowed: HR_OR_BRANCH },
  { path: '/api/biotime/shift-grid/merge/candidates', guard: 'requireHrOrBranchManager', allowed: HR_OR_BRANCH },

  // requireHr
  { path: '/api/biotime/attendance/list', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/payroll/list', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/deductions/list', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/deductions/types', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/reports/documents/types', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/reports/fawry', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/reports/location-mismatch', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/reports/punch-summary', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/reports/insurance', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/reports/documents', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/reports/health-certificates', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/advances/short/list', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/advances/long/list', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/requests/pending', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/departments/list', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/devices/list', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/config/sync-status', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/overtime/list', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/insurance-companies/list', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/custody-types/list', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/health-certificates/alerts', guard: 'requireHr', allowed: HR },
  { path: '/api/biotime/shift-assignments/list', guard: 'requireHr', allowed: HR },

  // requireHrManager
  { path: '/api/biotime/config/get', guard: 'requireHrManager', allowed: HR_MANAGER_ONLY },
  { path: '/api/biotime/odoo/config/get', guard: 'requireHrManager', allowed: HR_MANAGER_ONLY },
  { path: '/api/biotime/company/logo/get', guard: 'requireHrManager', allowed: HR_MANAGER_ONLY },

  // requirePlatformAdmin
  { path: '/api/admin/users/list', guard: 'requirePlatformAdmin', allowed: PLATFORM_ONLY },
];

describe('authorization matrix', () => {
  let users: Record<UserRole, SeededUser>;

  beforeAll(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    users = await createUserPerRole();
  });

  for (const { path, guard, allowed } of GUARDED) {
    const denied = ALL_ROLES.filter((r) => !allowed.includes(r));

    describe(`${path} [${guard}]`, () => {
      it('requires a token', async () => {
        const res = await rpc(path, {});
        expect(res.body.result?.error_code).toBe('MISSING_TOKEN');
      });

      for (const role of allowed) {
        it(`allows ${role}`, async () => {
          const res = await rpc(path, {}, users[role].token);
          expect(
            res.body.result?.error_code,
            `${role} should reach ${path}, got: ${JSON.stringify(res.body.result)}`,
          ).not.toBe('ACCESS_DENIED');
        });
      }

      for (const role of denied) {
        it(`denies ${role}`, async () => {
          const res = await rpc(path, {}, users[role].token);
          expect(res.body.result?.success).toBe(false);
          expect(res.body.result?.error_code).toBe('ACCESS_DENIED');
        });
      }
    });
  }
});

describe('self-service endpoints require an employee profile', () => {
  let users: Record<UserRole, SeededUser>;

  beforeAll(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    users = await createUserPerRole();
  });

  it('lets an employee read their own requests', async () => {
    const res = await rpc('/api/biotime/requests/my', {}, users[UserRole.EMPLOYEE].token);
    expect(res.body.result?.success).toBe(true);
  });

  it('refuses request creation for a user with no employee profile', async () => {
    const res = await rpc(
      '/api/biotime/requests/leave/create',
      { leaveType: 'annual', dateFrom: '2026-07-01', dateTo: '2026-07-02', reason: 'x' },
      users[UserRole.DEVICE_MANAGER].token,
    );
    expect(res.body.result?.success).toBe(false);
    expect(res.body.result?.error_code).toBe('ACCESS_DENIED');
  });

  it('returns an empty payslip list for a user with no employee profile', async () => {
    const res = await rpc('/api/biotime/payroll/my', {}, users[UserRole.DEVICE_MANAGER].token);
    expect(res.body.result?.success).toBe(true);
  });
});
