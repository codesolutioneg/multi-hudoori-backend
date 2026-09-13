import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectOk, rpc } from '../helpers/api';
import { createLocation, createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';

const NID = '29801011234567';

describe('hiring appointment provision', () => {
  let hr: SeededUser;
  let admin: SeededUser;
  let locationId: string;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    const loc = await createLocation({ name: 'Alex', code: 'ALX' });
    locationId = loc.id;
    hr = await createUser({ login: 'hr-prov@test.local', role: UserRole.HR_MANAGER });
    admin = await createUser({ login: 'admin-prov@test.local', role: UserRole.PLATFORM_ADMIN });
  });

  it('creates an HR employee on approve without an admin login user', async () => {
    const created = expectOk(
      await rpc(
        '/api/biotime/hiring-appointments/create',
        {
          appointmentDate: '2026-08-19',
          employeeName: 'New Hire',
          mobilePhone: '01099999999',
          nationalId: NID,
          jobTitle: 'Cook',
          fingerprintCode: '8801',
          firstWorkingDay: '2026-08-21',
          locationId,
        },
        hr.token,
      ),
    );
    const appointmentId = (created.appointment as Record<string, unknown>).id;

    const updated = expectOk(
      await rpc(
        '/api/biotime/hiring-appointments/update',
        { id: appointmentId, status: 'approved' },
        hr.token,
      ),
    );
    expect(String(updated.message)).toContain('تم إنشاء الموظف في قائمة الموظفين');
    expect(updated.employee).toMatchObject({ created: true, login: null, userId: null });

    const profile = await prisma.employeeProfile.findFirstOrThrow({
      where: { nationalIdConfirm: NID },
    });
    expect(profile.code).toBe('8801');
    expect(profile.userId).toBeNull();
    expect(await prisma.user.findUnique({ where: { login: NID } })).toBeNull();

    const adminList = expectOk(await rpc('/api/admin/users/list', {}, admin.token));
    const logins = (adminList.users as Array<{ login: string }>).map((u) => u.login);
    expect(logins).not.toContain(NID);
  });
});
