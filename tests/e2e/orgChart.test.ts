import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createUser,
  ensureBioTimeConfig,
  ensureDefaultCompany,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';
import { enterTenant, runWithTenant } from '../../src/tenant/context';

type Node = {
  id: string;
  name: string;
  jobTitle: string;
  children: Node[];
};

/** Flattens the tree to `name -> parent name` so assertions read like the chart. */
function parentByName(roots: Node[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const walk = (node: Node, parent: string | null) => {
    out.set(node.name, parent);
    for (const child of node.children ?? []) walk(child, node.name);
  };
  for (const r of roots) walk(r, null);
  return out;
}

function findNode(roots: Node[], name: string): Node | null {
  for (const r of roots) {
    if (r.name === name) return r;
    const hit = findNode(r.children ?? [], name);
    if (hit) return hit;
  }
  return null;
}

describe('org chart', () => {
  let hrManager: SeededUser;
  let hrUser: SeededUser;
  let siteA: { id: string };
  let siteB: { id: string };

  async function withTenant<T>(fn: () => Promise<T>): Promise<T> {
    const companyId = await ensureDefaultCompany();
    return runWithTenant({ companyId, isImpersonatingCompany: false, actorUserId: 'test' }, async () => {
      enterTenant({ companyId, isImpersonatingCompany: false, actorUserId: 'test' });
      return fn();
    });
  }

  async function createEmp(data: Record<string, unknown>) {
    return withTenant(async () => {
      const companyId = await ensureDefaultCompany();
      return prisma.employeeProfile.create({
        data: { companyId, ...data } as never,
      });
    });
  }

  /** Site A: branch head, shift leader, two waiters. Site B: its own head + waiter. */
  async function seedRoster() {
    const mk = (
      name: string,
      jobTitle: string,
      locationId: string,
      over: Record<string, unknown> = {},
    ) => createEmp({ name, code: name, jobTitle, locationId, ...over });

    const headA = await mk('A-Head', 'مدير الفرع', siteA.id);
    const shiftA = await mk('A-Shift', 'شيفت ليدر', siteA.id);
    const waiter1 = await mk('A-Waiter1', 'ويتر', siteA.id);
    const waiter2 = await mk('A-Waiter2', 'ويتر', siteA.id);
    const headB = await mk('B-Head', 'مدير الفرع', siteB.id);
    const waiterB = await mk('B-Waiter', 'ويتر', siteB.id);
    return { headA, shiftA, waiter1, waiter2, headB, waiterB };
  }

  const tree = async (scope = 'company', locationId?: string) =>
    expectOk(
      await rpc(
        '/api/biotime/org-chart/tree',
        { scope, ...(locationId ? { locationId } : {}) },
        hrManager.token,
      ),
      'tree',
    );

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    siteA = await createLocation({ name: 'Site A', code: 'SA' });
    siteB = await createLocation({ name: 'Site B', code: 'SB' });
    hrManager = await createUser({
      login: 'hrm@test.local',
      role: UserRole.HR_MANAGER,
    });
    hrUser = await createUser({ login: 'hru@test.local', role: UserRole.HR_USER });
  });

  describe('derived tree', () => {
    it('builds one root per site and hangs staff off the nearest rank', async () => {
      await seedRoster();
      const data = await tree();
      const parents = parentByName(data.roots as Node[]);

      expect(parents.get('A-Head')).toBeNull();
      expect(parents.get('B-Head')).toBeNull();
      expect(parents.get('A-Shift')).toBe('A-Head');
      expect(parents.get('A-Waiter1')).toBe('A-Shift');
      expect(parents.get('B-Waiter')).toBe('B-Head');
      expect(data.employeeCount).toBe(6);
    });

    it('picks up a newly hired employee with no backfill', async () => {
      await seedRoster();
      expect((await tree()).employeeCount).toBe(6);

      await createEmp({
          name: 'A-NewHire',
          code: 'A-NewHire',
          jobTitle: 'ويتر',
          locationId: siteA.id,
        });

      const data = await tree();
      expect(data.employeeCount).toBe(7);
      expect(parentByName(data.roots as Node[]).get('A-NewHire')).toBe('A-Shift');
    });

    it('promotes a new hire to site head when their title outranks everyone', async () => {
      await seedRoster();
      await createEmp({
          name: 'A-Area',
          code: 'A-Area',
          jobTitle: 'مدير منطقه',
          locationId: siteA.id,
        });
      const parents = parentByName((await tree()).roots as Node[]);
      expect(parents.get('A-Area')).toBeNull();
      expect(parents.get('A-Head')).toBe('A-Area');
    });

    it('keeps employees with no site as roots instead of dropping them', async () => {
      await createEmp({ name: 'Floating', code: 'F1', jobTitle: 'ويتر', locationId: null });
      const data = await tree();
      expect(data.employeeCount).toBe(1);
      expect(parentByName(data.roots as Node[]).get('Floating')).toBeNull();
    });

    it('excludes archived employees from the chart', async () => {
      const { waiter1 } = await seedRoster();
      await withTenant(() =>
        prisma.employeeProfile.update({
          where: { id: waiter1.id },
          data: { active: false, archivedAt: new Date() },
        }),
      );
      const data = await tree();
      expect(data.employeeCount).toBe(5);
      expect(findNode(data.roots as Node[], 'A-Waiter1')).toBeNull();
    });

    it('scopes to a single location on request', async () => {
      await seedRoster();
      const data = await tree('location', siteA.id);
      expect(data.employeeCount).toBe(4);
      expect(findNode(data.roots as Node[], 'B-Head')).toBeNull();
    });

    it('rejects a location scope with no location', async () => {
      expectFail(
        await rpc('/api/biotime/org-chart/tree', { scope: 'location' }, hrManager.token),
        'VALIDATION',
      );
    });
  });

  describe('sibling order', () => {
    const mk = (name: string, jobTitle: string) =>
      createEmp({ name, code: name, jobTitle, locationId: siteA.id });

    it('keeps people with the same title together, then sorts them by name', async () => {
      await mk('Head', 'مدير الفرع');
      await mk('Shift', 'شيفت ليدر');
      // Inserted out of order, and named so that sorting by name alone would
      // interleave the two titles — which is exactly what used to happen.
      await mk('Zed-Waiter', 'ويتر');
      await mk('Adam-Cashier', 'كاشير');
      await mk('Yara-Waiter', 'ويتر');
      await mk('Bassem-Cashier', 'كاشير');

      const shift = findNode((await tree()).roots as Node[], 'Shift')!;
      const titles = shift.children.map((c) => c.jobTitle);

      // Each title occupies one unbroken run.
      expect(new Set(titles).size).toBe(2);
      const runs = titles.filter((t, i) => t !== titles[i - 1]);
      expect(runs.length).toBe(2);

      // And inside a run, alphabetical by name.
      const namesFor = (title: string) =>
        shift.children.filter((c) => c.jobTitle === title).map((c) => c.name);
      expect(namesFor('كاشير')).toEqual(['Adam-Cashier', 'Bassem-Cashier']);
      expect(namesFor('ويتر')).toEqual(['Yara-Waiter', 'Zed-Waiter']);
    });

    it('puts the more senior title first when ranks are mixed under one manager', async () => {
      const head = await mk('Head', 'مدير الفرع');
      const waiter = await mk('Aaa-Waiter', 'ويتر');
      const shift = await mk('Zzz-Shift', 'شيفت ليدر');

      // Pull both directly under the head so their ranks actually compete.
      for (const emp of [waiter, shift]) {
        expectOk(
          await rpc(
            '/api/biotime/org-chart/set-manager',
            { employeeId: emp.id, managerId: head.id },
            hrManager.token,
          ),
        );
      }

      const root = findNode((await tree()).roots as Node[], 'Head')!;
      // Name order would put the waiter first; rank must win.
      expect(root.children.map((c) => c.name)).toEqual(['Zzz-Shift', 'Aaa-Waiter']);
    });

    it('reorders siblings when the ladder is reconfigured', async () => {
      await mk('Head', 'مدير الفرع');
      await mk('Acc', 'محاسب مالي');
      await mk('Wai', 'ويتر');

      // Both are staff, so the site head owns them and name order applies.
      let head = findNode((await tree()).roots as Node[], 'Head')!;
      expect(head.children.map((c) => c.name)).toEqual(['Acc', 'Wai']);

      // Promote «محاسب مالي» above the rest from the settings screen.
      await withTenant(async () => {
        const companyId = await ensureDefaultCompany();
        const level = await prisma.jobLevel.create({
          data: { companyId, name: 'مشرف مالي', code: 'fin_sup', rank: 4 },
        });
        await prisma.jobTitle.create({
          data: { companyId, name: 'محاسب مالي', code: 'JT-ACC', levelId: level.id },
        });
      });

      // The accountant now leads, and the waiter reports to them instead.
      head = findNode((await tree()).roots as Node[], 'Head')!;
      expect(head.children.map((c) => c.name)).toEqual(['Acc']);
      expect(head.children[0]!.children.map((c) => c.name)).toEqual(['Wai']);
    });
  });

  describe('set-manager', () => {
    it('moves an employee under another manager in the same branch', async () => {
      const { headA, waiter1 } = await seedRoster();

      expectOk(
        await rpc(
          '/api/biotime/org-chart/set-manager',
          { employeeId: waiter1.id, managerId: headA.id },
          hrManager.token,
        ),
        'set-manager',
      );

      const row = await withTenant(() =>
        prisma.employeeProfile.findUnique({ where: { id: waiter1.id } }),
      );
      expect(row?.managerId).toBe(headA.id);
      // And the chart reflects it instead of the derived shift leader.
      expect(parentByName((await tree()).roots as Node[]).get('A-Waiter1')).toBe('A-Head');
    });

    it('refuses a manager from a different branch', async () => {
      const { waiter1, headB } = await seedRoster();
      const res = await rpc(
        '/api/biotime/org-chart/set-manager',
        { employeeId: waiter1.id, managerId: headB.id },
        hrManager.token,
      );
      expectFail(res, 'VALIDATION');
      expect(res.body.result?.message).toContain('نفس الفرع');

      const row = await withTenant(() =>
        prisma.employeeProfile.findUnique({ where: { id: waiter1.id } }),
      );
      expect(row?.managerId).toBeNull();
    });

    it('refuses to make someone their own manager', async () => {
      const { waiter1 } = await seedRoster();
      expectFail(
        await rpc(
          '/api/biotime/org-chart/set-manager',
          { employeeId: waiter1.id, managerId: waiter1.id },
          hrManager.token,
        ),
        'VALIDATION',
      );
    });

    it('refuses a manager that would close a cycle', async () => {
      const { headA, shiftA } = await seedRoster();
      expectOk(
        await rpc(
          '/api/biotime/org-chart/set-manager',
          { employeeId: shiftA.id, managerId: headA.id },
          hrManager.token,
        ),
      );
      expectFail(
        await rpc(
          '/api/biotime/org-chart/set-manager',
          { employeeId: headA.id, managerId: shiftA.id },
          hrManager.token,
        ),
        'VALIDATION',
      );
    });

    it('refuses an archived manager', async () => {
      const { headA, waiter1 } = await seedRoster();
      await withTenant(() =>
        prisma.employeeProfile.update({
          where: { id: headA.id },
          data: { active: false, archivedAt: new Date() },
        }),
      );
      expectFail(
        await rpc(
          '/api/biotime/org-chart/set-manager',
          { employeeId: waiter1.id, managerId: headA.id },
          hrManager.token,
        ),
        'NOT_FOUND',
      );
    });

    it('detaches with a null manager and falls back to derivation', async () => {
      const { headA, waiter1 } = await seedRoster();
      await rpc(
        '/api/biotime/org-chart/set-manager',
        { employeeId: waiter1.id, managerId: headA.id },
        hrManager.token,
      );

      expectOk(
        await rpc(
          '/api/biotime/org-chart/set-manager',
          { employeeId: waiter1.id, managerId: null },
          hrManager.token,
        ),
        'detach',
      );

      const row = await withTenant(() =>
        prisma.employeeProfile.findUnique({ where: { id: waiter1.id } }),
      );
      expect(row?.managerId).toBeNull();
      expect(parentByName((await tree()).roots as Node[]).get('A-Waiter1')).toBe('A-Shift');
    });

    it('writes an audit entry carrying the previous manager', async () => {
      const { headA, waiter1 } = await seedRoster();
      await rpc(
        '/api/biotime/org-chart/set-manager',
        { employeeId: waiter1.id, managerId: headA.id },
        hrManager.token,
      );
      const log = await withTenant(() =>
        prisma.auditLog.findFirst({
          where: { action: 'org_chart.set_manager', entityId: waiter1.id },
        }),
      );
      expect(log).toBeTruthy();
      expect(log?.payload).toMatchObject({ from: null, to: headA.id });
    });

    it('is closed to HR users below manager level', async () => {
      const { headA, waiter1 } = await seedRoster();
      const res = await rpc(
        '/api/biotime/org-chart/set-manager',
        { employeeId: waiter1.id, managerId: headA.id },
        hrUser.token,
      );
      expect(res.body.result?.success).not.toBe(true);
    });
  });

  describe('manager-options', () => {
    it('only offers colleagues from the same branch', async () => {
      const { waiter1 } = await seedRoster();
      const data = expectOk(
        await rpc(
          '/api/biotime/org-chart/manager-options',
          { employeeId: waiter1.id },
          hrManager.token,
        ),
      );
      const names = (data.managers as { name: string }[]).map((m) => m.name);
      expect(names.sort()).toEqual(['A-Head', 'A-Shift', 'A-Waiter2']);
      expect(names).not.toContain('B-Head');
      expect(names).not.toContain('A-Waiter1');
    });

    it('drops anyone already reporting into the employee', async () => {
      const { shiftA, waiter1 } = await seedRoster();
      // Waiter1 is made the shift leader's manager, so the shift leader is now below.
      await rpc(
        '/api/biotime/org-chart/set-manager',
        { employeeId: shiftA.id, managerId: waiter1.id },
        hrManager.token,
      );
      const data = expectOk(
        await rpc(
          '/api/biotime/org-chart/manager-options',
          { employeeId: waiter1.id },
          hrManager.token,
        ),
      );
      const names = (data.managers as { name: string }[]).map((m) => m.name);
      expect(names).not.toContain('A-Shift');
      expect(names).toContain('A-Head');
    });

    it('filters by name, code or job title', async () => {
      const { waiter1 } = await seedRoster();
      const data = expectOk(
        await rpc(
          '/api/biotime/org-chart/manager-options',
          { employeeId: waiter1.id, search: 'شيفت' },
          hrManager.token,
        ),
      );
      expect((data.managers as { name: string }[]).map((m) => m.name)).toEqual([
        'A-Shift',
      ]);
    });
  });

  describe('manual placement survives other operations', () => {
    async function placedWaiter() {
      const roster = await seedRoster();
      await rpc(
        '/api/biotime/org-chart/set-manager',
        { employeeId: roster.waiter1.id, managerId: roster.headA.id },
        hrManager.token,
      );
      return roster;
    }

    it('survives an unrelated partial employee update', async () => {
      const { headA, waiter1 } = await placedWaiter();
      expectOk(
        await rpc(
          '/api/biotime/employees/update',
          { id: waiter1.id, basicSalary: 5555 },
          hrManager.token,
        ),
        'update',
      );
      const row = await withTenant(() =>
        prisma.employeeProfile.findUnique({ where: { id: waiter1.id } }),
      );
      expect(row?.basicSalary).toBe(5555);
      expect(row?.managerId).toBe(headA.id);
    });

    it('survives archive and restore of the employee', async () => {
      const { headA, waiter1 } = await placedWaiter();
      expectOk(
        await rpc(
          '/api/biotime/employees/archive',
          { id: waiter1.id, reason: 'resigned' },
          hrManager.token,
        ),
        'archive',
      );
      expect(
        (
          await withTenant(() =>
            prisma.employeeProfile.findUnique({ where: { id: waiter1.id } }),
          )
        )?.managerId,
      ).toBe(headA.id);

      expectOk(
        await rpc('/api/biotime/employees/restore', { id: waiter1.id }, hrManager.token),
        'restore',
      );
      expect(parentByName((await tree()).roots as Node[]).get('A-Waiter1')).toBe('A-Head');
    });

    it('hides the line while the manager is archived and restores it after', async () => {
      const { headA, waiter1 } = await placedWaiter();
      await rpc(
        '/api/biotime/employees/archive',
        { id: headA.id, reason: 'resigned' },
        hrManager.token,
      );
      // The stored link is untouched even though the chart cannot show it.
      expect(
        (
          await withTenant(() =>
            prisma.employeeProfile.findUnique({ where: { id: waiter1.id } }),
          )
        )?.managerId,
      ).toBe(headA.id);

      await rpc('/api/biotime/employees/restore', { id: headA.id }, hrManager.token);
      expect(parentByName((await tree()).roots as Node[]).get('A-Waiter1')).toBe('A-Head');
    });

    it('re-parents direct reports instead of blanking them when a manager is deleted', async () => {
      const { headA, shiftA, waiter1 } = await seedRoster();
      // waiter1 -> shiftA -> headA, all explicit.
      await rpc(
        '/api/biotime/org-chart/set-manager',
        { employeeId: shiftA.id, managerId: headA.id },
        hrManager.token,
      );
      await rpc(
        '/api/biotime/org-chart/set-manager',
        { employeeId: waiter1.id, managerId: shiftA.id },
        hrManager.token,
      );

      const { deleteEmployee } = await import('../../src/services/employeeDelete.service');
      const result = await withTenant(() => deleteEmployee(shiftA.id));
      expect(result.reparentedReports).toBe(1);

      const row = await withTenant(() =>
        prisma.employeeProfile.findUnique({ where: { id: waiter1.id } }),
      );
      expect(row?.managerId).toBe(headA.id);
    });

    it('keeps the placement when the job title changes', async () => {
      const { headA, waiter1 } = await placedWaiter();
      await withTenant(() =>
        prisma.employeeProfile.update({
          where: { id: waiter1.id },
          data: { jobTitle: 'كاشير' },
        }),
      );
      expect(parentByName((await tree()).roots as Node[]).get('A-Waiter1')).toBe('A-Head');
    });
  });
});
