import { describe, expect, it } from 'vitest';
import { normalizeLoginInput, validateLoginCredentials } from '../../src/utils/loginValidation';

describe('loginValidation', () => {
  it('normalizes email to lowercase', () => {
    expect(normalizeLoginInput('  User@Example.COM ')).toBe('user@example.com');
  });

  it('rejects empty login', () => {
    const result = validateLoginCredentials('', 'secret12');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('LOGIN_REQUIRED');
  });

  it('rejects invalid email format', () => {
    const result = validateLoginCredentials('not-an-email@', 'secret12');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_EMAIL');
  });

  it('rejects short password', () => {
    const result = validateLoginCredentials('user@test.local', '123');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PASSWORD_TOO_SHORT');
  });

  it('accepts valid credentials', () => {
    const result = validateLoginCredentials('  User@Test.Local ', 'secret12');
    expect(result).toEqual({ ok: true, login: 'user@test.local', password: 'secret12' });
  });
});
