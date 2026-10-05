import { describe, it, expect } from 'vitest';
import {
  EMPLOYEE_QUOTA_EXCEEDED,
  QuotaExceededError,
  USER_QUOTA_EXCEEDED,
  isQuotaError,
  quotaErrorFromDb,
  roleTakesSeat,
} from '../../src/services/licenseQuota.service';

describe('licenseQuota helpers', () => {
  it('maps the employee trigger RAISE to a QuotaExceededError', () => {
    const err = quotaErrorFromDb(
      new Error('Raw query failed. Code: `P0001`. Message: `EMPLOYEE_QUOTA_EXCEEDED:10:10`'),
    );
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err?.errorCode).toBe(EMPLOYEE_QUOTA_EXCEEDED);
    expect(err?.used).toBe(10);
    expect(err?.max).toBe(10);
    expect(err?.statusCode).toBe(400);
  });

  it('maps the user trigger RAISE', () => {
    const err = quotaErrorFromDb(new Error('USER_QUOTA_EXCEEDED:3:2'));
    expect(err?.errorCode).toBe(USER_QUOTA_EXCEEDED);
    expect(err?.kind).toBe('users');
    expect(err?.remaining).toBe(0);
  });

  it('ignores unrelated errors', () => {
    expect(quotaErrorFromDb(new Error('unique constraint failed'))).toBeNull();
    expect(isQuotaError('boom')).toBe(false);
    expect(isQuotaError(new QuotaExceededError('employees', 5, 5))).toBe(true);
  });

  it('only dashboard roles take a user seat', () => {
    expect(roleTakesSeat('EMPLOYEE')).toBe(false);
    expect(roleTakesSeat('PLATFORM_ADMIN')).toBe(false);
    expect(roleTakesSeat('HR_MANAGER')).toBe(true);
    expect(roleTakesSeat('BRANCH_MANAGER')).toBe(true);
  });
});
