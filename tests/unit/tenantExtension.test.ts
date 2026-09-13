import { describe, it, expect, beforeEach } from 'vitest';
import { prisma, prismaBase } from '../../src/prisma/client';
import { enterTenant, runWithTenant } from '../../src/tenant/context';
import { ensureDefaultCompany, resetDatabase } from '../helpers/db';

async function withCompany<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenant({ companyId, isImpersonatingCompany: false, actorUserId: 't' }, async () => {
    enterTenant({ companyId, isImpersonatingCompany: false, actorUserId: 't' });
    return fn();
  });
}

describe('tenant prisma extension', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('injects companyId on findMany and create', async () => {
    const companyId = await ensureDefaultCompany();
    const other = await prismaBase.company.create({
      data: { code: 'otherco', name: 'Other', active: true },
    });

    await withCompany(companyId, async () => {
      await prisma.location.create({
        data: { name: 'A Branch', code: 'A1' },
      });
    });
    await withCompany(other.id, async () => {
      await prisma.location.create({
        data: { name: 'B Branch', code: 'B1' },
      });
    });

    const a = await withCompany(companyId, () => prisma.location.findMany());
    expect(a).toHaveLength(1);
    expect(a[0].code).toBe('A1');
    expect(a[0].companyId).toBe(companyId);
  });

  it('supports compound unique upsert for systemCounter', async () => {
    const companyId = await ensureDefaultCompany();
    await withCompany(companyId, async () => {
      const first = await prisma.systemCounter.upsert({
        where: { companyId_id: { companyId, id: 'deduction_2026' } },
        create: { companyId, id: 'deduction_2026', value: 1 },
        update: { value: { increment: 1 } },
      });
      expect(first.value).toBe(1);
      const second = await prisma.systemCounter.upsert({
        where: { companyId_id: { companyId, id: 'deduction_2026' } },
        create: { companyId, id: 'deduction_2026', value: 1 },
        update: { value: { increment: 1 } },
      });
      expect(second.value).toBe(2);
    });
  });

  it('refuses update of another company row', async () => {
    const companyId = await ensureDefaultCompany();
    const other = await prismaBase.company.create({
      data: { code: 'other2', name: 'Other2', active: true },
    });
    const foreign = await prismaBase.location.create({
      data: { companyId: other.id, name: 'Foreign', code: 'FX' },
    });

    await expect(
      withCompany(companyId, () =>
        prisma.location.update({
          where: { id: foreign.id },
          data: { name: 'Hacked' },
        }),
      ),
    ).rejects.toThrow(/RECORD_NOT_FOUND_IN_COMPANY/);
  });

  it('jobLevel create works after name uniqueness is company-scoped', async () => {
    const companyId = await ensureDefaultCompany();
    await withCompany(companyId, async () => {
      const { createJobLevel } = await import('../../src/services/jobLevel.service');
      const level = await createJobLevel({ name: 'مدير موقع', code: 'site_head' });
      expect(level.name).toBe('مدير موقع');
      await expect(createJobLevel({ name: 'مدير موقع', code: 'dup' })).rejects.toThrow();
    });
  });
});
