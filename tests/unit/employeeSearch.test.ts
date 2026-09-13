import { describe, it, expect } from 'vitest';
import { rankEmployeeSearchMatch } from '../../src/services/employeeSearch.service';

function emp(partial: {
  code?: string | null;
  name?: string;
  displayName?: string | null;
  biotimeEmpCode?: string | null;
}) {
  return {
    code: partial.code ?? null,
    name: partial.name ?? '',
    displayName: partial.displayName ?? null,
    identificationId: null,
    mapping: partial.biotimeEmpCode != null ? { biotimeEmpCode: partial.biotimeEmpCode } : null,
  } as never;
}

describe('rankEmployeeSearchMatch', () => {
  it('ranks exact code above substring codes', () => {
    const exact = emp({ code: '22', name: 'اسماعيل' });
    const partial = emp({ code: '2229', name: '2229' });
    expect(rankEmployeeSearchMatch(exact, '22')).toBeGreaterThan(
      rankEmployeeSearchMatch(partial, '22'),
    );
  });

  it('ranks prefix code above middle substring', () => {
    const prefix = emp({ code: '220', name: 'x' });
    const middle = emp({ code: '5222', name: 'y' });
    expect(rankEmployeeSearchMatch(prefix, '22')).toBeGreaterThan(
      rankEmployeeSearchMatch(middle, '22'),
    );
  });
});
