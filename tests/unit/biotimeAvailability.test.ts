import { describe, it, expect } from 'vitest';
import { isBioTimeUnavailableError } from '../../src/services/biotime/biotimeAvailability.service';

describe('isBioTimeUnavailableError', () => {
  it('detects Invalid URL and empty config', () => {
    expect(isBioTimeUnavailableError(new Error('Invalid URL'))).toBe(true);
    expect(isBioTimeUnavailableError(new Error('BioTime server URL is not configured'))).toBe(true);
    expect(isBioTimeUnavailableError(new Error('connect ECONNREFUSED 127.0.0.1:8090'))).toBe(true);
    expect(isBioTimeUnavailableError(new Error('some business validation'))).toBe(false);
  });
});
