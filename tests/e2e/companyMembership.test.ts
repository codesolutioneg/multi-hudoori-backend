import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';
import { prismaBase } from '../../src/prisma/client';
import { PLATFORM_ADMIN_LOCAL_TOKEN } from '../../src/config';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { addMembership } from '../../src/services/companyMembership.service';
import { createUser, ensureBioTimeConfig, resetDatabase } from '../helpers/db';
import { runWithTenant } from '../../src/tenant/context';

describe('company membership switch', () => {
  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('allows HR to switch to a linked company and blocks others', async () => {
    const companyA = await prismaBase.company.create({
      data: { code: 'co-a', name: 'Company A', active: true },
    });
    const companyB = await prismaBase.company.create({
      data: { code: 'co-b', name: 'Company B', active: true },
    });
    await prismaBase.bioTimeConfig.create({
      data: {
        companyId: companyA.id,
        serverIp: '127.0.0.1',
        serverPort: 8090,
        username: 'u',
        password: 'p',
      },
    });
    await prismaBase.bioTimeConfig.create({
      data: {
        companyId: companyB.id,
        serverIp: '127.0.0.1',
        serverPort: 8090,
        username: 'u',
        password: 'p',
      },
    });

    const hr = await createUser({
      login: 'hr@co-a.test',
      role: UserRole.HR_MANAGER,
      companyId: companyA.id,
    });
    await addMembership({ userId: hr.userId, companyId: companyB.id, role: UserRole.HR_MANAGER });

    await runWithTenant(
      { companyId: companyB.id, isImpersonatingCompany: false, actorUserId: hr.userId },
      async () => {
        await prismaBase.employeeProfile.create({
          data: { companyId: companyB.id, name: 'Emp B', code: 'B001' },
        });
      },
    );

    const meAllowed = await rpc(
      '/api/biotime/me',
      { activeCompanyId: companyB.id },
      hr.token,
    );
    const meData = expectOk(meAllowed);
    expect(meData.activeCompanyId).toBe(companyB.id);
    expect(meData.company?.code).toBe('co-b');
    expect(meData.memberships?.length).toBeGreaterThanOrEqual(2);

    const meDenied = await rpc(
      '/api/biotime/me',
      { activeCompanyId: companyA.id },
      hr.token,
    );
    expectOk(meDenied);

    const companyC = await prismaBase.company.create({
      data: { code: 'co-c', name: 'Company C', active: true },
    });
    const blocked = await rpc(
      '/api/biotime/me',
      { activeCompanyId: companyC.id },
      hr.token,
    );
    expectFail(blocked, 'ACCESS_DENIED');
  });

  it('returns memberships on login', async () => {
    const hr = await createUser({
      login: 'hr2@test.local',
      role: UserRole.HR_USER,
    });
    const home = await prismaBase.company.findUnique({ where: { id: hr.companyId } });
    const login = await rpc('/api/auth/login', {
      login: hr.login,
      password: hr.password,
      companyCode: home!.code,
    });
    const data = expectOk(login);
    expect(Array.isArray(data.memberships)).toBe(true);
    expect(data.memberships.length).toBeGreaterThanOrEqual(1);
    expect(data.activeCompanyId).toBeTruthy();
  });

  it('platform admin can manage memberships', async () => {
    const companyB = await prismaBase.company.create({
      data: { code: 'link-b', name: 'Link B', active: true },
    });
    const hr = await createUser({
      login: 'hr-link@test.local',
      role: UserRole.HR_MANAGER,
    });

    const add = await rpc(
      '/api/admin/memberships/add',
      { userId: hr.userId, companyId: companyB.id },
      PLATFORM_ADMIN_LOCAL_TOKEN,
    );
    expectOk(add);

    const list = await rpc(
      '/api/admin/memberships/list',
      { userId: hr.userId },
      PLATFORM_ADMIN_LOCAL_TOKEN,
    );
    const items = expectOk(list).memberships as Array<{ companyId: string }>;
    expect(items.some((m) => m.companyId === companyB.id)).toBe(true);
  });
});
