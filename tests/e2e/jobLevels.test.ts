import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createUser,
  ensureBioTimeConfig,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';

type Level = {
  id: string;
  name: string;
  code: string;
  rank: number;
  titles: { id: string; name: string; employeeCount: number }[];
};

describe('job levels («تدرج الوظائف»)', () => {
  let hrManager: SeededUser;
  let hrUser: SeededUser;

  const ladder = async (token = hrManager.token) =>
    expectOk(await rpc('/api/biotime/job-levels/list', {}, token), 'list');

  const levels = async () => (await ladder()).levels as Level[];

  const createLevel = (name: string, code?: string, token = hrManager.token) =>
    rpc('/api/biotime/job-levels/create', { name, ...(code ? { code } : {}) }, token);

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hrManager = await createUser({ login: 'hrm@test.local', role: UserRole.HR_MANAGER });
    hrUser = await createUser({ login: 'hru@test.local', role: UserRole.HR_USER });
  });

  describe('levels', () => {
    it('starts empty and appends each new level to the bottom', async () => {
      expect(await levels()).toEqual([]);

      expectOk(await createLevel('مدير موقع', 'site_head'), 'first');
      expectOk(await createLevel('مشرف', 'supervisor'), 'second');
      expectOk(await createLevel('طاقم', 'staff'), 'third');

      expect((await levels()).map((l) => [l.rank, l.name])).toEqual([
        [1, 'مدير موقع'],
        [2, 'مشرف'],
        [3, 'طاقم'],
      ]);
    });

    it('returns the whole ladder from every write, so the UI never guesses', async () => {
      const data = expectOk(await createLevel('مشرف'));
      expect((data.levels as Level[]).map((l) => l.name)).toEqual(['مشرف']);
      expect(data).toHaveProperty('unassigned');
    });

    it('rejects a blank name and a duplicate name', async () => {
      expectFail(await createLevel(''), 'VALIDATION');
      expectFail(await createLevel('   '), 'VALIDATION');
      expectOk(await createLevel('مشرف'));
      expectFail(await createLevel('مشرف'), 'VALIDATION');
    });

    it('renames a level without disturbing its rank', async () => {
      expectOk(await createLevel('مشرف'));
      expectOk(await createLevel('طاقم'));
      const [, staff] = await levels();

      expectOk(
        await rpc(
          '/api/biotime/job-levels/update',
          { id: staff!.id, name: 'طاقم التشغيل', code: 'ops' },
          hrManager.token,
        ),
        'rename',
      );

      const after = await levels();
      expect(after[1]!.name).toBe('طاقم التشغيل');
      expect(after[1]!.code).toBe('ops');
      expect(after[1]!.rank).toBe(2);
    });

    it('refuses to rename onto an existing name', async () => {
      expectOk(await createLevel('مشرف'));
      expectOk(await createLevel('طاقم'));
      const [, staff] = await levels();
      expectFail(
        await rpc(
          '/api/biotime/job-levels/update',
          { id: staff!.id, name: 'مشرف' },
          hrManager.token,
        ),
        'VALIDATION',
      );
    });

    it('reorders the ladder', async () => {
      for (const n of ['A', 'B', 'C']) expectOk(await createLevel(n));
      const before = await levels();
      const reordered = [before[2]!.id, before[0]!.id, before[1]!.id];

      expectOk(
        await rpc(
          '/api/biotime/job-levels/reorder',
          { orderedIds: reordered },
          hrManager.token,
        ),
        'reorder',
      );

      expect((await levels()).map((l) => [l.rank, l.name])).toEqual([
        [1, 'C'],
        [2, 'A'],
        [3, 'B'],
      ]);
    });

    it('rejects a reorder that does not cover every level', async () => {
      for (const n of ['A', 'B']) expectOk(await createLevel(n));
      const [a] = await levels();
      expectFail(
        await rpc('/api/biotime/job-levels/reorder', { orderedIds: [a!.id] }, hrManager.token),
        'VALIDATION',
      );
      expectFail(
        await rpc('/api/biotime/job-levels/reorder', { orderedIds: [] }, hrManager.token),
        'VALIDATION',
      );
    });

    it('closes the rank gap after a delete', async () => {
      for (const n of ['A', 'B', 'C']) expectOk(await createLevel(n));
      const [, b] = await levels();

      expectOk(
        await rpc('/api/biotime/job-levels/delete', { id: b!.id }, hrManager.token),
        'delete',
      );

      expect((await levels()).map((l) => [l.rank, l.name])).toEqual([
        [1, 'A'],
        [2, 'C'],
      ]);
    });

    it('reports a missing level instead of failing silently', async () => {
      expectFail(
        await rpc('/api/biotime/job-levels/delete', { id: 'nope' }, hrManager.token),
        'NOT_FOUND',
      );
      expectFail(
        await rpc(
          '/api/biotime/job-levels/update',
          { id: 'nope', name: 'X' },
          hrManager.token,
        ),
        'NOT_FOUND',
      );
    });
  });

  describe('assigning titles', () => {
    async function seedTitles() {
      const level = expectOk(await createLevel('مشرف', 'supervisor'));
      const levelId = (level.levels as Level[])[0]!.id;
      const waiter = await prisma.jobTitle.create({ data: { name: 'ويتر', code: 'JT1' } });
      const shift = await prisma.jobTitle.create({ data: { name: 'شيفت ليدر', code: 'JT2' } });
      return { levelId, waiter, shift };
    }

    it('lists unplaced titles in the unassigned pool', async () => {
      await seedTitles();
      const data = await ladder();
      expect((data.unassigned as { name: string }[]).map((t) => t.name).sort()).toEqual([
        'شيفت ليدر',
        'ويتر',
      ]);
      expect((data.levels as Level[])[0]!.titles).toEqual([]);
    });

    it('moves a title onto a level and back off it', async () => {
      const { levelId, shift } = await seedTitles();

      let data = expectOk(
        await rpc(
          '/api/biotime/job-levels/assign-title',
          { jobTitleId: shift.id, levelId },
          hrManager.token,
        ),
        'assign',
      );
      expect((data.levels as Level[])[0]!.titles.map((t) => t.name)).toEqual(['شيفت ليدر']);
      expect((data.unassigned as { name: string }[]).map((t) => t.name)).toEqual(['ويتر']);

      data = expectOk(
        await rpc(
          '/api/biotime/job-levels/assign-title',
          { jobTitleId: shift.id, levelId: null },
          hrManager.token,
        ),
        'unassign',
      );
      expect((data.levels as Level[])[0]!.titles).toEqual([]);
      expect((data.unassigned as { name: string }[]).length).toBe(2);
    });

    it('returns titles to the pool when their level is deleted', async () => {
      const { levelId, shift } = await seedTitles();
      await rpc(
        '/api/biotime/job-levels/assign-title',
        { jobTitleId: shift.id, levelId },
        hrManager.token,
      );

      const data = expectOk(
        await rpc('/api/biotime/job-levels/delete', { id: levelId }, hrManager.token),
      );
      expect(data.levels).toEqual([]);
      expect((data.unassigned as { name: string }[]).length).toBe(2);
      // The title itself must survive — only its placement is gone.
      expect(await prisma.jobTitle.count()).toBe(2);
    });

    it('rejects an unknown title or level', async () => {
      const { levelId, shift } = await seedTitles();
      expectFail(
        await rpc(
          '/api/biotime/job-levels/assign-title',
          { jobTitleId: 'nope', levelId },
          hrManager.token,
        ),
        'NOT_FOUND',
      );
      expectFail(
        await rpc(
          '/api/biotime/job-levels/assign-title',
          { jobTitleId: shift.id, levelId: 'nope' },
          hrManager.token,
        ),
        'NOT_FOUND',
      );
    });

    it('counts the live headcount holding each title', async () => {
      const { levelId, waiter } = await seedTitles();
      const location = await createLocation({ name: 'S', code: 'S1' });
      for (const name of ['W1', 'W2']) {
        await prisma.employeeProfile.create({
          data: { name, code: name, jobTitle: 'ويتر', locationId: location.id },
        });
      }
      // Archived staff must not inflate the count.
      await prisma.employeeProfile.create({
        data: {
          name: 'W3',
          code: 'W3',
          jobTitle: 'ويتر',
          locationId: location.id,
          active: false,
          archivedAt: new Date(),
        },
      });

      await rpc(
        '/api/biotime/job-levels/assign-title',
        { jobTitleId: waiter.id, levelId },
        hrManager.token,
      );
      const level = (await levels())[0]!;
      expect(level.titles.find((t) => t.name === 'ويتر')?.employeeCount).toBe(2);
    });
  });

  describe('permissions', () => {
    it('lets an HR user read the ladder', async () => {
      expectOk(await createLevel('مشرف'));
      const data = await ladder(hrUser.token);
      expect((data.levels as Level[]).length).toBe(1);
    });

    it('blocks every write below HR manager', async () => {
      expectOk(await createLevel('مشرف'));
      const [level] = await levels();

      for (const [path, params] of [
        ['/api/biotime/job-levels/create', { name: 'X' }],
        ['/api/biotime/job-levels/update', { id: level!.id, name: 'Y' }],
        ['/api/biotime/job-levels/delete', { id: level!.id }],
        ['/api/biotime/job-levels/reorder', { orderedIds: [level!.id] }],
        ['/api/biotime/job-levels/assign-title', { jobTitleId: 'x', levelId: null }],
      ] as const) {
        const res = await rpc(path, params as Record<string, unknown>, hrUser.token);
        expect(res.body.result?.success, path).not.toBe(true);
      }

      // Nothing leaked through.
      expect((await levels()).map((l) => l.name)).toEqual(['مشرف']);
    });

    it('rejects an anonymous caller', async () => {
      const res = await rpc('/api/biotime/job-levels/list', {});
      expect(res.body.result?.success).not.toBe(true);
    });
  });

  describe('audit trail', () => {
    it('records create, assign and reorder', async () => {
      expectOk(await createLevel('مشرف'));
      const [level] = await levels();
      const title = await prisma.jobTitle.create({ data: { name: 'ويتر', code: 'JT1' } });
      await rpc(
        '/api/biotime/job-levels/assign-title',
        { jobTitleId: title.id, levelId: level!.id },
        hrManager.token,
      );
      await rpc(
        '/api/biotime/job-levels/reorder',
        { orderedIds: [level!.id] },
        hrManager.token,
      );

      const actions = (
        await prisma.auditLog.findMany({
          where: { module: 'settings' },
          select: { action: true },
        })
      ).map((a) => a.action);

      expect(actions).toContain('job_levels.create');
      expect(actions).toContain('job_levels.assign_title');
      expect(actions).toContain('job_levels.reorder');
    });
  });
});
