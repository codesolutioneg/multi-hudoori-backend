import { describe, it, expect } from 'vitest';
import { EMPLOYEE_EXCEL_HEADERS } from '../../src/services/employeesExcel.service';

describe('employeesExcel insurance columns', () => {
  it('includes social and medical insurance company + medical salary headers', () => {
    const h = [...EMPLOYEE_EXCEL_HEADERS];
    expect(h).toContain('الموقف التأميني');
    expect(h).toContain('الرقم التأميني');
    expect(h).toContain('الأجر التأميني');
    expect(h).toContain('موقف التأمين الطبي');
    expect(h).toContain('الأجر التأميني الطبي');
    expect(h.indexOf('موقف التأمين الطبي')).toBeGreaterThan(
      h.indexOf('الأجر التأميني'),
    );
  });
});
