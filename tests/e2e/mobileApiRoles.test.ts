import { describe, it, expect, beforeAll } from 'vitest';
import { UserRole } from '@prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { resetDatabase, seedMobileRoleTrio } from '../helpers/db';

describe('mobile role matrix (employee / branch manager / HR)', () => {
  let trio: Awaited<ReturnType<typeof seedMobileRoleTrio>>;

  beforeAll(async () => {
    await resetDatabase();
    trio = await seedMobileRoleTrio();
  });

  it('employee reaches mobile punch context and own requests', async () => {
    expectOk(await rpc('/api/biotime/mobile-punch/context', {}, trio.employee.token));
    expectOk(await rpc('/api/biotime/requests/my', {}, trio.employee.token));
    expectOk(await rpc('/api/biotime/attendance/my', {}, trio.employee.token));
  });

  it('employee cannot list all employees (HR route)', async () => {
    expectFail(await rpc('/api/biotime/employees/list', {}, trio.employee.token), 'ACCESS_DENIED');
  });

  it('branch manager reaches shift-grid list and advance queue', async () => {
    expectOk(await rpc('/api/biotime/shift-grid/list', {}, trio.branchManager.token));
    expectOk(await rpc('/api/biotime/advance-requests/list', {}, trio.branchManager.token));
    expectOk(await rpc('/api/biotime/locations/list', {}, trio.branchManager.token));
  });

  it('HR reaches pending requests and location punch settings', async () => {
    expectOk(await rpc('/api/biotime/requests/pending', {}, trio.hr.token));
    expectOk(await rpc('/api/biotime/locations/list', {}, trio.hr.token));
    const updated = expectOk(
      await rpc(
        '/api/biotime/locations/update',
        {
          locationId: trio.locationId,
          locationPunchEnabled: true,
          latitude: 30.0444,
          longitude: 31.2357,
          geofenceRadiusMeters: 250,
        },
        trio.hr.token,
      ),
    );
    expect((updated.location as { locationPunchEnabled?: boolean }).locationPunchEnabled).toBe(true);
  });
});
