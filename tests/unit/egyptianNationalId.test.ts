import { describe, expect, it } from 'vitest';
import { parseEgyptianNationalId, validateEgyptianNationalId } from '../../src/utils/egyptianNationalId';

describe('egyptianNationalId', () => {
  it('accepts empty', () => {
    expect(validateEgyptianNationalId('')).toBeNull();
  });

  it('rejects wrong length', () => {
    expect(validateEgyptianNationalId('123')).toMatch(/14/);
  });

  it('parses 1900s birth date', () => {
    const r = parseEgyptianNationalId('29801011234567');
    expect(r.valid).toBe(true);
    expect(r.birthDate?.getFullYear()).toBe(1998);
    expect(r.birthDate?.getMonth()).toBe(0);
    expect(r.birthDate?.getDate()).toBe(1);
    expect(r.age).toBeGreaterThan(20);
  });

  it('parses 2000s birth date', () => {
    const r = parseEgyptianNationalId('30506151234567');
    expect(r.valid).toBe(true);
    expect(r.birthDate?.getFullYear()).toBe(2005);
    expect(r.birthDate?.getMonth()).toBe(5);
    expect(r.birthDate?.getDate()).toBe(15);
  });

  it('rejects invalid calendar date', () => {
    expect(validateEgyptianNationalId('29802321234567')).not.toBeNull();
  });
});
