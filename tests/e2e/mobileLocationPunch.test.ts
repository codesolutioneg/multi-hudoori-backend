import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { prismaBase } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { resetDatabase } from '../helpers/db';
import { ensureBioTimeConfigFromEnv } from '../../src/bootstrap/biotimeConfig';
import { ensureOdooConfigFromEnv } from '../../src/bootstrap/odooConfig';
import {
  distanceMeters,
  isWithinGeofence,
} from '../../src/services/mobileLocationPunch.service';

describe('geofence math', () => {
  it('returns ~0 for same point', () => {
    expect(distanceMeters(24.7136, 46.6753, 24.7136, 46.6753)).toBeLessThan(1);
  });

  it('accepts points inside radius and rejects outside', () => {
    const lat = 30.0444;
    const lng = 31.2357;
    expect(
      isWithinGeofence({
        userLat: lat,
        userLng: lng,
        locationLat: lat,
        locationLng: lng,
        radiusMeters: 200,
      }),
    ).toBe(true);
    expect(
      isWithinGeofence({
        userLat: lat + 0.01,
        userLng: lng,
        locationLat: lat,
        locationLng: lng,
        radiusMeters: 200,
      }),
    ).toBe(false);
  });
});

describe('mobile location punch e2e', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function seedCompanyWithPunchBranch(opts: {
    code: string;
    enabled: boolean;
    lat?: number;
    lng?: number;
    radius?: number;
  }) {
    const company = await prismaBase.company.create({
      data: { code: opts.code, name: `${opts.code} Co`, active: true },
    });
    await ensureBioTimeConfigFromEnv(company.id);
    await ensureOdooConfigFromEnv(company.id);

    const location = await prismaBase.location.create({
      data: {
        companyId: company.id,
        name: `${opts.code} HQ`,
        code: `${opts.code}-hq`,
        locationPunchEnabled: opts.enabled,
        latitude: opts.lat ?? 30.0444,
        longitude: opts.lng ?? 31.2357,
        geofenceRadiusMeters: opts.radius ?? 200,
      },
    });

    const password = 'EmpPass#2026';
    const passwordHash = await bcrypt.hash(password, 4);
    const user = await prismaBase.user.create({
      data: {
        companyId: company.id,
        login: `emp@${opts.code}.test`,
        email: `emp@${opts.code}.test`,
        name: 'Emp User',
        passwordHash,
        role: UserRole.EMPLOYEE,
        locationId: location.id,
      },
    });
    await prismaBase.employeeProfile.create({
      data: {
        companyId: company.id,
        userId: user.id,
        name: 'Emp User',
        code: `${opts.code}-001`,
        locationId: location.id,
      },
    });

    return { company, location, login: user.login, password };
  }

  it('rejects punch when branch punch is disabled', async () => {
    const seeded = await seedCompanyWithPunchBranch({
      code: 'offco',
      enabled: false,
    });
    const login = expectOk(
      await rpc('/api/auth/login', {
        companyCode: 'offco',
        login: seeded.login,
        password: seeded.password,
      }),
    );
    const token = String(login.token);
    expect(login.company).toMatchObject({ code: 'offco' });

    const ctx = expectOk(await rpc('/api/biotime/mobile-punch/context', {}, token));
    expect(ctx.enabled).toBe(false);

    const punch = await rpc(
      '/api/biotime/mobile-punch/check-in',
      { latitude: 30.0444, longitude: 31.2357 },
      token,
    );
    expectFail(punch, 'LOCATION_PUNCH_DISABLED');
  });

  it('accepts inside geofence and rejects outside; writes transactions', async () => {
    const seeded = await seedCompanyWithPunchBranch({
      code: 'onco',
      enabled: true,
      lat: 30.0444,
      lng: 31.2357,
      radius: 200,
    });
    const login = expectOk(
      await rpc('/api/auth/login', {
        companyCode: 'onco',
        login: seeded.login,
        password: seeded.password,
      }),
    );
    const token = String(login.token);

    const ctx = expectOk(await rpc('/api/biotime/mobile-punch/context', {}, token));
    expect(ctx.enabled).toBe(true);
    expect(ctx.nextAction).toBe('check_in');

    const outside = await rpc(
      '/api/biotime/mobile-punch/check-in',
      { latitude: 30.06, longitude: 31.2357 },
      token,
    );
    expectFail(outside, 'GEOFENCE_VIOLATION');

    const ok = expectOk(
      await rpc(
        '/api/biotime/mobile-punch/check-in',
        { latitude: 30.0444, longitude: 31.2357 },
        token,
      ),
    );
    expect((ok.transaction as { punchSource?: string }).punchSource).toBe('mobile_geo');

    const rows = await prismaBase.transaction.findMany({
      where: { companyId: seeded.company.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].terminalSn).toBe('MOBILE_GEO');
    expect(rows[0].punchState).toBe('0');

    const ctx2 = expectOk(await rpc('/api/biotime/mobile-punch/context', {}, token));
    expect(ctx2.nextAction).toBe('check_out');

    const out = expectOk(
      await rpc(
        '/api/biotime/mobile-punch/check-out',
        { latitude: 30.04441, longitude: 31.23571 },
        token,
      ),
    );
    expect((out.transaction as { isCheckIn?: boolean }).isCheckIn).toBe(false);
  });

  it('lets HR enable location punch fields on locations/update', async () => {
    const company = await prismaBase.company.create({
      data: { code: 'hrco', name: 'HR Co', active: true },
    });
    await ensureBioTimeConfigFromEnv(company.id);
    await ensureOdooConfigFromEnv(company.id);
    const location = await prismaBase.location.create({
      data: { companyId: company.id, name: 'Branch', code: 'hrco-b1' },
    });
    const passwordHash = await bcrypt.hash('HrPass#2026', 4);
    await prismaBase.user.create({
      data: {
        companyId: company.id,
        login: 'hr@hrco.test',
        email: 'hr@hrco.test',
        name: 'HR',
        passwordHash,
        role: UserRole.HR_MANAGER,
      },
    });

    const login = expectOk(
      await rpc('/api/auth/login', {
        companyCode: 'hrco',
        login: 'hr@hrco.test',
        password: 'HrPass#2026',
      }),
    );
    const token = String(login.token);

    const failEnable = await rpc(
      '/api/biotime/locations/update',
      { locationId: location.id, locationPunchEnabled: true },
      token,
    );
    expectFail(failEnable, 'VALIDATION');

    const updated = expectOk(
      await rpc(
        '/api/biotime/locations/update',
        {
          locationId: location.id,
          locationPunchEnabled: true,
          latitude: 24.7,
          longitude: 46.6,
          geofenceRadiusMeters: 150,
        },
        token,
      ),
    );
    const loc = updated.location as {
      locationPunchEnabled?: boolean;
      latitude?: number;
      geofenceRadiusMeters?: number;
    };
    expect(loc.locationPunchEnabled).toBe(true);
    expect(loc.latitude).toBe(24.7);
    expect(loc.geofenceRadiusMeters).toBe(150);
  });
});
