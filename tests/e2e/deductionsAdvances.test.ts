import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { AdvanceState, DeductionState, PayrollState, UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';

describe('deductions', () => {
  let hr: SeededUser;
  let employeeId: string;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hr = await createUser({ login: 'hr@test.local', role: UserRole.HR_MANAGER });
    const emp = await prisma.employeeProfile.create({
      data: { name: 'Deduction Target', code: 'D100', basicSalary: 3000 },
    });
    employeeId = emp.id;
  });

  it('exposes the supported deduction types', async () => {
    const data = expectOk(await rpc('/api/biotime/deductions/types', {}, hr.token));
    expect(Array.isArray(data.types)).toBe(true);
    expect((data.types as unknown[]).length).toBeGreaterThan(0);
  });

  it('creates a deduction in draft with a generated reference', async () => {
    const data = expectOk(
      await rpc(
        '/api/biotime/deductions/create',
        { employeeId, type: 'fines', amount: 150, date: '2026-06-10', notes: 'late fee' },
        hr.token,
      ),
    );
    const deduction = data.deduction as Record<string, unknown>;
    // the API relabels states for the client: draft → pending, linked → applied
    expect(deduction.state).toBe('pending');
    expect(deduction.amount).toBe(150);
    expect(String(deduction.reference).length).toBeGreaterThan(0);

    const row = await prisma.deduction.findUniqueOrThrow({ where: { id: String(deduction.id) } });
    expect(row.state).toBe(DeductionState.draft);
  });

  it('reports a linked deduction as applied', async () => {
    const created = expectOk(
      await rpc('/api/biotime/deductions/create', { employeeId, type: 'fines', amount: 50 }, hr.token),
    );
    const id = String((created.deduction as { id: string }).id);
    await prisma.deduction.update({ where: { id }, data: { state: DeductionState.linked } });
    const data = expectOk(await rpc('/api/biotime/deductions/list', {}, hr.token));
    const row = (data.deductions as { id: string; state: string }[]).find((d) => d.id === id);
    expect(row?.state).toBe('applied');
  });

  it('gives successive deductions distinct references', async () => {
    const a = expectOk(
      await rpc('/api/biotime/deductions/create', { employeeId, type: 'fines', amount: 10, date: '2026-06-10' }, hr.token),
    );
    const b = expectOk(
      await rpc('/api/biotime/deductions/create', { employeeId, type: 'fines', amount: 20, date: '2026-06-10' }, hr.token),
    );
    expect((a.deduction as { reference: string }).reference).not.toBe(
      (b.deduction as { reference: string }).reference,
    );
  });

  it('rejects an unsupported deduction type', async () => {
    expectFail(
      await rpc('/api/biotime/deductions/create', { employeeId, type: 'not_a_type', amount: 10 }, hr.token),
      'VALIDATION_ERROR',
    );
  });

  it('lists deductions with pagination', async () => {
    for (let i = 0; i < 4; i++) {
      await rpc(
        '/api/biotime/deductions/create',
        { employeeId, type: 'fines', amount: 10 + i, date: '2026-06-10' },
        hr.token,
      );
    }
    const data = expectOk(await rpc('/api/biotime/deductions/list', { limit: 2 }, hr.token));
    expect((data.deductions as unknown[]).length).toBe(2);
  });

  it('cancels a draft deduction', async () => {
    const created = expectOk(
      await rpc('/api/biotime/deductions/create', { employeeId, type: 'fines', amount: 90 }, hr.token),
    );
    const id = (created.deduction as { id: string }).id;
    const data = expectOk(await rpc('/api/biotime/deductions/cancel', { id }, hr.token));
    expect((data.deduction as { state: string }).state).toBe(DeductionState.cancelled);
  });

  it('refuses to cancel a deduction already linked to a payroll', async () => {
    const created = expectOk(
      await rpc('/api/biotime/deductions/create', { employeeId, type: 'fines', amount: 90 }, hr.token),
    );
    const id = (created.deduction as { id: string }).id;
    await prisma.deduction.update({ where: { id }, data: { state: DeductionState.linked } });
    expectFail(await rpc('/api/biotime/deductions/cancel', { id }, hr.token), 'ACTION_ERROR');
  });

  it('fails to cancel an unknown deduction', async () => {
    expectFail(await rpc('/api/biotime/deductions/cancel', { id: 'nope' }, hr.token), 'NOT_FOUND');
  });
});

