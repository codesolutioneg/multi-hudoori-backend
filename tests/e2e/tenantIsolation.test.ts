import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { prismaBase } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { resetDatabase } from '../helpers/db';
import { ensureBioTimeConfigFromEnv } from '../../src/bootstrap/biotimeConfig';
import { ensureOdooConfigFromEnv } from '../../src/bootstrap/odooConfig';

async function seedCompany(code: string, name: string) {
  const company = await prismaBase.company.create({
    data: { code, name, active: true },
  });
  await ensureBioTimeConfigFromEnv(company.id);
  await ensureOdooConfigFromEnv(company.id);

  const password = 'HrPass#2026';
  const passwordHash = await bcrypt.hash(password, 4);
  const user = await prismaBase.user.create({
    data: {
      companyId: company.id,
      login: `hr@${code}.test`,
      email: `hr@${code}.test`,
      name: `${name} HR`,
      passwordHash,
      role: UserRole.HR_MANAGER,
      initialPassword: password,
    },
  });
  await prismaBase.employeeProfile.create({
    data: {
      companyId: company.id,
      userId: user.id,
      name: `${name} HR`,
      displayName: `${name} HR`,
    },
  });
  await prismaBase.location.create({
    data: {
      companyId: company.id,
      name: `${name} HQ`,
      code: `${code}-hq`,
    },
  });

  return { company, login: user.login, password };
}

function locationRows(data: Record<string, unknown>): Array<{ code?: string }> {
  if (Array.isArray(data.locations)) return data.locations as Array<{ code?: string }>;
  if (Array.isArray(data.items)) return data.items as Array<{ code?: string }>;
  if (Array.isArray(data)) return data as Array<{ code?: string }>;
  return [];
}

describe('multi-tenant isolation', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('requires companyCode for company HR login', async () => {
    const a = await seedCompany('alpha', 'Alpha Co');
    const without = await rpc('/api/auth/login', {
      login: a.login,
      password: a.password,
    });
    expectFail(without, 'INVALID_CREDENTIALS');

    const withCode = await rpc('/api/auth/login', {
      companyCode: 'alpha',
      login: a.login,
      password: a.password,
    });
    expectOk(withCode);
  });

  it('keeps locations isolated between companies', async () => {
    const a = await seedCompany('alpha', 'Alpha Co');
    const b = await seedCompany('beta', 'Beta Co');

    const loginA = expectOk(
      await rpc('/api/auth/login', {
        companyCode: 'alpha',
        login: a.login,
        password: a.password,
      }),
    );
    const loginB = expectOk(
      await rpc('/api/auth/login', {
        companyCode: 'beta',
        login: b.login,
        password: b.password,
      }),
    );

    const listA = expectOk(
      await rpc('/api/biotime/locations/list', {}, String(loginA.token)),
    );
    const listB = expectOk(
      await rpc('/api/biotime/locations/list', {}, String(loginB.token)),
    );

    const rowsA = locationRows(listA);
    const rowsB = locationRows(listB);

    expect(rowsA.some((r) => r.code === 'alpha-hq')).toBe(true);
    expect(rowsA.some((r) => r.code === 'beta-hq')).toBe(false);
    expect(rowsB.some((r) => r.code === 'beta-hq')).toBe(true);
    expect(rowsB.some((r) => r.code === 'alpha-hq')).toBe(false);

    const cross = await rpc('/api/auth/login', {
      companyCode: 'beta',
      login: a.login,
      password: a.password,
    });
    expectFail(cross, 'INVALID_CREDENTIALS');
  });

  it('lets platform admin create companies and scope users by activeCompanyId', async () => {
    const passwordHash = await bcrypt.hash('Hudoori$BioAdmin#2026!xK9mQ2', 4);
    await prismaBase.user.create({
      data: {
        companyId: null,
        login: 'bioadmin@admin.bio',
        email: 'bioadmin@admin.bio',
        name: 'Platform Admin',
        passwordHash,
        role: UserRole.PLATFORM_ADMIN,
      },
    });

    const adminLogin = expectOk(
      await rpc('/api/auth/login', {
        login: 'bioadmin@admin.bio',
        password: 'Hudoori$BioAdmin#2026!xK9mQ2',
      }),
    );
    const token = String(adminLogin.token);

    const created = expectOk(
      await rpc(
        '/api/admin/companies/create',
        {
          code: 'gamma',
          name: 'Gamma Inc',
          hrManagerLogin: 'hr@gamma.test',
          hrManagerPassword: 'HrPass#2026',
          hrManagerName: 'Gamma HR',
        },
        token,
      ),
    );
    const company = created.company as { id: string };
    const companyId = String(company.id);

    const usersNoCompany = await rpc('/api/admin/users/list', {}, token);
    expectFail(usersNoCompany, 'COMPANY_CONTEXT_REQUIRED');

    const users = expectOk(
      await rpc('/api/admin/users/list', { activeCompanyId: companyId }, token),
    );
    expect(users.count).toBeGreaterThanOrEqual(1);
    expect(
      (users.users as Array<{ login: string }>).some((u) => u.login === 'hr@gamma.test'),
    ).toBe(true);
  });

  it('applies RLS policy when app.company_id is set on the same connection', async () => {
    const a = await seedCompany('alpha', 'Alpha Co');
    const b = await seedCompany('beta', 'Beta Co');

    // Interactive transaction keeps set_config + SELECT on one pooled connection.
    const visible = await prismaBase.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.company_id', $1, true)`,
        a.company.id,
      );
      return tx.$queryRaw<{ code: string }[]>`
        SELECT code FROM locations ORDER BY code
      `;
    });

    expect(visible.map((r) => r.code)).toEqual(['alpha-hq']);
    expect(visible.some((r) => r.code === `${b.company.code}-hq`)).toBe(false);

    // Empty setting = no filter (policy allows NULL/'' for owner/migration paths).
    const all = await prismaBase.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.company_id', '', true)`);
      return tx.$queryRaw<{ code: string }[]>`
        SELECT code FROM locations ORDER BY code
      `;
    });
    expect(all.map((r) => r.code).sort()).toEqual(['alpha-hq', 'beta-hq']);
  });
});
