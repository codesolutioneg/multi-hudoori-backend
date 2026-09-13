import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import {
  AUDIT_FEATURE,
  canViewAudit,
  capDiffPreview,
  exportAuditLogXlsx,
  getAuditLog,
  listAuditLogs,
  listFeatureGrants,
  setFeatureGrant,
  shallowFieldDiffs,
  userHasAuditGrant,
  writeAudit,
} from '../../src/services/auditLog.service';
import { getMenusForUser, getUserRoles } from '../../src/services/roles.service';
import { createUser, ensureBioTimeConfig, resetDatabase } from '../helpers/db';

describe('auditLog unit', () => {
  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  describe('capDiffPreview / shallowFieldDiffs', () => {
    it('caps preview length and truncates long strings', () => {
      const rows = Array.from({ length: 60 }, (_, i) => ({
        entityId: `e${i}`,
        field: 'name',
        before: 'a'.repeat(600),
        after: `v${i}`,
      }));
      const capped = capDiffPreview(rows);
      expect(capped).toHaveLength(50);
      expect(String(capped[0].before).endsWith('…')).toBe(true);
    });

    it('diffs only changed fields', () => {
      const diffs = shallowFieldDiffs(
        { name: 'Ali', code: '1', active: true },
        { name: 'Ali Updated', code: '1', active: false },
        { entityId: 'x', entityLabel: 'Ali' },
      );
      expect(diffs.map((d) => d.field).sort()).toEqual(['active', 'name']);
    });
  });

  describe('write / list / get / export', () => {
    it('persists an audit row and lists it', async () => {
      const hr = await createUser({ login: 'hr-audit@test.local', role: UserRole.HR_MANAGER });
      const id = await writeAudit({
        actor: {
          id: hr.userId,
          login: hr.login,
          name: 'HR Manager',
          role: UserRole.HR_MANAGER,
        },
        module: 'employees',
        action: 'employees.update',
        summary: 'تعديل موظف اختبار',
        entityType: 'EmployeeProfile',
        entityId: 'emp-1',
        counts: { changed: 2 },
        diffPreview: [
          { entityId: 'emp-1', field: 'name', before: 'A', after: 'B' },
        ],
        payload: {
          changes: [{ entityId: 'emp-1', field: 'name', before: 'A', after: 'B' }],
        },
        route: '/employees/update',
      });
      expect(id).toBeTruthy();

      const list = await listAuditLogs({ module: 'employees', limit: 10, offset: 0 });
      expect(list.total).toBeGreaterThanOrEqual(1);
      expect(list.items[0]?.action).toBe('employees.update');
      expect(list.items[0]?.summary).toContain('تعديل');

      const full = await getAuditLog(id!);
      expect(full.payload).toMatchObject({ changes: expect.any(Array) });

      const file = await exportAuditLogXlsx(id!);
      expect(file.base64?.length ?? file.file?.toString().length).toBeGreaterThan(100);
      expect(String(file.filename)).toMatch(/audit_employees/);
    });

    it('does not throw when writeAudit fails soft-path (still returns null safely on bad actor only)', async () => {
      const id = await writeAudit({
        module: 'payroll',
        action: 'payroll.create',
        summary: 'إنشاء كشف',
      });
      expect(id).toBeTruthy();
    });
  });

  describe('feature grants + canViewAudit', () => {
    it('platform admin can always view', async () => {
      expect(
        await canViewAudit({
          id: 'platform-admin',
          login: 'bioadmin@admin.bio',
          role: UserRole.PLATFORM_ADMIN,
        }),
      ).toBe(true);
    });

    it('HR user cannot view until grant enabled', async () => {
      const hr = await createUser({ login: 'hr-grant@test.local', role: UserRole.HR_USER });
      expect(await userHasAuditGrant(hr.userId)).toBe(false);
      expect(
        await canViewAudit({
          id: hr.userId,
          login: hr.login,
          role: UserRole.HR_USER,
        }),
      ).toBe(false);

      await setFeatureGrant({ userId: hr.userId, enabled: true, feature: AUDIT_FEATURE });
      expect(await userHasAuditGrant(hr.userId)).toBe(true);
      expect(
        await canViewAudit({
          id: hr.userId,
          login: hr.login,
          role: UserRole.HR_USER,
        }),
      ).toBe(true);

      await setFeatureGrant({ userId: hr.userId, enabled: false });
      expect(await userHasAuditGrant(hr.userId)).toBe(false);
    });

    it('lists HR users with enabled flag', async () => {
      await createUser({ login: 'hr1@test.local', role: UserRole.HR_MANAGER });
      const hr2 = await createUser({ login: 'hr2@test.local', role: UserRole.HR_SUPERVISOR });
      await setFeatureGrant({ userId: hr2.userId, enabled: true });
      const items = await listFeatureGrants();
      expect(items.length).toBeGreaterThanOrEqual(2);
      const row = items.find((i) => i.userId === hr2.userId);
      expect(row?.enabled).toBe(true);
    });
  });

  describe('menus', () => {
    it('does not add an audit sidebar menu for platform admin', () => {
      const roles = getUserRoles(
        {
          id: 'x',
          login: 'bioadmin@admin.bio',
          email: 'bioadmin@admin.bio',
          name: 'Admin',
          passwordHash: 'x',
          initialPassword: null,
          role: UserRole.PLATFORM_ADMIN,
          locationId: null,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        false,
      );
      const menus = getMenusForUser(roles, { auditLog: true });
      expect(menus.some((m) => m.id === 'audit')).toBe(false);
    });

    it('does not add an audit sidebar menu even when grant option is true for HR', () => {
      const roles = getUserRoles(
        {
          id: 'x',
          login: 'hr@test.local',
          email: 'hr@test.local',
          name: 'HR',
          passwordHash: 'x',
          initialPassword: null,
          role: UserRole.HR_MANAGER,
          locationId: null,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        false,
      );
      expect(getMenusForUser(roles).some((m) => m.id === 'audit')).toBe(false);
      expect(getMenusForUser(roles, { auditLog: true }).some((m) => m.id === 'audit')).toBe(false);
    });
  });
});