describe('advances', () => {
  let hr: SeededUser;
  let employeeId: string;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hr = await createUser({ login: 'hr@test.local', role: UserRole.HR_MANAGER });
    const emp = await prisma.employeeProfile.create({
      data: { name: 'Advance Target', code: 'A100', basicSalary: 10000 },
    });
    employeeId = emp.id;
    // Eligibility is gated on worked days; disable the gate for these specs.
    const cfg = await prisma.bioTimeConfig.findFirstOrThrow();
    await prisma.bioTimeConfig.update({
      where: { id: cfg.id },
      data: { advanceEnforceLimit: false, advanceMinimumWorkingDays: 0, advanceDefaultPercent: 25 },
    });
  });

  describe('settings and eligibility', () => {
    it('returns the configured advance settings', async () => {
      const data = expectOk(await rpc('/api/biotime/advances/settings/get', {}, hr.token));
      expect(data.settings ?? data).toBeTruthy();
    });

    it('previews eligibility for an employee', async () => {
      const data = expectOk(
        await rpc('/api/biotime/advances/eligibility/preview', { employeeId }, hr.token),
      );
      const eligibility = (data.eligibility ?? data) as Record<string, unknown>;
      expect(eligibility.employeeId).toBe(employeeId);
      expect(eligibility.basicSalary).toBe(10000);
    });

    it('fails eligibility for an unknown employee', async () => {
      expectFail(
        await rpc('/api/biotime/advances/eligibility/preview', { employeeId: 'nope' }, hr.token),
        'NOT_FOUND',
      );
    });
  });

  describe('short advances', () => {
    it('creates a pending short advance', async () => {
      const data = expectOk(
        await rpc('/api/biotime/advances/short/create', { employeeId, amount: 500, date: '2026-06-10' }, hr.token),
      );
      const advance = data.advance as Record<string, unknown>;
      expect(advance.state).toBe(AdvanceState.pending);
      expect(advance.amount).toBe(500);
    });

    it('rejects a zero or negative amount', async () => {
      expectFail(await rpc('/api/biotime/advances/short/create', { employeeId, amount: 0 }, hr.token));
      expectFail(await rpc('/api/biotime/advances/short/create', { employeeId, amount: -100 }, hr.token));
    });

    it('cancels a pending short advance', async () => {
      const created = expectOk(
        await rpc('/api/biotime/advances/short/create', { employeeId, amount: 500 }, hr.token),
      );
      const id = (created.advance as { id: string }).id;
      const data = expectOk(await rpc('/api/biotime/advances/short/cancel', { id }, hr.token));
      expect((data.advance as { state: string }).state).toBe(AdvanceState.cancelled);
    });

    it('refuses to cancel an advance already tied to a payroll', async () => {
      const created = expectOk(
        await rpc('/api/biotime/advances/short/create', { employeeId, amount: 500 }, hr.token),
      );
      const id = (created.advance as { id: string }).id;
      const payroll = await prisma.payroll.create({
        data: { name: 'P', dateFrom: new Date('2026-06-01'), dateTo: new Date('2026-06-30') },
      });
      await prisma.advanceShort.update({ where: { id }, data: { payrollId: payroll.id } });
      expectFail(await rpc('/api/biotime/advances/short/cancel', { id }, hr.token), 'ACTION_ERROR');
    });

    it('lists short advances', async () => {
      await rpc('/api/biotime/advances/short/create', { employeeId, amount: 500 }, hr.token);
      const data = expectOk(await rpc('/api/biotime/advances/short/list', {}, hr.token));
      expect((data.advances as unknown[]).length).toBe(1);
    });
  });

  describe('long advances', () => {
    async function createLong(amount = 6000, installments = 6) {
      const res = await rpc(
        '/api/biotime/advances/long/create',
        { employeeId, totalAmount: amount, installments },
        hr.token,
      );
      return expectOk(res, 'long/create').advance as Record<string, unknown>;
    }

    it('creates a draft long advance and splits the instalments', async () => {
      const advance = await createLong(6000, 6);
      expect(advance.state).toBe(AdvanceState.draft);
      expect(advance.installmentAmount).toBe(1000);
    });

    it('confirms a draft into running', async () => {
      const advance = await createLong();
      const data = expectOk(
        await rpc('/api/biotime/advances/long/confirm', { id: advance.id }, hr.token),
      );
      const activated = data.advance as {
        state: string;
        odooMoveId: number | null;
        odooSyncError: string;
      };
      expect(activated.state).toBe(AdvanceState.running);
      // Odoo is disabled in the isolated test DB: activation must still succeed
      // and persist the retry reason selected by the product owner.
      expect(activated.odooMoveId).toBeNull();
      expect(activated.odooSyncError).toContain('غير مفعّل');
      expect((data.odooSync as { ok: boolean }).ok).toBe(false);
    });

    it('refuses to confirm twice', async () => {
      const advance = await createLong();
      await rpc('/api/biotime/advances/long/confirm', { id: advance.id }, hr.token);
      expectFail(await rpc('/api/biotime/advances/long/confirm', { id: advance.id }, hr.token), 'ACTION_ERROR');
    });

    it('cancels a long advance with no instalments taken', async () => {
      const advance = await createLong();
      const data = expectOk(await rpc('/api/biotime/advances/long/cancel', { id: advance.id }, hr.token));
      expect((data.advance as { state: string }).state).toBe(AdvanceState.cancelled);
    });

    it('refuses to cancel once an instalment has been deducted', async () => {
      const advance = await createLong();
      const payroll = await prisma.payroll.create({
        data: { name: 'P', dateFrom: new Date('2026-06-01'), dateTo: new Date('2026-06-30') },
      });
      await prisma.advanceLongPayment.create({
        data: {
          advanceId: String(advance.id),
          payrollId: payroll.id,
          amount: 1000,
          paymentDate: new Date('2026-06-30'),
          state: AdvanceState.applied,
        },
      });
      expectFail(await rpc('/api/biotime/advances/long/cancel', { id: advance.id }, hr.token), 'ACTION_ERROR');
    });

    it('locks accounting on a long advance', async () => {
      const advance = await createLong();
      expectOk(await rpc('/api/biotime/advances/long/lock-accounting', { id: advance.id }, hr.token));
      const row = await prisma.advanceLong.findUniqueOrThrow({ where: { id: String(advance.id) } });
      expect(row.isAccountingLocked).toBe(true);
    });

    it('fails for an unknown long advance', async () => {
      expectFail(await rpc('/api/biotime/advances/long/confirm', { id: 'nope' }, hr.token), 'NOT_FOUND');
    });

    it('lists long advances with their payments', async () => {
      await createLong();
      const data = expectOk(await rpc('/api/biotime/advances/long/list', {}, hr.token));
      expect((data.advances as unknown[]).length).toBe(1);
    });

    it('updates a long advance before any confirmed payroll deduction', async () => {
      const advance = await createLong(6000, 6);
      const data = expectOk(
        await rpc(
          '/api/biotime/advances/long/update',
          { id: advance.id, totalAmount: 7200, installments: 8 },
          hr.token,
        ),
      );
      const updated = data.advance as Record<string, unknown>;
      expect(updated.totalAmount).toBe(7200);
      expect(updated.installments).toBe(8);
      expect(updated.installmentAmount).toBe(900);
      expect(updated.canEdit).toBe(true);
    });

    it('refuses to update a long advance after a confirmed payroll deduction', async () => {
      const advance = await createLong();
      await rpc('/api/biotime/advances/long/confirm', { id: advance.id }, hr.token);
      const payroll = await prisma.payroll.create({
        data: {
          name: 'P-conf',
          dateFrom: new Date('2026-06-01'),
          dateTo: new Date('2026-06-30'),
          state: PayrollState.confirmed,
        },
      });
      await prisma.advanceLongPayment.create({
        data: {
          advanceId: String(advance.id),
          payrollId: payroll.id,
          amount: 1000,
          paymentDate: new Date('2026-06-30'),
          state: AdvanceState.applied,
        },
      });
      expectFail(
        await rpc(
          '/api/biotime/advances/long/update',
          { id: advance.id, totalAmount: 5000 },
          hr.token,
        ),
        'ACTION_ERROR',
      );
    });

    it('stops a running long advance so further payroll draws end', async () => {
      const advance = await createLong();
      await rpc('/api/biotime/advances/long/confirm', { id: advance.id }, hr.token);
      const payroll = await prisma.payroll.create({
        data: {
          name: 'P-stop',
          dateFrom: new Date('2026-06-01'),
          dateTo: new Date('2026-06-30'),
          state: PayrollState.confirmed,
        },
      });
      await prisma.advanceLongPayment.create({
        data: {
          advanceId: String(advance.id),
          payrollId: payroll.id,
          amount: 1000,
          paymentDate: new Date('2026-06-30'),
          state: AdvanceState.applied,
        },
      });

      const data = expectOk(
        await rpc('/api/biotime/advances/long/stop', { id: advance.id }, hr.token),
      );
      const stopped = data.advance as Record<string, unknown>;
      expect(stopped.state).toBe(AdvanceState.stopped);
      expect(stopped.canStop).toBe(false);
      expect(stopped.paidAmount).toBe(1000);
      expect(stopped.remainingAmount).toBe(5000);

      // A later payroll must not draw another instalment.
      const emp = await prisma.employeeProfile.findFirstOrThrow({
        where: { id: String((await prisma.advanceLong.findUniqueOrThrow({ where: { id: String(advance.id) } })).employeeId) },
      });
      const later = await prisma.payroll.create({
        data: {
          name: 'P-next',
          dateFrom: new Date('2026-07-01'),
          dateTo: new Date('2026-07-31'),
          state: PayrollState.draft,
        },
      });
      const line = await prisma.payrollLine.create({
        data: {
          payrollId: later.id,
          employeeId: emp.id,
          basicSalary: 5000,
        },
      });
      const { applyLongAdvancesForLine } = await import('../../src/services/advances.service');
      const drawn = await applyLongAdvancesForLine(later as never, line as never);
      expect(drawn).toBe(0);
      const payments = await prisma.advanceLongPayment.count({
        where: { advanceId: String(advance.id) },
      });
      expect(payments).toBe(1);
    });

    it('refuses to stop a draft long advance', async () => {
      const advance = await createLong();
      expectFail(
        await rpc('/api/biotime/advances/long/stop', { id: advance.id }, hr.token),
        'ACTION_ERROR',
      );
    });

    it('adjusts remaining balance and instalments after a confirmed deduction', async () => {
      const advance = await createLong(6000, 6);
      await rpc('/api/biotime/advances/long/confirm', { id: advance.id }, hr.token);
      const payroll = await prisma.payroll.create({
        data: {
          name: 'P-adj',
          dateFrom: new Date('2026-06-01'),
          dateTo: new Date('2026-06-30'),
          state: PayrollState.confirmed,
        },
      });
      await prisma.advanceLongPayment.create({
        data: {
          advanceId: String(advance.id),
          payrollId: payroll.id,
          amount: 1000,
          paymentDate: new Date('2026-06-30'),
          state: AdvanceState.applied,
        },
      });

      const data = expectOk(
        await rpc(
          '/api/biotime/advances/long/adjust-remaining',
          { id: advance.id, remainingAmount: 4000, remainingInstallments: 2 },
          hr.token,
        ),
      );
      const updated = data.advance as Record<string, unknown>;
      expect(updated.paidAmount).toBe(1000);
      expect(updated.remainingAmount).toBe(4000);
      expect(updated.totalAmount).toBe(5000);
      expect(updated.installments).toBe(3);
      expect(updated.installmentAmount).toBe(2000);
      expect(updated.remainingInstallments).toBe(2);
      expect(updated.canAdjustRemaining).toBe(true);
    });

    it('refuses remaining adjust when nothing has been deducted yet', async () => {
      const advance = await createLong();
      await rpc('/api/biotime/advances/long/confirm', { id: advance.id }, hr.token);
      expectFail(
        await rpc(
          '/api/biotime/advances/long/adjust-remaining',
          { id: advance.id, remainingAmount: 3000, remainingInstallments: 2 },
          hr.token,
        ),
        'ACTION_ERROR',
      );
    });
  });

  describe('eligibility limits', () => {
    beforeEach(async () => {
      const cfg = await prisma.bioTimeConfig.findFirstOrThrow();
      await prisma.bioTimeConfig.update({
        where: { id: cfg.id },
        data: { advanceEnforceLimit: true, advanceMinimumWorkingDays: 15, advanceDefaultPercent: 25 },
      });
    });

    it('refuses an advance for an employee below the worked-days gate', async () => {
      expectFail(
        await rpc('/api/biotime/advances/short/create', { employeeId, amount: 500 }, hr.token),
        'NOT_ELIGIBLE',
      );
    });

    it('allows an override with a stated reason', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/advances/short/create',
          { employeeId, amount: 500, limitOverride: true, overrideReason: 'approved by finance' },
          hr.token,
        ),
      );
      const advance = data.advance as Record<string, unknown>;
      expect(advance.limitOverride).toBe(true);
    });

    it('requires a reason when overriding', async () => {
      expectFail(
        await rpc(
          '/api/biotime/advances/short/create',
          { employeeId, amount: 500, limitOverride: true },
          hr.token,
        ),
        'OVERRIDE_REASON_REQUIRED',
      );
    });
  });
});

