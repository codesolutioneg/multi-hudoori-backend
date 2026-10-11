import { describe, it, expect, beforeEach } from 'vitest';
import { prismaBase } from '../../src/prisma/client';
import { resetDatabase } from '../helpers/db';
import {
  assertNewChildQuotasUnderParent,
  assertParentQuotaCoversChildren,
  getParentPoolSnapshot,
  listGroupCompanyIds,
} from '../../src/services/companyGroupQuota.service';

describe('companyGroupQuota', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('rejects child maxUsers above parent', async () => {
    const parent = await prismaBase.company.create({
      data: { code: 'parent', name: 'Parent', maxUsers: 10, maxEmployees: 100, active: true },
    });
    await expect(
      assertNewChildQuotasUnderParent(parent.id, { maxUsers: 20, maxEmployees: 50 }),
    ).rejects.toMatchObject({ errorCode: 'PARENT_QUOTA_EXCEEDED' });
  });

  it('rejects unlimited child employees under capped parent', async () => {
    const parent = await prismaBase.company.create({
      data: { code: 'parent2', name: 'Parent', maxUsers: 10, maxEmployees: 1000, active: true },
    });
    await expect(
      assertNewChildQuotasUnderParent(parent.id, { maxUsers: 5, maxEmployees: null }),
    ).rejects.toMatchObject({ errorCode: 'PARENT_QUOTA_EXCEEDED' });
  });

  it('rejects sibling employee allocations that exhaust the parent pool', async () => {
    const parent = await prismaBase.company.create({
      data: { code: 'pool', name: 'Pool', maxUsers: 50, maxEmployees: 1000, active: true },
    });
    await prismaBase.company.create({
      data: {
        code: 'c400a',
        name: 'A',
        parentCompanyId: parent.id,
        maxUsers: 10,
        maxEmployees: 400,
        active: true,
      },
    });
    await prismaBase.company.create({
      data: {
        code: 'c400b',
        name: 'B',
        parentCompanyId: parent.id,
        maxUsers: 10,
        maxEmployees: 400,
        active: true,
      },
    });
    await expect(
      assertNewChildQuotasUnderParent(parent.id, { maxUsers: 5, maxEmployees: 201 }),
    ).rejects.toMatchObject({ errorCode: 'PARENT_QUOTA_EXCEEDED' });

    await assertNewChildQuotasUnderParent(parent.id, { maxUsers: 5, maxEmployees: 200 });
    const pool = await getParentPoolSnapshot(parent.id);
    expect(pool?.remainingEmployees).toBe(200);
  });

  it('rejects lowering parent below children allocations', async () => {
    const parent = await prismaBase.company.create({
      data: { code: 'root', name: 'Root', maxUsers: 50, maxEmployees: 1000, active: true },
    });
    await prismaBase.company.create({
      data: {
        code: 'branch',
        name: 'Branch',
        parentCompanyId: parent.id,
        maxUsers: 10,
        maxEmployees: 600,
        active: true,
      },
    });
    await expect(
      assertParentQuotaCoversChildren(parent.id, 50, 500),
    ).rejects.toMatchObject({ errorCode: 'PARENT_QUOTA_EXCEEDED' });
  });

  it('lists parent and descendants', async () => {
    const parent = await prismaBase.company.create({
      data: { code: 'p1', name: 'P', maxUsers: 50, maxEmployees: 50, active: true },
    });
    const child = await prismaBase.company.create({
      data: {
        code: 'c1',
        name: 'C',
        parentCompanyId: parent.id,
        maxUsers: 20,
        maxEmployees: 20,
        active: true,
      },
    });
    const ids = await listGroupCompanyIds(parent.id);
    expect(ids.sort()).toEqual([parent.id, child.id].sort());
  });
});
