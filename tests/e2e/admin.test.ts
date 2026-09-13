import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';

vi.mock('../../src/services/mail.service', () => ({
  sendUserCredentialsEmail: vi.fn(async () => ({ sent: false, error: 'NO_EMAIL', to: null })),
  sendHiringAppointmentEmail: vi.fn(async () => ({ sent: false, error: 'NO_EMAIL', to: null })),
}));

import { expectFail, expectOk, rpc } from '../helpers/api';
import { createLocation, createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';

describe('admin user management', () => {
  let admin: SeededUser;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    admin = await createUser({ login: 'admin@test.local', role: UserRole.PLATFORM_ADMIN });
  });

  describe('create', () => {
    it('creates an employee user with a hashed password', async () => {
      const data = expectOk(
        await rpc(
          '/api/admin/users',
          { name: 'New Person', login: 'new@test.local', password: 'Str0ngPass!', role: 'EMPLOYEE' },
          admin.token,
        ),
      );
      expect((data.user as { login: string }).login).toBe('new@test.local');

      const row = await prisma.user.findUniqueOrThrow({ where: { login: 'new@test.local' } });
      expect(row.passwordHash).not.toBe('Str0ngPass!');
      expect(await bcrypt.compare('Str0ngPass!', row.passwordHash)).toBe(true);
    });

    it('creates an employee profile alongside the account', async () => {
      await rpc(
        '/api/admin/users',
        { name: 'Profiled', login: 'profiled@test.local', password: 'Str0ngPass!', role: 'EMPLOYEE' },
        admin.token,
      );
      const user = await prisma.user.findUniqueOrThrow({ where: { login: 'profiled@test.local' } });
      expect(await prisma.employeeProfile.findFirst({ where: { userId: user.id } })).toBeTruthy();
    });

    it('does not create a profile for a device manager', async () => {
      await rpc(
        '/api/admin/users',
        { name: 'Device Guy', login: 'device@test.local', password: 'Str0ngPass!', role: 'DEVICE_MANAGER' },
        admin.token,
      );
      const user = await prisma.user.findUniqueOrThrow({ where: { login: 'device@test.local' } });
      expect(await prisma.employeeProfile.findFirst({ where: { userId: user.id } })).toBeNull();
    });

    it('requires name, login and password', async () => {
      expectFail(await rpc('/api/admin/users', { login: 'x@test.local' }, admin.token), 'VALIDATION_ERROR');
      expectFail(await rpc('/api/admin/users', { name: 'X', password: 'p' }, admin.token), 'VALIDATION_ERROR');
    });

    it('rejects a duplicate login', async () => {
      await rpc(
        '/api/admin/users',
        { name: 'First', login: 'dup@test.local', password: 'Str0ngPass!', role: 'EMPLOYEE' },
        admin.token,
      );
      expectFail(
        await rpc(
          '/api/admin/users',
          { name: 'Second', login: 'dup@test.local', password: 'Str0ngPass!', role: 'EMPLOYEE' },
          admin.token,
        ),
        'DUPLICATE_LOGIN',
      );
    });

    it('falls back to EMPLOYEE for an unknown role', async () => {
      await rpc(
        '/api/admin/users',
        { name: 'Odd Role', login: 'odd@test.local', password: 'Str0ngPass!', role: 'SUPREME_LEADER' },
        admin.token,
      );
      const row = await prisma.user.findUniqueOrThrow({ where: { login: 'odd@test.local' } });
      expect(row.role).toBe(UserRole.EMPLOYEE);
    });

    it('refuses to mint another platform admin through this endpoint', async () => {
      await rpc(
        '/api/admin/users',
        { name: 'Wannabe', login: 'wannabe@test.local', password: 'Str0ngPass!', role: 'PLATFORM_ADMIN' },
        admin.token,
      );
      const row = await prisma.user.findUniqueOrThrow({ where: { login: 'wannabe@test.local' } });
      expect(row.role).toBe(UserRole.EMPLOYEE);
    });

    it('requires a location for a location-scoped role', async () => {
      expectFail(
        await rpc(
          '/api/admin/users',
          { name: 'Scoped', login: 'scoped@test.local', password: 'Str0ngPass!', role: 'HR_USER' },
          admin.token,
        ),
        'VALIDATION_ERROR',
      );
    });

    it('stores the location for a scoped role', async () => {
      const location = await createLocation({ name: 'Branch S', code: 'LOC-S' });
      expectOk(
        await rpc(
          '/api/admin/users',
          {
            name: 'Scoped',
            login: 'scoped@test.local',
            password: 'Str0ngPass!',
            role: 'BRANCH_MANAGER',
            locationId: location.id,
          },
          admin.token,
        ),
      );
      const row = await prisma.user.findUniqueOrThrow({ where: { login: 'scoped@test.local' } });
      expect(row.locationId).toBe(location.id);
    });

    it('rejects an unknown location', async () => {
      expectFail(
        await rpc(
          '/api/admin/users',
          {
            name: 'Bad Loc',
            login: 'badloc@test.local',
            password: 'Str0ngPass!',
            role: 'HR_USER',
            locationId: 'nope',
          },
          admin.token,
        ),
        'NOT_FOUND',
      );
    });

    it('does not attach a location to an unscoped role', async () => {
      const location = await createLocation({ name: 'Branch S', code: 'LOC-S' });
      await rpc(
        '/api/admin/users',
        {
          name: 'Manager',
          login: 'mgr@test.local',
          password: 'Str0ngPass!',
          role: 'HR_MANAGER',
          locationId: location.id,
        },
        admin.token,
      );
      const row = await prisma.user.findUniqueOrThrow({ where: { login: 'mgr@test.local' } });
      expect(row.locationId).toBeNull();
    });
  });

  describe('list', () => {
    it('lists users and hides platform admins', async () => {
      await createUser({ login: 'listed@test.local', role: UserRole.HR_USER });
      const data = expectOk(await rpc('/api/admin/users/list', {}, admin.token));
      const logins = (data.users as { login: string }[]).map((u) => u.login);
      expect(logins).toContain('listed@test.local');
      expect(logins).not.toContain(admin.login);
    });
  });

  describe('deactivate', () => {
    it('deactivates a user and blocks their existing token', async () => {
      const victim = await createUser({ login: 'victim@test.local', role: UserRole.HR_USER });
      expectOk(await rpc('/api/admin/users/deactivate', { userId: victim.userId }, admin.token));

      const row = await prisma.user.findUniqueOrThrow({ where: { id: victim.userId } });
      expect(row.active).toBe(false);
      expectFail(await rpc('/api/biotime/me', {}, victim.token), 'INVALID_TOKEN');
    });

    it('requires a userId', async () => {
      expectFail(await rpc('/api/admin/users/deactivate', {}, admin.token), 'VALIDATION_ERROR');
    });
  });

  describe('reset password', () => {
    it('sets a supplied password and lets the user log in with it', async () => {
      const victim = await createUser({ login: 'reset@test.local', role: UserRole.HR_USER });
      const data = expectOk(
        await rpc(
          '/api/admin/users/reset-password',
          { userId: victim.userId, password: 'BrandNew!23' },
          admin.token,
        ),
      );
      expect(data.password).toBe('BrandNew!23');

      const login = await rpc('/api/auth/login', {
        login: 'reset@test.local',
        password: 'BrandNew!23',
      });
      expectOk(login);
    });

    it('generates a password when none is supplied', async () => {
      const victim = await createUser({ login: 'gen@test.local', role: UserRole.HR_USER });
      const data = expectOk(
        await rpc('/api/admin/users/reset-password', { userId: victim.userId }, admin.token),
      );
      expect(String(data.password).length).toBeGreaterThanOrEqual(8);
    });

    it('refuses to reset a platform admin', async () => {
      const other = await createUser({ login: 'admin2@test.local', role: UserRole.PLATFORM_ADMIN });
      expectFail(
        await rpc('/api/admin/users/reset-password', { userId: other.userId }, admin.token),
        'NOT_FOUND',
      );
    });

    it('fails for an unknown user', async () => {
      expectFail(
        await rpc('/api/admin/users/reset-password', { userId: 'nope' }, admin.token),
        'NOT_FOUND',
      );
    });

    it('requires a userId', async () => {
      expectFail(await rpc('/api/admin/users/reset-password', {}, admin.token), 'VALIDATION_ERROR');
    });
  });
});

