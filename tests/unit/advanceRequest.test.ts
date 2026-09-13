import { describe, it, expect } from 'vitest';
import { AdvanceRequestState } from '@prisma/client';
import {
  advanceRequestJson,
  initialRequestState,
  isPendingRequestState,
} from '../../src/services/advanceRequest.service';
import { deriveSiteHead } from '../../src/services/branchManager.service';

describe('advance request state machine', () => {
  it('treats both waiting states as pending and nothing else', () => {
    expect(isPendingRequestState(AdvanceRequestState.pending_branch)).toBe(true);
    expect(isPendingRequestState(AdvanceRequestState.pending_hr)).toBe(true);
    expect(isPendingRequestState(AdvanceRequestState.approved)).toBe(false);
    expect(isPendingRequestState(AdvanceRequestState.rejected)).toBe(false);
    expect(isPendingRequestState(AdvanceRequestState.cancelled)).toBe(false);
  });

  it('sends an employee filing for themselves to their branch manager first', () => {
    expect(
      initialRequestState({
        onBehalf: false,
        actorIsBranchManager: false,
        actorIsHrStaff: false,
      }),
    ).toBe(AdvanceRequestState.pending_branch);
    // HR asking for their own advance is still vouched for by their branch.
    expect(
      initialRequestState({
        onBehalf: false,
        actorIsBranchManager: false,
        actorIsHrStaff: true,
      }),
    ).toBe(AdvanceRequestState.pending_branch);
  });

  it('skips the branch step when the person who runs the branch files it', () => {
    expect(
      initialRequestState({
        onBehalf: true,
        actorIsBranchManager: true,
        actorIsHrStaff: false,
      }),
    ).toBe(AdvanceRequestState.pending_hr);
    expect(
      initialRequestState({
        onBehalf: true,
        actorIsBranchManager: false,
        actorIsHrStaff: true,
      }),
    ).toBe(AdvanceRequestState.pending_hr);
  });

  it('sends a branch manager own request straight to HR, since nobody else can clear it', () => {
    // They are the only person who could approve at the branch step, and no one
    // may approve themselves — the branch step would be a dead end.
    expect(
      initialRequestState({
        onBehalf: false,
        actorIsBranchManager: true,
        actorIsHrStaff: false,
      }),
    ).toBe(AdvanceRequestState.pending_hr);
  });

  it('keeps the branch step for anyone with no authority over the employee', () => {
    expect(
      initialRequestState({
        onBehalf: true,
        actorIsBranchManager: false,
        actorIsHrStaff: false,
      }),
    ).toBe(AdvanceRequestState.pending_branch);
  });
});

describe('advanceRequestJson', () => {
  const base = {
    id: 'req_1',
    employeeId: 'emp_1',
    requestedById: 'usr_1',
    locationId: 'loc_1',
    amount: 1234.567,
    reason: 'ظروف عائلية',
    state: AdvanceRequestState.pending_hr,
    eligibilityPercent: 25,
    maxEligibleAtRequest: 2500,
    availableAtRequest: 2000,
    actualWorkingDaysAtRequest: 22,
    branchApprovedById: 'usr_bm',
    branchApprovedAt: new Date('2026-09-01T10:00:00.000Z'),
    hrApprovedById: null,
    hrApprovedAt: null,
    rejectedById: null,
    rejectionReason: null,
    limitOverride: false,
    overrideReason: null,
    advanceShortId: null,
    createdAt: new Date('2026-09-01T09:00:00.000Z'),
    updatedAt: new Date('2026-09-01T10:00:00.000Z'),
  };

  it('rounds the amount and flattens the employee and location', () => {
    const json = advanceRequestJson({
      ...base,
      employee: { id: 'emp_1', name: 'أحمد', code: 'E100', locationId: 'loc_1' },
      location: { id: 'loc_1', name: 'فرع المعادي' },
    });
    expect(json.amount).toBe(1234.57);
    expect(json.employeeName).toBe('أحمد');
    expect(json.employeeCode).toBe('E100');
    expect(json.locationName).toBe('فرع المعادي');
    expect(json.branchApprovedAt).toBe('2026-09-01T10:00:00.000Z');
    expect(json.hrApprovedAt).toBeNull();
  });

  it('survives a request whose employee or location was not joined in', () => {
    const json = advanceRequestJson(base);
    expect(json.employeeName).toBeNull();
    expect(json.locationName).toBeNull();
    expect(json.state).toBe('pending_hr');
  });
});

describe('deriveSiteHead', () => {
  const emp = (id: string, name = id) => ({
    id,
    name,
    userId: null,
    jobTitle: null,
    locationId: 'loc',
    departmentId: null,
    managerId: null,
  });

  it('picks the one person nobody reports through', () => {
    const staff = [emp('boss'), emp('a'), emp('b')];
    const parents = new Map<string, string | null>([
      ['boss', null],
      ['a', 'boss'],
      ['b', 'boss'],
    ]);
    expect(deriveSiteHead(staff, parents)?.id).toBe('boss');
  });

  it('refuses to guess when a site has two heads', () => {
    const staff = [emp('one'), emp('two'), emp('c')];
    const parents = new Map<string, string | null>([
      ['one', null],
      ['two', null],
      ['c', 'one'],
    ]);
    expect(deriveSiteHead(staff, parents)).toBeNull();
  });

  it('returns nobody for a flat site, like drivers with no lead', () => {
    const staff = [emp('d1'), emp('d2'), emp('d3')];
    const parents = new Map<string, string | null>([
      ['d1', null],
      ['d2', null],
      ['d3', null],
    ]);
    expect(deriveSiteHead(staff, parents)).toBeNull();
  });

  it('treats a missing entry as no parent, so a lone employee heads their site', () => {
    const staff = [emp('solo')];
    expect(deriveSiteHead(staff, new Map())?.id).toBe('solo');
  });
});
