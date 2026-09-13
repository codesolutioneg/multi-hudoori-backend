import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/prisma/client';
import bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { createMockConnector, MOCK_EMPLOYEES, MOCK_TRANSACTIONS } from '../mocks/biotime.mock';
import * as syncService from '../../src/services/biotime/sync.service';
import { generateAttendance } from '../../src/services/attendance.service';
import { generatePunchReport } from '../../src/services/punchReport.service';

vi.mock('../../src/services/biotime/biotimeConnector.service', () => ({
  BioTimeConnector: {
    fromDb: vi.fn(),
  },
}));

import { BioTimeConnector } from '../../src/services/biotime/biotimeConnector.service';

function rpc(path: string, params: Record<string, unknown> = {}, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return request(app)
    .post(path)
    .set(headers)
    .send({ jsonrpc: '2.0', params: { ...params, ...(token ? { token } : {}) }, id: 1 });
}

describe('Phases 3–6 (mocked BioTime — no outbound server calls)', () => {
  let hrToken: string;
  let employeeToken: string;
  let employeeUserId: string;
  let employeeProfileId: string;
  let shiftId: string;

  beforeAll(async () => {
    vi.mocked(BioTimeConnector.fromDb).mockImplementation(async () => createMockConnector() as never);

    const existingCfg = await prisma.bioTimeConfig.findFirst();
    if (!existingCfg) {
      await prisma.bioTimeConfig.create({ data: {} });
    }
    // Do NOT overwrite serverIp — tests mock BioTimeConnector only

    const hrHash = await bcrypt.hash('HrManager#2026', 12);
    await prisma.user.upsert({
      where: { login: 'hr@hudoori.local' },
      update: { passwordHash: hrHash, role: UserRole.HR_MANAGER },
      create: {
        login: 'hr@hudoori.local',
        name: 'HR Manager',
        passwordHash: hrHash,
        role: UserRole.HR_MANAGER,
      },
    });

    const empHash = await bcrypt.hash('Employee#2026', 12);
    const empUser = await prisma.user.upsert({
      where: { login: 'employee@test.local' },
      update: { passwordHash: empHash, role: UserRole.EMPLOYEE },
      create: {
        login: 'employee@test.local',
        name: 'Test Employee',
        passwordHash: empHash,
        role: UserRole.EMPLOYEE,
      },
    });
    employeeUserId = empUser.id;

    const profile = await prisma.employeeProfile.upsert({
      where: { userId: empUser.id },
      update: { code: 'E1001', name: 'Test Employee' },
      create: { userId: empUser.id, code: 'E1001', name: 'Test Employee', basicSalary: 3000 },
    });
    employeeProfileId = profile.id;

    const shift = await prisma.shift.upsert({
      where: { id: 'test-shift-morning' },
      update: {},
      create: {
        id: 'test-shift-morning',
        name: 'Morning',
        startTime: '08:00',
        endTime: '17:00',
        gracePeriodIn: 10,
        gracePeriodOut: 5,
      },
    });
    shiftId = shift.id;

    await prisma.shiftAssignment.upsert({
      where: { id: 'test-assignment-phase4' },
      update: {
        employeeId: employeeProfileId,
        shiftId,
        dateFrom: new Date('2026-01-01'),
        dateTo: null,
        assignmentType: 'permanent',
        active: true,
      },
      create: {
        id: 'test-assignment-phase4',
        employeeId: employeeProfileId,
        shiftId,
        dateFrom: new Date('2026-01-01'),
        dateTo: null,
        assignmentType: 'permanent',
        active: true,
      },
    });

    const hrLogin = await rpc('/api/auth/login', { login: 'hr@hudoori.local', password: 'HrManager#2026' });
    hrToken = hrLogin.body.result.data.token;

    const empLogin = await rpc('/api/auth/login', { login: 'employee@test.local', password: 'Employee#2026' });
    employeeToken = empLogin.body.result.data.token;
  });

  beforeEach(() => {
    vi.mocked(BioTimeConnector.fromDb).mockImplementation(async () => createMockConnector() as never);
  });

  it('Phase 3: config/get returns counts from local DB (no BioTime call)', async () => {
    const res = await rpc('/api/biotime/config/get', {}, hrToken);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.data.config).toBeDefined();
    expect(typeof res.body.result.data.config.employeeCount).toBe('number');
    expect(BioTimeConnector.fromDb).not.toHaveBeenCalled();
  });

  it('Phase 3: sync-status returns local data', async () => {
    const res = await rpc('/api/biotime/config/sync-status', {}, hrToken);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.data.counts).toBeDefined();
    expect(res.body.result.data.recentJobs).toBeDefined();
  });

  it('Phase 2/3: sync pulls mock BioTime data into PostgreSQL (connector mocked)', async () => {
    const before = await prisma.employeeProfile.count();
    const deptCount = await syncService.syncDepartments();
    const empCount = await syncService.syncEmployees();
    const txCount = await syncService.syncTransactions(
      new Date('2026-06-01'),
      new Date('2026-06-02'),
    );

    expect(deptCount).toBeGreaterThan(0);
    expect(empCount).toBeGreaterThan(0);
    // txCount may be 0 if mock transactions already synced in a prior run
    expect(txCount).toBeGreaterThanOrEqual(0);

    const synced = await prisma.employeeProfile.findFirst({ where: { code: MOCK_EMPLOYEES[0].emp_code } });
    expect(synced).toBeTruthy();

    const tx = await prisma.transaction.findFirst({ where: { biotimeTransactionId: MOCK_TRANSACTIONS[0].id } });
    expect(tx).toBeTruthy();
    expect(tx?.empCode).toBe('E1001');

    const after = await prisma.employeeProfile.count();
    expect(after).toBeGreaterThanOrEqual(before);
    expect(BioTimeConnector.fromDb).toHaveBeenCalled();
  });

  it('Phase 4: attendance generate creates records from local transactions', async () => {
    await prisma.transaction.createMany({
      data: [
        {
          employeeId: employeeProfileId,
          empCode: 'E1001',
          biotimeTransactionId: 99001,
          punchTime: new Date('2026-06-05T08:00:00'),
          punchState: '0',
        },
        {
          employeeId: employeeProfileId,
          empCode: 'E1001',
          biotimeTransactionId: 99002,
          punchTime: new Date('2026-06-05T17:00:00'),
          punchState: '1',
        },
      ],
      skipDuplicates: true,
    });

    const result = await generateAttendance({
      dateFrom: new Date('2026-06-05'),
      dateTo: new Date('2026-06-05'),
      employeeIds: [employeeProfileId],
    });

    expect(result.created + result.updated).toBeGreaterThan(0);

    const res = await rpc('/api/biotime/attendance/list', {
      dateFrom: '2026-06-05',
      dateTo: '2026-06-05',
      employeeId: employeeProfileId,
    }, hrToken);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.data.count).toBeGreaterThan(0);
    const record = res.body.result.data.records.find(
      (r: { employeeId?: string }) => r.employeeId === employeeProfileId,
    ) ?? res.body.result.data.records[0];
    expect(record.workedHours).toBeGreaterThan(0);
  });

  it('Phase 5: punch report uses shift grid off-day flags', async () => {
    const grid = await prisma.shiftGrid.create({
      data: {
        name: 'Test Grid',
        dateFrom: new Date('2026-06-01'),
        dateTo: new Date('2026-06-07'),
      },
    });

    await prisma.shiftGridLine.create({
      data: {
        gridId: grid.id,
        employeeId: employeeProfileId,
        date: new Date('2026-06-03'),
        isOff: true,
        shiftId,
      },
    });

    const lines = await generatePunchReport(
      new Date('2026-06-01'),
      new Date('2026-06-07'),
      [employeeProfileId],
      grid.id,
    );

    const offLine = lines.find((l) => l.punchDate.toISOString().slice(0, 10) === '2026-06-03');
    expect(offLine?.isOffDay).toBe(true);
    expect(offLine?.shiftName).toBe('إجازة');

    const res = await rpc('/api/biotime/punch-report/generate', {
      dateFrom: '2026-06-01',
      dateTo: '2026-06-07',
      shiftGridId: grid.id,
      employeeIds: [employeeProfileId],
    }, hrToken);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.data.count).toBeGreaterThan(0);
  });

  it('Phase 6: employee can create leave request and HR sees it pending', async () => {
    const createRes = await rpc('/api/biotime/requests/leave/create', {
      leaveType: 'annual',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-03',
      reason: 'Vacation',
    }, employeeToken);
    expect(createRes.body.result.success).toBe(true);
    expect(createRes.body.result.data.request.state).toBe('pending');

    const myRes = await rpc('/api/biotime/requests/my', {}, employeeToken);
    expect(myRes.body.result.data.leave.length).toBeGreaterThan(0);

    const pendingRes = await rpc('/api/biotime/requests/pending', {}, hrToken);
    expect(pendingRes.body.result.data.count).toBeGreaterThan(0);

    const requestId = createRes.body.result.data.request.id;
    const approveRes = await rpc('/api/biotime/requests/leave/approve', { id: requestId }, hrToken);
    expect(approveRes.body.result.data.request.state).toBe('approved');
  });

  it('Phase 6: loan request flow', async () => {
    const createRes = await rpc('/api/biotime/requests/loan/create', {
      amount: 5000,
      repaymentMonths: 6,
      reason: 'Emergency',
    }, employeeToken);
    expect(createRes.body.result.success).toBe(true);
    expect(createRes.body.result.data.request.amount).toBe(5000);
  });

  it('dashboard stats includes pendingRequests from local DB', async () => {
    const res = await rpc('/api/biotime/dashboard/stats', {}, hrToken);
    expect(res.body.result.success).toBe(true);
    expect(typeof res.body.result.data.pendingRequests).toBe('number');
  });
});
