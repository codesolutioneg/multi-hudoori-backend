import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';
import { writeAudit } from '../../src/services/auditLog.service';

describe('audit log e2e', () => {
  let admin: SeededUser;
  let hr: SeededUser;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser({ login: 'admin-audit@test.local', role: UserRole.PLATFORM_ADMIN });
    hr = await createUser({ login: 'hr-audit-e2e@test.local', role: UserRole.HR_MANAGER, name: 'HR Audit' });
  });

  it('blocks audit list for HR without grant', async () => {
    expectFail(await rpc('/api/biotime/audit/list', {}, hr.token), 'FORBIDDEN');
  });

  it('allows platform admin to list audit after writes', async () => {
    await writeAudit({
      actor: { id: hr.userId, login: hr.login, name: hr.login, role: UserRole.HR_MANAGER },
      module: 'employees',
      action: 'employees.export',
      summary: 'تصدير موظفين',
      counts: { filters: { search: null } },
    });

    const data = expectOk(await rpc('/api/biotime/audit/list', { module: 'employees' }, admin.token));
    expect(Number(data.total)).toBeGreaterThanOrEqual(1);
    const items = data.items as Array<Record<string, unknown>>;
    expect(items[0]?.action).toBe('employees.export');
  });

  it('grants audit access to HR and returns features/menus from /me', async () => {
    const before = expectOk(await rpc('/api/biotime/me', {}, hr.token));
    expect((before.features as { auditLog?: boolean })?.auditLog).toBeFalsy();
    const menusBefore = (before.menus as Array<{ id: string }>) ?? [];
    expect(menusBefore.some((m) => m.id === 'audit')).toBe(false);

    expectOk(
      await rpc(
        '/api/admin/feature-grants/set',
        { userId: hr.userId, feature: 'audit_log', enabled: true },
        admin.token,
      ),
    );

    const after = expectOk(await rpc('/api/biotime/me', {}, hr.token));
    expect((after.features as { auditLog?: boolean })?.auditLog).toBe(true);
    const menusAfter = (after.menus as Array<{ id: string; route: string }>) ?? [];
    expect(menusAfter.some((m) => m.id === 'audit')).toBe(false);

    const list = expectOk(await rpc('/api/biotime/audit/list', {}, hr.token));
    expect(list.items).toBeInstanceOf(Array);
  });

  it('lists feature grants for HR roles only', async () => {
    await createUser({ login: 'emp-no-grant@test.local', role: UserRole.EMPLOYEE });
    const data = expectOk(await rpc('/api/admin/feature-grants/list', { feature: 'audit_log' }, admin.token));
    const items = data.items as Array<{ login: string; role: string }>;
    expect(items.every((i) => String(i.role).startsWith('HR_'))).toBe(true);
    expect(items.some((i) => i.login === 'emp-no-grant@test.local')).toBe(false);
  });

  it('records employee update via API and exposes get + export-xlsx', async () => {
    const emp = await prisma.employeeProfile.create({
      data: {
        name: 'Audit Emp',
        code: 'AUD001',
        identificationId: 'AUD001',
        active: true,
        basicSalary: 3000,
      },
    });

    expectOk(
      await rpc(
        '/api/biotime/employees/update',
        { id: emp.id, name: 'Audit Emp Updated', basicSalary: 3500 },
        hr.token,
      ),
    );

    // HR still needs grant to read audit, admin can read
    const listed = expectOk(
      await rpc('/api/biotime/audit/list', { action: 'employees.update' }, admin.token),
    );
    const items = listed.items as Array<{ id: string; action: string; summary: string }>;
    expect(items.some((i) => i.action === 'employees.update')).toBe(true);
    const row = items.find((i) => i.summary.includes('Audit Emp')) ?? items[0];
    expect(row).toBeTruthy();

    const got = expectOk(await rpc('/api/biotime/audit/get', { id: row!.id }, admin.token));
    expect((got.item as { id: string }).id).toBe(row!.id);

    const file = expectOk(await rpc('/api/biotime/audit/export-xlsx', { id: row!.id }, admin.token));
    expect(String(file.base64 ?? file.file ?? '')).toBeTruthy();
    expect(String(file.filename)).toMatch(/\.xlsx$/);
  });

  it('rejects feature-grants endpoints for non-platform admin', async () => {
    expectFail(await rpc('/api/admin/feature-grants/list', {}, hr.token));
    expectFail(
      await rpc(
        '/api/admin/feature-grants/set',
        { userId: hr.userId, enabled: true },
        hr.token,
      ),
    );
  });
});
