import { describe, it, expect } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../../src/services/assistant.knowledge';
import { buildAssistantUserTurn } from '../../src/services/assistant.service';
import { ASSISTANT_FEATURE } from '../../src/services/auditLog.service';

describe('help assistant', () => {
  it('uses a dedicated feature key separate from audit', () => {
    expect(ASSISTANT_FEATURE).toBe('help_assistant');
  });

  it('covers core HR modules and explain-only professional rules', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/employees');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/hiring-appointments');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/shifts');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/shift-grid');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/attendance');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/deductions');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/advances');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/tips');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/payroll');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/reports');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/settings');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('/hr/audit');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('تشرح فقط');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('العامية المصرية');
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain('بالبلدي');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('توزيع متساوٍ');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('تخطي الرقم القومي');
  });

  it('prefixes the current dashboard page onto the user turn', () => {
    expect(buildAssistantUserTurn('إيه زرار الاعتماد؟', '/hr/advances/loan-import')).toBe(
      'الصفحة الحالية: /hr/advances/loan-import\n\nإيه زرار الاعتماد؟',
    );
    expect(buildAssistantUserTurn('إيه زرار الاعتماد؟')).toBe('إيه زرار الاعتماد؟');
  });
});
