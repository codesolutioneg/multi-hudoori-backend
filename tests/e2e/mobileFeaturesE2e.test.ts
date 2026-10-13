import { describe, it, expect, beforeAll } from 'vitest';
import { UserRole } from '@prisma/client';
import { prismaBase } from '../../src/prisma/client';
import { classifyRpcSurface, expectOk, rpc } from '../helpers/api';
import {
  audienceForPath,
  isAcceptableSurfaceOutcome,
  minimalParamsForPath,
  PLACEHOLDER_ID,
  roleForAudience,
} from '../helpers/mobileApiInventory';
import { MOBILE_FEATURES } from '../helpers/mobileFeatureCatalog';
import {
  createUser,
  resetDatabase,
  seedMobileRoleTrio,
  seedShiftGridForEmployee,
} from '../helpers/db';
import { getOpenCycle } from '../../src/services/payrollCycleGuard.service';

/**
 * Feature-scoped E2E: every mobile app screen area → its primary API calls.
 * Complements mobileApiSurface (full path list) with product/feature grouping.
 */
describe('mobile app features — API backing each screen', () => {
  let trio: Awaited<ReturnType<typeof seedMobileRoleTrio>>;
  let platformToken: string;
  let seededGridId: string;
  let seededPayrollId: string;
  let cycleFrom: string;
  let cycleTo: string;

  beforeAll(async () => {
    await resetDatabase();
    trio = await seedMobileRoleTrio();
    const pa = await createUser({
      login: 'feat-pa@test.local',
      role: UserRole.PLATFORM_ADMIN,
    });
    platformToken = pa.token;

    const cycle = await getOpenCycle();
    cycleFrom = cycle.dateFrom;
    cycleTo = cycle.dateTo;
    const grid = await seedShiftGridForEmployee({
      companyId: trio.employee.companyId,
      employeeId: trio.employee.employeeId!,
      dateFrom: cycle.dateFrom,
      dateTo: cycle.dateTo,
      shiftId: trio.shiftId,
    });
    seededGridId = grid.id;

    const payroll = await prismaBase.payroll.create({
      data: {
        companyId: trio.employee.companyId,
        name: 'Feature smoke payroll',
        dateFrom: new Date(`${cycle.dateFrom}T00:00:00.000Z`),
        dateTo: new Date(`${cycle.dateTo}T00:00:00.000Z`),
        state: 'draft',
      },
    });
    seededPayrollId = payroll.id;

    await prismaBase.bioTimeConfig.updateMany({
      where: { companyId: trio.employee.companyId },
      data: { advanceMinimumWorkingDays: 0 },
    });
  });

  function tokenFor(audience: string): string | undefined {
    if (audience === 'AUTH') return undefined;
    if (audience === 'ALL_AUTH') return trio.employee.token;
    if (audience === 'PLATFORM_ADMIN') return platformToken;
    const role = roleForAudience(audience as ReturnType<typeof audienceForPath>);
    if (role === UserRole.EMPLOYEE) return trio.employee.token;
    if (role === UserRole.BRANCH_MANAGER) return trio.branchManager.token;
    if (role === UserRole.HR_MANAGER) return trio.hr.token;
    if (role === UserRole.PLATFORM_ADMIN) return platformToken;
    return trio.hr.token;
  }

  function paramsFor(path: string): Record<string, unknown> {
    const base = minimalParamsForPath(path);
    if (path.includes('shift-grid/get') || path.includes('shift-grid/sync/status')) {
      return { ...base, gridId: seededGridId };
    }
    if (path === '/api/biotime/payroll/get') {
      return { payrollId: seededPayrollId, id: seededPayrollId };
    }
    if (path.includes('/payroll/period/employees/search')) {
      return { dateFrom: cycleFrom, dateTo: cycleTo, query: '' };
    }
    if (path === '/api/auth/login') {
      return {
        companyCode: 'testco',
        login: trio.employee.login,
        password: trio.employee.password,
      };
    }
    if (path.includes('branch-approve')) {
      return { id: PLACEHOLDER_ID };
    }
    if (path.includes('mobile-punch/check')) {
      return { latitude: 30.0444, longitude: 31.2357 };
    }
    return base;
  }

  for (const feature of MOBILE_FEATURES) {
    describe(feature.label, () => {
      for (const path of feature.paths) {
        it(`${path}`, async () => {
          const pathAudience = audienceForPath(path);
          const token = tokenFor(
            pathAudience === 'AUTH' ? 'AUTH' : pathAudience,
          );
          const res = await rpc(path, paramsFor(path), token);
          const kind = classifyRpcSurface(res);
          expect(
            isAcceptableSurfaceOutcome(kind),
            `[${feature.id}] ${path} → HTTP ${res.status} ${kind} ${JSON.stringify(res.body.result ?? res.body).slice(0, 200)}`,
          ).toBe(true);
        });
      }
    });
  }

  it('employee advance flow: create visible in my list', async () => {
    const created = expectOk(
      await rpc(
        '/api/biotime/advance-requests/create',
        { amount: 200, reason: 'feature e2e' },
        trio.employee.token,
      ),
    );
    const id = (created.id ?? (created.request as { id?: string } | undefined)?.id) as string;
    expect(id).toBeTruthy();
    const mine = expectOk(
      await rpc('/api/biotime/advance-requests/my', {}, trio.employee.token),
    );
    const list = mine.requests as { id: string }[];
    expect(list.some((r) => r.id === id)).toBe(true);
  });
});
