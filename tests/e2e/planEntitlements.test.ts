import { describe, it, expect, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';
import { prismaBase } from '../../src/prisma/client';
import { expectOk, plain, rpc } from '../helpers/api';
import { createUser, resetDatabase } from '../helpers/db';
import { allFeatureKeys } from '../../src/services/featureCatalog';

async function seedAttendancePlan() {
  return prismaBase.subscriptionPlan.create({
    data: {
      id: 'plan_attendance_e2e',
      slug: 'attendance',
      nameAr: 'الحضور',
      nameEn: 'Attendance',
      priceDisplayAr: '20',
      priceDisplayEn: '20',
      status: 'PUBLISHED',
      sortOrder: 1,
      defaultMaxEmployees: 25,
      defaultMaxUsers: 3,
      featureKeys: ['attendance'],
      featuresAr: ['حضور'],
      featuresEn: ['Attendance'],
    },
  });
}

async function tokenForUser(userId: string): Promise<string> {
  const token = `test-token-${userId}`;
  await prismaBase.apiToken.create({
    data: {
      token,
      userId,
      deviceInfo: 'vitest-entitlements',
      expiryDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return token;
}

describe('plan entitlements + company snapshot (e2e)', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedAttendancePlan();
  });

  it('approve copies plan features; HR menus/API lock payroll; plan edit does not mutate snapshot', async () => {
    const createRes = await plain('/api/public/sales-requests', {
      companyCode: 'capco',
      companyName: 'Capped Co',
      contactName: 'Sara',
      email: 'sara@capco.test',
      phone: '+201099988877',
      requestedEmployees: 25,
      planId: 'plan_attendance_e2e',
    });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);

    const admin = await createUser({ login: 'ent-admin@admin.bio', role: UserRole.PLATFORM_ADMIN });
    const list = expectOk(await rpc('/api/admin/sales-requests/list', {}, admin.token));
    const requests = list.requests as Array<{ id: string; companyCode: string }>;
    const id = requests.find((r) => r.companyCode === 'capco')!.id;

    const approved = expectOk(await rpc('/api/admin/sales-requests/approve', { id }, admin.token));
    const company = approved.company as { id: string; code: string };
    expect(company.code).toBe('capco');

    const dbCompany = await prismaBase.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(dbCompany.subscriptionPlanId).toBe('plan_attendance_e2e');
    expect(dbCompany.planNameEn).toBe('Attendance');
    expect(dbCompany.planNameAr).toBe('الحضور');
    expect(dbCompany.maxEmployees).toBe(25);

    const snap = await prismaBase.companyFeature.findMany({
      where: { companyId: company.id },
      orderBy: { featureKey: 'asc' },
    });
    expect(snap.map((r) => r.featureKey)).toEqual(['attendance']);
    expect(snap.every((r) => r.enabled && r.source === 'PLAN_SNAPSHOT')).toBe(true);

    // Changing the plan catalog after approve must NOT rewrite the company snapshot.
    expectOk(
      await rpc(
        '/api/admin/plans/update',
        {
          id: 'plan_attendance_e2e',
          featureKeys: ['attendance', 'payroll', 'hr_employees'],
        },
        admin.token,
      ),
    );
    const snapAfterPlanEdit = await prismaBase.companyFeature.findMany({
      where: { companyId: company.id },
    });
    expect(snapAfterPlanEdit.map((r) => r.featureKey).sort()).toEqual(['attendance']);

    const hr = await prismaBase.user.findFirstOrThrow({
      where: { companyId: company.id, login: 'sara@capco.test' },
    });
    expect(hr.role).toBe(UserRole.HR_MANAGER);
    const hrToken = await tokenForUser(hr.id);

    const me = expectOk(await rpc('/api/biotime/me', {}, hrToken));
    const features = me.features as { entitlements?: Record<string, boolean> };
    const entitlements = features.entitlements ?? {};
    expect(entitlements.attendance).toBe(true);
    expect(entitlements.payroll).toBeUndefined();

    const menus = (me.menus as Array<{ id: string }>) ?? [];
    const menuIds = new Set(menus.map((m) => m.id));
    expect(menuIds.has('attendance') || menuIds.has('shifts') || menuIds.has('shift_grid')).toBe(true);
    expect(menuIds.has('payroll')).toBe(false);
    expect(menuIds.has('deductions')).toBe(false);
    expect(menuIds.has('advances')).toBe(false);

    const blocked = await rpc('/api/biotime/payroll/duplicates/list', {}, hrToken);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({
      success: false,
      error_code: 'FEATURE_DISABLED',
    });

    const allowed = await rpc(
      '/api/biotime/attendance/list',
      { page: 1, pageSize: 5 },
      hrToken,
    );
    // Must not be blocked by entitlements (may still succeed with empty data).
    expect(allowed.status).not.toBe(403);
    expect((allowed.body as { error_code?: string }).error_code).not.toBe('FEATURE_DISABLED');
    expect(allowed.body.result?.success).toBe(true);

    // Super Admin override: enable payroll on this company only.
    const catalog = expectOk(await rpc('/api/admin/plans/feature-catalog', {}, admin.token));
    const catalogKeys = ((catalog.features as Array<{ key: string }>) ?? []).map((f) => f.key);
    expect(catalogKeys).toEqual(expect.arrayContaining(allFeatureKeys()));

    expectOk(
      await rpc(
        '/api/admin/companies/features/update',
        {
          id: company.id,
          features: [
            { key: 'attendance', enabled: true },
            { key: 'payroll', enabled: true },
          ],
        },
        admin.token,
      ),
    );

    const adminView = expectOk(
      await rpc('/api/admin/companies/features/get', { id: company.id }, admin.token),
    );
    const rows = adminView.features as Array<{ key: string; enabled: boolean; source: string }>;
    expect(rows.find((r) => r.key === 'payroll')).toMatchObject({
      enabled: true,
      source: 'ADMIN_OVERRIDE',
    });

    const payrollAfter = await rpc('/api/biotime/payroll/duplicates/list', {}, hrToken);
    // Entitlement gate must open; business validation of the route is out of scope.
    expect(payrollAfter.status).not.toBe(403);
    expect((payrollAfter.body as { error_code?: string }).error_code).not.toBe('FEATURE_DISABLED');
    expect(payrollAfter.body.result?.error_code).not.toBe('FEATURE_DISABLED');

    const me2 = expectOk(await rpc('/api/biotime/me', {}, hrToken));
    const ent2 = (me2.features as { entitlements?: Record<string, boolean> }).entitlements ?? {};
    expect(ent2.payroll).toBe(true);
    const menuIds2 = new Set(((me2.menus as Array<{ id: string }>) ?? []).map((m) => m.id));
    expect(menuIds2.has('payroll')).toBe(true);
  });

  it('legacy company with no feature rows keeps full catalog access', async () => {
    const company = await prismaBase.company.create({
      data: { code: 'legacy', name: 'Legacy Co', active: true, maxEmployees: 10, maxUsers: 3 },
    });
    const hr = await createUser({
      login: 'hr@legacy.test',
      role: UserRole.HR_MANAGER,
      companyId: company.id,
    });

    const me = expectOk(await rpc('/api/biotime/me', {}, hr.token));
    const entitlements = (me.features as { entitlements?: Record<string, boolean> }).entitlements ?? {};
    for (const key of allFeatureKeys()) {
      expect(entitlements[key], key).toBe(true);
    }

    const payroll = await rpc('/api/biotime/payroll/duplicates/list', {}, hr.token);
    expect(payroll.status).not.toBe(403);
    expect((payroll.body as { error_code?: string }).error_code).not.toBe('FEATURE_DISABLED');
    expect(payroll.body.result?.error_code).not.toBe('FEATURE_DISABLED');
  });
});
