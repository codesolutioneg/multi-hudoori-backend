import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { AdvanceRequestState, AdvanceState, UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createUser,
  ensureBioTimeConfig,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';

/**
 * «طلب سلفة» end to end: an employee asks, their branch manager confirms, and
 * HR grants — at which point (and only then) an AdvanceShort exists for payroll.
 */
describe('advance requests', () => {
  let hrManager: SeededUser;
  let hrUser: SeededUser;
  let branchManager: SeededUser;
  let otherBranchManager: SeededUser;
  let employee: SeededUser;
  let branchA: { id: string };
  let branchB: { id: string };

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    // Working-days gate off so specs exercise the request flow, not the punch
    // report; the amount limit itself stays enforced.
    await prisma.bioTimeConfig.updateMany({
      data: {
        advanceEnforceLimit: true,
        advanceMinimumWorkingDays: 0,
        advanceDefaultPercent: 25,
      },
    });

    branchA = await createLocation({ name: 'Branch A', code: 'BR-A' });
    branchB = await createLocation({ name: 'Branch B', code: 'BR-B' });

    hrManager = await createUser({ login: 'hrm@test.local', role: UserRole.HR_MANAGER });
    hrUser = await createUser({ login: 'hru@test.local', role: UserRole.HR_USER });
    branchManager = await createUser({
      login: 'bm-a@test.local',
      role: UserRole.BRANCH_MANAGER,
      locationId: branchA.id,
      employee: { code: 'M-A1', name: 'مدير الفرع أ', basicSalary: 20000, locationId: branchA.id },
    });
    otherBranchManager = await createUser({
      login: 'bm-b@test.local',
      role: UserRole.BRANCH_MANAGER,
      locationId: branchB.id,
      employee: { code: 'M-B1', name: 'مدير الفرع ب', basicSalary: 20000, locationId: branchB.id },
    });
    employee = await createUser({
      login: 'emp-a@test.local',
      role: UserRole.EMPLOYEE,
      locationId: branchA.id,
      employee: { code: 'E-A1', name: 'موظف الفرع أ', basicSalary: 10000, locationId: branchA.id },
    });

    // Name the branch head outright. Without it the site head is derived, and a
    // two-person branch would make the requester their own approver.
    await prisma.location.update({
      where: { id: branchA.id },
      data: { managerEmployeeId: branchManager.employeeId },
    });
    await prisma.location.update({
      where: { id: branchB.id },
      data: { managerEmployeeId: otherBranchManager.employeeId },
    });
  });

  async function submitOwn(amount = 1000, reason = 'ظروف عائلية') {
    const data = expectOk(
      await rpc('/api/biotime/advance-requests/create', { amount, reason }, employee.token),
    );
    return data as Record<string, unknown>;
  }

  describe('eligibility', () => {
    it('gives the employee their own entitlement', async () => {
      const data = expectOk(
        await rpc('/api/biotime/advance-requests/eligibility', {}, employee.token),
      );
      expect(data.employeeId).toBe(employee.employeeId);
      expect(data.basicSalary).toBe(10000);
      expect(data.maxEligibleAmount).toBe(2500);
      expect(data.availableAmount).toBe(2500);
    });

    it('ignores an employeeId an employee tries to peek at', async () => {
      const other = await prisma.employeeProfile.create({
        data: { name: 'Someone Else', code: 'E-X', basicSalary: 50000, locationId: branchA.id },
      });
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/eligibility',
          { employeeId: other.id },
          employee.token,
        ),
      );
      expect(data.employeeId).toBe(employee.employeeId);
      expect(data.basicSalary).toBe(10000);
    });

    it('lets HR look up any employee', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/eligibility',
          { employeeId: employee.employeeId },
          hrManager.token,
        ),
      );
      expect(data.employeeId).toBe(employee.employeeId);
    });

    it('reserves a pending request against what is still available', async () => {
      await submitOwn(1000);
      const data = expectOk(
        await rpc('/api/biotime/advance-requests/eligibility', {}, employee.token),
      );
      expect(data.pendingRequestTotal).toBe(1000);
      expect(data.availableAmount).toBe(1500);
    });

    it('excludes a named request so an approver sees what it would leave', async () => {
      const created = await submitOwn(1000);
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/eligibility',
          { employeeId: employee.employeeId, excludeRequestId: created.id },
          hrManager.token,
        ),
      );
      expect(data.pendingRequestTotal).toBe(0);
      expect(data.availableAmount).toBe(2500);
    });

    it('counts an existing pending advance against the entitlement', async () => {
      await prisma.advanceShort.create({
        data: {
          employeeId: employee.employeeId!,
          amount: 2000,
          state: AdvanceState.pending,
          date: new Date(),
          deductionStartDate: new Date(),
        },
      });
      const data = expectOk(
        await rpc('/api/biotime/advance-requests/eligibility', {}, employee.token),
      );
      expect(data.pendingShortTotal).toBe(2000);
      expect(data.availableAmount).toBe(500);
    });
  });

  describe('creating a request', () => {
    it('starts an employee request at the branch step', async () => {
      const request = await submitOwn(1200);
      expect(request.state).toBe('pending_branch');
      expect(request.amount).toBe(1200);
      expect(request.locationId).toBe(branchA.id);
      // Entitlement is frozen on the row for later review.
      expect(request.maxEligibleAtRequest).toBe(2500);
      expect(request.availableAtRequest).toBe(2500);
      // Nothing hits payroll until HR approves.
      expect(await prisma.advanceShort.count()).toBe(0);
    });

    it('rejects an amount above the entitlement', async () => {
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 5000, reason: 'كتير' },
          employee.token,
        ),
        'LIMIT_EXCEEDED',
      );
    });

    it('rejects a second request that would overdraw the entitlement', async () => {
      await submitOwn(2000);
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 1000, reason: 'تاني' },
          employee.token,
        ),
        'LIMIT_EXCEEDED',
      );
    });

    it('requires an amount and a reason', async () => {
      expectFail(
        await rpc('/api/biotime/advance-requests/create', { amount: 0, reason: 'x' }, employee.token),
        'VALIDATION_ERROR',
      );
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 500, reason: '   ' },
          employee.token,
        ),
        'VALIDATION_ERROR',
      );
    });

    it('refuses a request for someone no longer on the payroll', async () => {
      await prisma.employeeProfile.update({
        where: { id: employee.employeeId! },
        data: { active: false },
      });
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 500, reason: 'بعد الاستقالة' },
          employee.token,
        ),
        'ACTION_ERROR',
      );
    });

    it('refuses when the caller has no employee profile', async () => {
      const orphan = await createUser({ login: 'orphan@test.local', role: UserRole.HR_USER });
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 500, reason: 'لا يوجد ملف' },
          orphan.token,
        ),
        'ACCESS_DENIED',
      );
    });

    it('blocks the working-days gate when the limit is enforced', async () => {
      await prisma.bioTimeConfig.updateMany({ data: { advanceMinimumWorkingDays: 15 } });
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 500, reason: 'قبل ما اشتغل' },
          employee.token,
        ),
        'NOT_ELIGIBLE',
      );
    });
  });

  describe('filing on behalf of an employee', () => {
    it('lets the branch manager file for their own staff, skipping the branch step', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/create',
          { employeeId: employee.employeeId, amount: 800, reason: 'الموظف مش بيستخدم التطبيق' },
          branchManager.token,
        ),
      );
      expect(data.state).toBe('pending_hr');
      expect(data.branchApprovedById).toBe(branchManager.userId);
      expect(data.branchApprovedAt).not.toBeNull();
    });

    it('stops a branch manager filing for another branch', async () => {
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/create',
          { employeeId: employee.employeeId, amount: 800, reason: 'فرع تاني' },
          otherBranchManager.token,
        ),
        'ACCESS_DENIED',
      );
    });

    it('lets HR file for anyone, straight into the HR queue', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/create',
          { employeeId: employee.employeeId, amount: 800, reason: 'بطلب من الإدارة' },
          hrUser.token,
        ),
      );
      expect(data.state).toBe('pending_hr');
      // HR did not stand in for the branch manager, so that field stays empty.
      expect(data.branchApprovedById).toBeNull();
    });

    it('stops a plain employee filing for a colleague', async () => {
      const colleague = await prisma.employeeProfile.create({
        data: { name: 'زميل', code: 'E-A2', basicSalary: 8000, locationId: branchA.id },
      });
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/create',
          { employeeId: colleague.id, amount: 500, reason: 'نيابة' },
          employee.token,
        ),
        'ACCESS_DENIED',
      );
    });
  });

  describe('the branch step', () => {
    it('moves the request into the HR queue', async () => {
      const created = await submitOwn();
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
      );
      expect(data.state).toBe('pending_hr');
      expect(data.branchApprovedById).toBe(branchManager.userId);
      expect(await prisma.advanceShort.count()).toBe(0);
    });

    it('refuses a manager from another branch', async () => {
      const created = await submitOwn();
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          otherBranchManager.token,
        ),
        'ACCESS_DENIED',
      );
    });

    it('refuses the employee approving their own request', async () => {
      const created = await submitOwn();
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          employee.token,
        ),
        'ACCESS_DENIED',
      );
    });

    it('cannot be repeated once the request has moved on', async () => {
      const created = await submitOwn();
      expectOk(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
      );
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
        'ACTION_ERROR',
      );
    });
  });

  describe('HR approval', () => {
    async function readyForHr(amount = 1000) {
      const created = await submitOwn(amount);
      expectOk(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
      );
      return created;
    }

    it('creates the advance payroll will deduct', async () => {
      const created = await readyForHr(1000);
      const data = expectOk(
        await rpc('/api/biotime/advance-requests/approve', { id: created.id }, hrManager.token),
      );
      expect(data.state).toBe('approved');
      expect(data.hrApprovedById).toBe(hrManager.userId);
      expect(data.advanceShortId).toBeTruthy();

      const advance = await prisma.advanceShort.findUniqueOrThrow({
        where: { id: String(data.advanceShortId) },
      });
      expect(advance.employeeId).toBe(employee.employeeId);
      expect(advance.amount).toBe(1000);
      expect(advance.state).toBe(AdvanceState.pending);
    });

    it('lets HR trim the amount before granting', async () => {
      const created = await readyForHr(2000);
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/approve',
          { id: created.id, amount: 750 },
          hrManager.token,
        ),
      );
      expect(data.amount).toBe(750);
      const advance = await prisma.advanceShort.findUniqueOrThrow({
        where: { id: String(data.advanceShortId) },
      });
      expect(advance.amount).toBe(750);
    });

    it('does not let the request block its own approval', async () => {
      // The full entitlement was reserved by this very request; approving it
      // must not read that reservation as money already spent.
      const created = await readyForHr(2500);
      const data = expectOk(
        await rpc('/api/biotime/advance-requests/approve', { id: created.id }, hrManager.token),
      );
      expect(data.state).toBe('approved');
      expect(data.amount).toBe(2500);
    });

    it('refuses to exceed the entitlement without an override', async () => {
      const created = await readyForHr(1000);
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/approve',
          { id: created.id, amount: 4000 },
          hrManager.token,
        ),
        'LIMIT_EXCEEDED',
      );
      expect(await prisma.advanceShort.count()).toBe(0);
      const row = await prisma.advanceRequest.findUniqueOrThrow({ where: { id: String(created.id) } });
      expect(row.state).toBe(AdvanceRequestState.pending_hr);
    });

    it('demands a written reason for an override', async () => {
      const created = await readyForHr(1000);
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/approve',
          { id: created.id, amount: 4000, limitOverride: true },
          hrManager.token,
        ),
        'OVERRIDE_REASON_REQUIRED',
      );
    });

    it('grants above the entitlement when the reason is given', async () => {
      const created = await readyForHr(1000);
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/approve',
          {
            id: created.id,
            amount: 4000,
            limitOverride: true,
            overrideReason: 'موافقة المدير المالي',
          },
          hrManager.token,
        ),
      );
      expect(data.amount).toBe(4000);
      expect(data.limitOverride).toBe(true);
      expect(data.overrideReason).toBe('موافقة المدير المالي');
      const advance = await prisma.advanceShort.findUniqueOrThrow({
        where: { id: String(data.advanceShortId) },
      });
      expect(advance.limitOverride).toBe(true);
    });

    it('refuses a request the branch has not cleared yet', async () => {
      const created = await submitOwn();
      expectFail(
        await rpc('/api/biotime/advance-requests/approve', { id: created.id }, hrManager.token),
        'ACTION_ERROR',
      );
    });

    it('refuses an HR user who is not a manager', async () => {
      const created = await readyForHr();
      expectFail(
        await rpc('/api/biotime/advance-requests/approve', { id: created.id }, hrUser.token),
        'ACCESS_DENIED',
      );
    });

    it('refuses a branch manager', async () => {
      const created = await readyForHr();
      expectFail(
        await rpc('/api/biotime/advance-requests/approve', { id: created.id }, branchManager.token),
        'ACCESS_DENIED',
      );
    });

    it('cannot approve the same request twice', async () => {
      const created = await readyForHr(500);
      expectOk(
        await rpc('/api/biotime/advance-requests/approve', { id: created.id }, hrManager.token),
      );
      expectFail(
        await rpc('/api/biotime/advance-requests/approve', { id: created.id }, hrManager.token),
        'ACTION_ERROR',
      );
      expect(await prisma.advanceShort.count()).toBe(1);
    });

    it('reports a request that no longer exists', async () => {
      expectFail(
        await rpc('/api/biotime/advance-requests/approve', { id: 'nope' }, hrManager.token),
        'NOT_FOUND',
      );
    });
  });

  describe('rejection and withdrawal', () => {
    it('lets the branch manager reject with a reason', async () => {
      const created = await submitOwn();
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/reject',
          { id: created.id, reason: 'الموظف عليه سلفة قائمة' },
          branchManager.token,
        ),
      );
      expect(data.state).toBe('rejected');
      expect(data.rejectionReason).toBe('الموظف عليه سلفة قائمة');
      expect(await prisma.advanceShort.count()).toBe(0);
    });

    it('demands a reason', async () => {
      const created = await submitOwn();
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/reject',
          { id: created.id, reason: '  ' },
          branchManager.token,
        ),
        'VALIDATION_ERROR',
      );
    });

    it('stops the branch manager once the request reached HR', async () => {
      const created = await submitOwn();
      expectOk(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
      );
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/reject',
          { id: created.id, reason: 'غيرت رأيي' },
          branchManager.token,
        ),
        'ACCESS_DENIED',
      );
    });

    it('lets HR reject at the HR step', async () => {
      const created = await submitOwn();
      expectOk(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
      );
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/reject',
          { id: created.id, reason: 'خارج السياسة' },
          hrManager.token,
        ),
      );
      expect(data.state).toBe('rejected');
    });

    it('frees the reservation once a request is rejected', async () => {
      const created = await submitOwn(2500);
      expectOk(
        await rpc(
          '/api/biotime/advance-requests/reject',
          { id: created.id, reason: 'مرفوض' },
          branchManager.token,
        ),
      );
      const data = expectOk(
        await rpc('/api/biotime/advance-requests/eligibility', {}, employee.token),
      );
      expect(data.pendingRequestTotal).toBe(0);
      expect(data.availableAmount).toBe(2500);
    });

    it('lets the employee withdraw their own pending request', async () => {
      const created = await submitOwn();
      const data = expectOk(
        await rpc('/api/biotime/advance-requests/cancel', { id: created.id }, employee.token),
      );
      expect(data.state).toBe('cancelled');
    });

    it('stops one employee withdrawing another employee request', async () => {
      const created = await submitOwn();
      const intruder = await createUser({
        login: 'emp-b@test.local',
        role: UserRole.EMPLOYEE,
        locationId: branchB.id,
        employee: { code: 'E-B1', basicSalary: 5000, locationId: branchB.id },
      });
      expectFail(
        await rpc('/api/biotime/advance-requests/cancel', { id: created.id }, intruder.token),
        'ACCESS_DENIED',
      );
    });

    it('cannot withdraw an approved request', async () => {
      const created = await submitOwn(500);
      expectOk(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
      );
      expectOk(
        await rpc('/api/biotime/advance-requests/approve', { id: created.id }, hrManager.token),
      );
      expectFail(
        await rpc('/api/biotime/advance-requests/cancel', { id: created.id }, employee.token),
        'ACTION_ERROR',
      );
    });
  });

  describe('the queue', () => {
    it('shows a branch manager only their own branch', async () => {
      await submitOwn();
      const branchBEmployee = await createUser({
        login: 'emp-b2@test.local',
        role: UserRole.EMPLOYEE,
        locationId: branchB.id,
        employee: { code: 'E-B2', basicSalary: 9000, locationId: branchB.id },
      });
      expectOk(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 500, reason: 'فرع ب' },
          branchBEmployee.token,
        ),
      );

      const mine = expectOk(
        await rpc('/api/biotime/advance-requests/list', {}, branchManager.token),
      );
      const rows = mine.requests as { locationId: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].locationId).toBe(branchA.id);

      const all = expectOk(await rpc('/api/biotime/advance-requests/list', {}, hrManager.token));
      expect((all.requests as unknown[]).length).toBe(2);
    });

    it('defaults to pending rows and can be widened to everything', async () => {
      const created = await submitOwn(500);
      expectOk(
        await rpc(
          '/api/biotime/advance-requests/reject',
          { id: created.id, reason: 'مرفوض' },
          branchManager.token,
        ),
      );

      const pending = expectOk(
        await rpc('/api/biotime/advance-requests/list', {}, hrManager.token),
      );
      expect(pending.requests).toHaveLength(0);

      const all = expectOk(
        await rpc('/api/biotime/advance-requests/list', { state: 'all' }, hrManager.token),
      );
      expect(all.requests).toHaveLength(1);

      const rejected = expectOk(
        await rpc('/api/biotime/advance-requests/list', { state: 'rejected' }, hrManager.token),
      );
      expect(rejected.requests).toHaveLength(1);
    });

    it('rejects an unknown state filter', async () => {
      expectFail(
        await rpc('/api/biotime/advance-requests/list', { state: 'weird' }, hrManager.token),
        'VALIDATION_ERROR',
      );
    });

    it('lets HR narrow the queue to one branch', async () => {
      await submitOwn();
      const data = expectOk(
        await rpc(
          '/api/biotime/advance-requests/list',
          { locationId: branchB.id },
          hrManager.token,
        ),
      );
      expect(data.requests).toHaveLength(0);
    });

    it('refuses a branch manager with no branch on their account', async () => {
      const floating = await createUser({
        login: 'bm-none@test.local',
        role: UserRole.BRANCH_MANAGER,
      });
      expectFail(
        await rpc('/api/biotime/advance-requests/list', {}, floating.token),
        'ACCESS_DENIED',
      );
    });

    it('keeps the queue out of reach of a plain employee', async () => {
      expectFail(
        await rpc('/api/biotime/advance-requests/list', {}, employee.token),
        'ACCESS_DENIED',
      );
    });

    it('lists the employee own requests newest first', async () => {
      const first = await submitOwn(300, 'الأول');
      const second = await submitOwn(300, 'التاني');
      const data = expectOk(await rpc('/api/biotime/advance-requests/my', {}, employee.token));
      const rows = data.requests as { id: string }[];
      expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
    });
  });

  describe('who counts as the branch manager', () => {
    it('blocks the request when the branch has nobody who can approve', async () => {
      // Golf Car in real data: a pool of employees with no head and no designation.
      const orphanBranch = await createLocation({ name: 'Golf Car', code: 'BR-G' });
      const driver = await createUser({
        login: 'driver@test.local',
        role: UserRole.EMPLOYEE,
        locationId: orphanBranch.id,
        employee: { code: 'E-G1', basicSalary: 6000, locationId: orphanBranch.id },
      });
      // A second employee so neither is trivially the head of the site.
      await prisma.employeeProfile.create({
        data: { name: 'سائق تاني', code: 'E-G2', basicSalary: 6000, locationId: orphanBranch.id },
      });

      expectFail(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 500, reason: 'محتاج' },
          driver.token,
        ),
        'NO_BRANCH_MANAGER',
      );
    });

    it('falls back to the head the org chart derives when none is set', async () => {
      await prisma.location.update({
        where: { id: branchA.id },
        data: { managerEmployeeId: null },
      });
      // Two people at the site: the manager outranks the employee by job title,
      // so derivation makes them the head.
      await prisma.employeeProfile.update({
        where: { id: branchManager.employeeId! },
        data: { jobTitle: 'مدير الفرع' },
      });
      await prisma.employeeProfile.update({
        where: { id: employee.employeeId! },
        data: { jobTitle: 'كاشير' },
      });

      const created = expectOk(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 500, reason: 'من غير تحديد' },
          employee.token,
        ),
      );
      expect(created.state).toBe('pending_branch');
      // The derived head can act on it even though nobody designated them.
      const approved = expectOk(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
      );
      expect(approved.state).toBe('pending_hr');
    });

    it('lets a designated manager with a plain employee account run the queue', async () => {
      const senior = await createUser({
        login: 'senior-a@test.local',
        role: UserRole.EMPLOYEE,
        locationId: branchA.id,
        employee: { code: 'E-A9', name: 'الكابتن', basicSalary: 12000, locationId: branchA.id },
      });
      expectOk(
        await rpc(
          '/api/biotime/branch-managers/set',
          { locationId: branchA.id, employeeId: senior.employeeId },
          hrManager.token,
        ),
      );

      const created = await submitOwn(500);
      const queue = expectOk(
        await rpc('/api/biotime/advance-requests/list', {}, senior.token),
      );
      expect((queue.requests as { id: string }[]).map((r) => r.id)).toContain(created.id);

      const approved = expectOk(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          senior.token,
        ),
      );
      expect(approved.state).toBe('pending_hr');
    });

    it('keeps a user holding the BRANCH_MANAGER role able to act alongside the designation', async () => {
      // Carrying the role is an explicit grant in its own right, so naming someone
      // else adds an approver rather than removing one.
      const senior = await createUser({
        login: 'senior-b@test.local',
        role: UserRole.EMPLOYEE,
        locationId: branchA.id,
        employee: { code: 'E-A7', name: 'كابتن تاني', basicSalary: 12000, locationId: branchA.id },
      });
      expectOk(
        await rpc(
          '/api/biotime/branch-managers/set',
          { locationId: branchA.id, employeeId: senior.employeeId },
          hrManager.token,
        ),
      );
      const created = await submitOwn(300, 'تاني');
      const approved = expectOk(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
      );
      expect(approved.state).toBe('pending_hr');
    });

    it('sends the branch manager own request straight to HR', async () => {
      const created = expectOk(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 1000, reason: 'سلفة المدير' },
          branchManager.token,
        ),
      );
      expect(created.state).toBe('pending_hr');
    });

    it('stops the branch manager clearing a request filed for them by someone else', async () => {
      const created = expectOk(
        await rpc(
          '/api/biotime/advance-requests/create',
          {
            employeeId: branchManager.employeeId,
            amount: 1000,
            reason: 'نيابة عن المدير',
          },
          hrUser.token,
        ),
      );
      // HR put it in the HR queue, so move it back to the branch step to prove the
      // self-approval guard, not the state guard, is what stops them.
      await prisma.advanceRequest.update({
        where: { id: String(created.id) },
        data: { state: AdvanceRequestState.pending_branch, branchApprovedById: null },
      });
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
        'ACCESS_DENIED',
      );
    });
  });

  describe('branch manager settings', () => {
    it('lists every branch with who signs off for it', async () => {
      const data = expectOk(await rpc('/api/biotime/branch-managers/list', {}, hrManager.token));
      const branches = data.branches as {
        locationId: string;
        manager: { employeeId: string; source: string; canApprove: boolean } | null;
      }[];
      const a = branches.find((b) => b.locationId === branchA.id);
      expect(a?.manager?.employeeId).toBe(branchManager.employeeId);
      expect(a?.manager?.source).toBe('explicit');
      expect(a?.manager?.canApprove).toBe(true);
    });

    it('reports a designated manager with no login as unable to approve', async () => {
      const noLogin = await prisma.employeeProfile.create({
        data: { name: 'بدون حساب', code: 'E-A8', basicSalary: 9000, locationId: branchA.id },
      });
      expectOk(
        await rpc(
          '/api/biotime/branch-managers/set',
          { locationId: branchA.id, employeeId: noLogin.id },
          hrManager.token,
        ),
      );
      const data = expectOk(await rpc('/api/biotime/branch-managers/list', {}, hrManager.token));
      const a = (data.branches as { locationId: string; manager: { canApprove: boolean } }[])
        .find((b) => b.locationId === branchA.id);
      expect(a?.manager?.canApprove).toBe(false);

      // And their branch cannot raise requests, since nobody can clear them.
      expectFail(
        await rpc(
          '/api/biotime/advance-requests/create',
          { amount: 500, reason: 'لا يوجد من يوافق' },
          employee.token,
        ),
        'NO_BRANCH_MANAGER',
      );
    });

    it('refuses a manager from another branch', async () => {
      expectFail(
        await rpc(
          '/api/biotime/branch-managers/set',
          { locationId: branchA.id, employeeId: otherBranchManager.employeeId },
          hrManager.token,
        ),
        'VALIDATION_ERROR',
      );
    });

    it('clears the designation and hands the branch back to the org chart', async () => {
      expectOk(
        await rpc(
          '/api/biotime/branch-managers/set',
          { locationId: branchA.id, employeeId: null },
          hrManager.token,
        ),
      );
      const row = await prisma.location.findUniqueOrThrow({ where: { id: branchA.id } });
      expect(row.managerEmployeeId).toBeNull();
    });

    it('lets HR read but only an HR manager write', async () => {
      expectOk(await rpc('/api/biotime/branch-managers/list', {}, hrUser.token));
      const res = await rpc(
        '/api/biotime/branch-managers/set',
        { locationId: branchA.id, employeeId: null },
        hrUser.token,
      );
      expect(res.body.result?.success).not.toBe(true);
    });

    it('audits the designation', async () => {
      expectOk(
        await rpc(
          '/api/biotime/branch-managers/set',
          { locationId: branchA.id, employeeId: employee.employeeId },
          hrManager.token,
        ),
      );
      const log = await prisma.auditLog.findFirst({
        where: { entityType: 'Location', entityId: branchA.id, action: 'branch_manager.set' },
      });
      expect(log).not.toBeNull();
    });
  });

  describe('audit trail', () => {
    it('records every step against the request', async () => {
      const created = await submitOwn(500);
      expectOk(
        await rpc(
          '/api/biotime/advance-requests/branch-approve',
          { id: created.id },
          branchManager.token,
        ),
      );
      expectOk(
        await rpc('/api/biotime/advance-requests/approve', { id: created.id }, hrManager.token),
      );

      const logs = await prisma.auditLog.findMany({
        where: { entityType: 'AdvanceRequest', entityId: String(created.id) },
        orderBy: { createdAt: 'asc' },
      });
      expect(logs.map((l) => l.action)).toEqual([
        'advance_request.create',
        'advance_request.branch_approve',
        'advance_request.approve',
      ]);
    });
  });

  describe('authentication', () => {
    it('refuses an anonymous caller', async () => {
      const res = await rpc('/api/biotime/advance-requests/my', {});
      expect(res.body.result?.success).not.toBe(true);
    });
  });
});
