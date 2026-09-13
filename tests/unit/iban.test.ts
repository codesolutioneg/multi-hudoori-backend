import { describe, it, expect } from 'vitest';
import {
  formatEgyptianIbanDisplay,
  normalizeEgyptianIban,
  validateEgyptianIban,
} from '../../src/utils/iban';

const VALID = `EG${'1'.repeat(27)}`;

describe('normalizeEgyptianIban', () => {
  it('strips whitespace and upper-cases', () => {
    expect(normalizeEgyptianIban(' eg12 3456 ')).toBe('EG123456');
  });

  it('maps null and undefined to an empty string', () => {
    expect(normalizeEgyptianIban(null)).toBe('');
    expect(normalizeEgyptianIban(undefined)).toBe('');
  });
});

describe('validateEgyptianIban', () => {
  it('accepts EG followed by 27 digits', () => {
    expect(validateEgyptianIban(VALID)).toEqual({ valid: true, normalized: VALID });
  });

  it('accepts a space-formatted IBAN and returns it normalized', () => {
    const spaced = VALID.replace(/(.{4})/g, '$1 ');
    expect(validateEgyptianIban(spaced)).toEqual({ valid: true, normalized: VALID });
  });

  it('treats a blank value as valid-and-absent when not required', () => {
    expect(validateEgyptianIban('')).toEqual({ valid: true, normalized: null });
  });

  it('rejects a blank value when required', () => {
    const res = validateEgyptianIban('', true);
    expect(res.valid).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('rejects the wrong length', () => {
    expect(validateEgyptianIban(`EG${'1'.repeat(26)}`).valid).toBe(false);
    expect(validateEgyptianIban(`EG${'1'.repeat(28)}`).valid).toBe(false);
  });

  it('rejects a non-EG country prefix', () => {
    expect(validateEgyptianIban(`SA${'1'.repeat(27)}`).valid).toBe(false);
  });

  it('rejects letters in the digit section', () => {
    expect(validateEgyptianIban(`EG${'1'.repeat(26)}A`).valid).toBe(false);
  });
});

describe('formatEgyptianIbanDisplay', () => {
  it('groups the IBAN into blocks of four', () => {
    expect(formatEgyptianIbanDisplay(VALID)).toBe('EG11 1111 1111 1111 1111 1111 1111 1');
  });

  it('returns an empty string for empty input', () => {
    expect(formatEgyptianIbanDisplay(null)).toBe('');
    expect(formatEgyptianIbanDisplay('')).toBe('');
  });
});
