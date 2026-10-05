import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import app from '../../src/app';
import { prismaBase } from '../../src/prisma/client';
import { expectFail, expectOk, plain, rpc } from '../helpers/api';
import { createUser, resetDatabase } from '../helpers/db';

describe('sales requests & public plans', () => {
  beforeEach(async () => {
    await resetDatabase();
    await prismaBase.subscriptionPlan.upsert({
      where: { slug: 'start' },
      create: {
        id: 'plan_start',
        slug: 'start',
        nameAr: 'البداية',
        nameEn: 'Start',
        priceDisplayAr: '$2',
        priceDisplayEn: '$2',
        status: 'PUBLISHED',
        sortOrder: 1,
      },
      update: { status: 'PUBLISHED' },
    });
  });

  it('lists published plans publicly', async () => {
    const res = await request(app).get('/api/public/plans');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data?.plans)).toBe(true);
  });

  it('creates a sales request and approves into a company', async () => {
    const createRes = await plain('/api/public/sales-requests', {
      companyCode: 'newco',
      companyName: 'New Co',
      contactName: 'Ali',
      email: 'ali@newco.test',
      phone: '+201012345678',
      requestedEmployees: 25,
      planId: 'plan_start',
    });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect(createRes.body.success).toBe(true);

    const admin = await createUser({ login: 'sales-admin@admin.bio', role: UserRole.PLATFORM_ADMIN });
    const list = expectOk(await rpc('/api/admin/sales-requests/list', {}, admin.token));
    const requests = list.requests as Array<{ id: string; companyCode: string }>;
    expect(requests.some((r) => r.companyCode === 'newco')).toBe(true);
    const id = requests.find((r) => r.companyCode === 'newco')!.id;

    const approved = expectOk(await rpc('/api/admin/sales-requests/approve', { id }, admin.token));
    expect((approved.company as { code: string }).code).toBe('newco');

    const company = await prismaBase.company.findFirst({ where: { code: 'newco' } });
    expect(company).not.toBeNull();
    const hr = await prismaBase.user.findFirst({ where: { companyId: company!.id, login: 'ali@newco.test' } });
    expect(hr?.role).toBe('HR_MANAGER');

    expectFail(await rpc('/api/admin/sales-requests/approve', { id }, admin.token));
  });
});