describe('employee self-service requests', () => {
  let hr: SeededUser;
  let employee: SeededUser;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    hr = await createUser({ login: 'hr@test.local', role: UserRole.HR_MANAGER });
    employee = await createUser({
      login: 'emp@test.local',
      role: UserRole.EMPLOYEE,
      withEmployeeProfile: true,
    });
  });

  const flows = [
    {
      name: 'leave',
      create: '/api/biotime/requests/leave/create',
      approve: '/api/biotime/requests/leave/approve',
      reject: '/api/biotime/requests/leave/reject',
      params: { leaveType: 'annual', dateFrom: '2026-07-01', dateTo: '2026-07-03', reason: 'holiday' },
    },
    {
      name: 'loan',
      create: '/api/biotime/requests/loan/create',
      approve: '/api/biotime/requests/loan/approve',
      reject: '/api/biotime/requests/loan/reject',
      params: { amount: 5000, repaymentMonths: 6, reason: 'emergency' },
    },
    {
      name: 'salary',
      create: '/api/biotime/requests/salary/create',
      approve: '/api/biotime/requests/salary/approve',
      reject: '/api/biotime/requests/salary/reject',
      params: { amount: 1000, reason: 'raise' },
    },
    {
      name: 'certificate',
      create: '/api/biotime/requests/certificate/create',
      approve: '/api/biotime/requests/certificate/approve',
      reject: '/api/biotime/requests/certificate/reject',
      params: { certificateType: 'salary', reason: 'bank' },
    },
    {
      name: 'attendance-edit',
      create: '/api/biotime/requests/attendance-edit/create',
      approve: '/api/biotime/requests/attendance-edit/approve',
      reject: '/api/biotime/requests/attendance-edit/reject',
      params: { date: '2026-06-10', requestedCheckIn: '08:00', requestedCheckOut: '17:00', reason: 'forgot' },
    },
  ];

  for (const flow of flows) {
    describe(flow.name, () => {
      it('is created pending by the employee', async () => {
        const data = expectOk(await rpc(flow.create, flow.params, employee.token), flow.create);
        expect((data.request as { state: string }).state).toBe('pending');
      });

      it('is approved by HR', async () => {
        const created = expectOk(await rpc(flow.create, flow.params, employee.token));
        const id = (created.request as { id: string }).id;
        const data = expectOk(await rpc(flow.approve, { id }, hr.token), flow.approve);
        expect((data.request as { state: string }).state).toBe('approved');
      });

      it('is rejected with a reason', async () => {
        const created = expectOk(await rpc(flow.create, flow.params, employee.token));
        const id = (created.request as { id: string }).id;
        const data = expectOk(
          await rpc(flow.reject, { id, reason: 'not this month' }, hr.token),
          flow.reject,
        );
        const request = data.request as { state: string; rejectionReason: string };
        expect(request.state).toBe('rejected');
        expect(request.rejectionReason).toBe('not this month');
      });

      it('cannot be approved by the requesting employee', async () => {
        const created = expectOk(await rpc(flow.create, flow.params, employee.token));
        const id = (created.request as { id: string }).id;
        expectFail(await rpc(flow.approve, { id }, employee.token), 'ACCESS_DENIED');
      });
    });
  }

  it('shows the employee their own requests only', async () => {
    const other = await createUser({
      login: 'other@test.local',
      role: UserRole.EMPLOYEE,
      withEmployeeProfile: true,
    });
    await rpc(
      '/api/biotime/requests/leave/create',
      { leaveType: 'annual', dateFrom: '2026-07-01', dateTo: '2026-07-02', reason: 'mine' },
      employee.token,
    );
    const data = expectOk(await rpc('/api/biotime/requests/my', {}, other.token));
    expect((data.leave as unknown[]).length).toBe(0);
  });

  it('counts every pending request type for HR', async () => {
    for (const flow of flows) {
      await rpc(flow.create, flow.params, employee.token);
    }
    const data = expectOk(await rpc('/api/biotime/requests/pending', {}, hr.token));
    expect(data.count).toBe(flows.length);
  });
});
