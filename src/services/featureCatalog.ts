/** Product entitlement keys — add new modules here + route/menu mapping. */
export type FeatureKey = (typeof FEATURE_CATALOG)[number]['key'];

export const FEATURE_CATALOG = [
  { key: 'attendance', nameAr: 'الحضور والشيفتات', nameEn: 'Attendance & shifts' },
  { key: 'hr_employees', nameAr: 'إدارة الموظفين', nameEn: 'Employee management' },
  { key: 'hr_leaves', nameAr: 'الإجازات', nameEn: 'Leaves' },
  { key: 'hr_requests', nameAr: 'الطلبات', nameEn: 'HR requests' },
  { key: 'employee_app', nameAr: 'تطبيق الموظف', nameEn: 'Employee app' },
  { key: 'hr_reports', nameAr: 'تقارير HR', nameEn: 'HR reports' },
  { key: 'payroll', nameAr: 'الرواتب', nameEn: 'Payroll' },
  { key: 'overtime', nameAr: 'الساعات الإضافية', nameEn: 'Overtime' },
  { key: 'advances', nameAr: 'السلف', nameEn: 'Advances' },
  { key: 'deductions', nameAr: 'الاستقطاعات', nameEn: 'Deductions' },
  { key: 'loans', nameAr: 'القروض', nameEn: 'Loans' },
  { key: 'fawry', nameAr: 'فوري', nameEn: 'Fawry' },
  { key: 'bank_export', nameAr: 'تصدير بنكي', nameEn: 'Bank export' },
  { key: 'advanced_reports', nameAr: 'تقارير متقدمة', nameEn: 'Advanced reports' },
  { key: 'api_access', nameAr: 'API', nameEn: 'API access' },
  { key: 'integrations', nameAr: 'تكاملات', nameEn: 'Integrations' },
  { key: 'advanced_permissions', nameAr: 'صلاحيات متقدمة', nameEn: 'Advanced permissions' },
] as const;

const KEY_SET = new Set(FEATURE_CATALOG.map((f) => f.key));

export function listFeatureCatalog() {
  return FEATURE_CATALOG.map((f) => ({ ...f }));
}

export function isValidFeatureKey(key: string): boolean {
  return KEY_SET.has(key);
}

export function normalizeFeatureKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const k = String(item ?? '').trim();
    if (!k || !isValidFeatureKey(k)) continue;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export function allFeatureKeys(): string[] {
  return FEATURE_CATALOG.map((f) => f.key);
}

/** Menu id → required entitlement (undefined = always on for HR roles). */
export const MENU_FEATURE_MAP: Record<string, string> = {
  hiring_appointments: 'hr_employees',
  employees: 'hr_employees',
  org_chart: 'hr_employees',
  shifts: 'attendance',
  shift_grid: 'attendance',
  attendance: 'attendance',
  my_attendance: 'employee_app',
  my_schedule: 'employee_app',
  my_advance_request: 'advances',
  my_requests: 'employee_app',
  my_payroll: 'payroll',
  hr_requests: 'hr_requests',
  advance_requests: 'advances',
  advances: 'advances',
  deductions: 'deductions',
  tips: 'payroll',
  payroll: 'payroll',
  reports: 'hr_reports',
  overtime: 'overtime',
  // settings: always visible for HR managers (not gated by plan SKU)
};

/** Route prefix → feature for API guards (first match wins). */
export const ROUTE_FEATURE_PREFIXES: Array<{ prefix: string; feature: string }> = [
  { prefix: '/payroll', feature: 'payroll' },
  { prefix: '/deductions', feature: 'deductions' },
  { prefix: '/advances', feature: 'advances' },
  { prefix: '/advance-requests', feature: 'advances' },
  { prefix: '/requests/leave', feature: 'hr_leaves' },
  { prefix: '/requests/loan', feature: 'loans' },
  { prefix: '/attendance', feature: 'attendance' },
  { prefix: '/shift-grid', feature: 'attendance' },
  { prefix: '/shifts', feature: 'attendance' },
  { prefix: '/overtime', feature: 'overtime' },
  { prefix: '/reports', feature: 'hr_reports' },
  { prefix: '/employees', feature: 'hr_employees' },
  { prefix: '/odoo', feature: 'integrations' },
];
