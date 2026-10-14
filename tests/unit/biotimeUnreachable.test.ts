import { describe, it, expect } from 'vitest';
import { isBioTimeUnreachable } from '../../src/services/biotime/sync.service';

describe('isBioTimeUnreachable', () => {
  it('treats TCP / DNS failures as unreachable', () => {
    expect(isBioTimeUnreachable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isBioTimeUnreachable({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isBioTimeUnreachable({ code: 'ENOTFOUND' })).toBe(true);
    expect(isBioTimeUnreachable({ code: 'EHOSTUNREACH' })).toBe(true);
  });

  it('treats axios auth timeouts as unreachable', () => {
    expect(isBioTimeUnreachable({ code: 'ECONNABORTED' })).toBe(true);
    expect(
      isBioTimeUnreachable({ message: 'timeout of 30000ms exceeded' }),
    ).toBe(true);
  });

  it('does not treat unrelated errors as unreachable', () => {
    expect(isBioTimeUnreachable({ code: 'ERR_BAD_RESPONSE' })).toBe(false);
    expect(isBioTimeUnreachable({ message: '401 Unauthorized' })).toBe(false);
  });
});