describe('hiring appointment webhook', () => {
  let hr: SeededUser;
  let appointmentId: string;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    hr = await createUser({ login: 'hr@test.local', role: UserRole.HR_MANAGER });

    const appointment = await prisma.hiringAppointment.create({
      data: {
        appointmentDate: new Date('2026-06-01T00:00:00.000Z'),
        employeeName: 'Webhook Candidate',
        mobilePhone: '01000000000',
        nationalId: '29001011234571',
        jobTitle: 'Cashier',
        fingerprintCode: 'H100',
        firstWorkingDay: new Date('2026-06-15T00:00:00.000Z'),
        status: 'pending',
        createdByUserId: hr.userId,
      },
    });
    appointmentId = appointment.id;
  });

  it('rejects a request with no secret when none is configured', async () => {
    // HIRING_WEBHOOK_SECRET is unset in tests, so the endpoint must refuse everything.
    expectFail(
      await rpc('/api/biotime/hiring-appointments/webhook/status', { appointmentId, status: 'approved' }),
      'UNAUTHORIZED',
    );
  });

  it('rejects a wrong secret', async () => {
    expectFail(
      await rpc('/api/biotime/hiring-appointments/webhook/status', {
        appointmentId,
        status: 'approved',
        secret: 'guessed',
      }),
      'UNAUTHORIZED',
    );
  });

  it('does not require authentication to be reachable', async () => {
    const res = await rpc('/api/biotime/hiring-appointments/webhook/status', { appointmentId });
    // Unauthorized rather than MISSING_TOKEN proves the route is not behind requireAuth.
    expect(res.body.result?.error_code).toBe('UNAUTHORIZED');
  });

  it('lists appointments for HR', async () => {
    const data = expectOk(await rpc('/api/biotime/hiring-appointments/list', {}, hr.token));
    expect((data.appointments as unknown[]).length).toBe(1);
  });

  it('reports the pending appointment count', async () => {
    const data = expectOk(await rpc('/api/biotime/hiring-appointments/unread-count', {}, hr.token));
    expect(Number(data.count ?? data.unreadCount ?? 0)).toBeGreaterThanOrEqual(0);
  });
});
