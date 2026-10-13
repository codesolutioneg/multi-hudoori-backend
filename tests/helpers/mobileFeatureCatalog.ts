/**
 * Mobile app features (screens / flows) → API paths the Flutter UI actually calls.
 * Used for feature-scoped E2E, not only raw path inventory.
 */
import type { MobilePathAudience } from './mobileApiInventory';

export type MobileFeatureSpec = {
  /** Stable id matching app area */
  id: string;
  /** Human label */
  label: string;
  /** Primary role that opens this feature in the app */
  audience: MobilePathAudience | 'ALL_AUTH';
  /** Paths invoked on load or core actions (params from minimalParamsForPath) */
  paths: string[];
};

export const MOBILE_FEATURES: MobileFeatureSpec[] = [
  {
    id: 'auth',
    label: 'Sign in / password recovery',
    audience: 'AUTH',
    paths: [
      '/api/auth/login',
      '/api/auth/validate',
      '/api/auth/forgot-password',
    ],
  },
  {
    id: 'session',
    label: 'Session / me / FCM',
    audience: 'ALL_AUTH',
    paths: ['/api/biotime/me', '/api/biotime/me/fcm-token'],
  },
  {
    id: 'employee_home',
    label: 'Employee home & dashboard',
    audience: 'EMPLOYEE',
    paths: [
      '/api/biotime/dashboard/stats',
      '/api/biotime/dashboard/charts',
      '/api/biotime/dashboard/notifications',
      '/api/biotime/attendance/my',
    ],
  },
  {
    id: 'notifications',
    label: 'In-app notifications',
    audience: 'ALL_AUTH',
    paths: ['/api/biotime/notifications/list'],
  },
  {
    id: 'my_schedule',
    label: 'My schedule',
    audience: 'EMPLOYEE',
    paths: ['/api/biotime/my-schedule'],
  },
  {
    id: 'mobile_punch',
    label: 'Mobile geofence punch',
    audience: 'EMPLOYEE',
    paths: [
      '/api/biotime/mobile-punch/context',
      '/api/biotime/mobile-punch/check-in',
      '/api/biotime/mobile-punch/check-out',
    ],
  },
  {
    id: 'requests',
    label: 'Leave / shift / attendance requests',
    audience: 'EMPLOYEE',
    paths: [
      '/api/biotime/requests/my',
      '/api/biotime/requests/leave/create',
      '/api/biotime/requests/shift-change/create',
      '/api/biotime/requests/attendance-edit/create',
    ],
  },
  {
    id: 'requests_hr',
    label: 'HR request queue',
    audience: 'HR',
    paths: ['/api/biotime/requests/pending'],
  },
  {
    id: 'advance_employee',
    label: 'Employee advance request',
    audience: 'EMPLOYEE',
    paths: [
      '/api/biotime/advance-requests/eligibility',
      '/api/biotime/advance-requests/my',
      '/api/biotime/advance-requests/create',
    ],
  },
  {
    id: 'advance_queue',
    label: 'Advance requests queue (BM / HR)',
    audience: 'HR',
    paths: ['/api/biotime/advance-requests/list'],
  },
  {
    id: 'advance_branch_approve',
    label: 'Branch manager advance approval',
    audience: 'BRANCH_MANAGER',
    paths: ['/api/biotime/advance-requests/branch-approve'],
  },
  {
    id: 'my_payroll',
    label: 'Employee payslips',
    audience: 'EMPLOYEE',
    paths: ['/api/biotime/payroll/my'],
  },
  {
    id: 'absences',
    label: 'Absence alerts',
    audience: 'HR',
    paths: ['/api/biotime/absences/list'],
  },
  {
    id: 'hr_employees',
    label: 'Employees directory',
    audience: 'HR',
    paths: [
      '/api/biotime/employees/list',
      '/api/biotime/employees/export-xlsx',
      '/api/biotime/departments/list',
      '/api/biotime/locations/list',
      '/api/biotime/job-titles/list',
      '/api/biotime/job-levels/list',
      '/api/biotime/archive-reasons/list',
    ],
  },
  {
    id: 'hr_attendance',
    label: 'HR attendance',
    audience: 'HR',
    paths: [
      '/api/biotime/attendance/list',
      '/api/biotime/attendance/generate',
    ],
  },
  {
    id: 'shifts',
    label: 'Shifts master',
    audience: 'HR',
    paths: [
      '/api/biotime/shifts/list',
      '/api/biotime/shifts/export-xlsx',
    ],
  },
  {
    id: 'shift_assignments',
    label: 'Shift assignments',
    audience: 'HR',
    paths: ['/api/biotime/shift-assignments/list'],
  },
  {
    id: 'shift_grid',
    label: 'Shift grid (list & detail loads)',
    audience: 'HR',
    paths: [
      '/api/biotime/shift-grid/list',
      '/api/biotime/shift-grid/get',
      '/api/biotime/shift-grid/merge/candidates',
      '/api/biotime/shift-grid/sync/status',
    ],
  },
  {
    id: 'payroll_hr',
    label: 'Payroll sheets',
    audience: 'HR',
    paths: [
      '/api/biotime/payroll/list',
      '/api/biotime/payroll/get',
      '/api/biotime/payroll/period/employees/search',
    ],
  },
  {
    id: 'deductions',
    label: 'Deductions',
    audience: 'HR',
    paths: [
      '/api/biotime/deductions/list',
      '/api/biotime/deductions/types',
      '/api/biotime/deductions/scope-count',
      '/api/biotime/deductions/job-titles',
    ],
  },
  {
    id: 'advances_hr',
    label: 'Advances (short / long / loan import)',
    audience: 'HR',
    paths: [
      '/api/biotime/advances/short/list',
      '/api/biotime/advances/long/list',
      '/api/biotime/advances/loan-import/list',
      '/api/biotime/advances/export/short',
      '/api/biotime/advances/export/long',
    ],
  },
  {
    id: 'hiring',
    label: 'Hiring appointments',
    audience: 'HR',
    paths: [
      '/api/biotime/hiring-appointments/list',
      '/api/biotime/hiring-appointments/unread-count',
    ],
  },
  {
    id: 'overtime',
    label: 'Overtime analysis',
    audience: 'HR',
    paths: ['/api/biotime/overtime/list'],
  },
  {
    id: 'reports',
    label: 'HR reports hub',
    audience: 'HR',
    paths: [
      '/api/biotime/reports/documents/types',
      '/api/biotime/reports/punch-summary',
      '/api/biotime/reports/location-mismatch',
      '/api/biotime/reports/fawry',
      '/api/biotime/reports/insurance',
      '/api/biotime/reports/health-certificates',
      '/api/biotime/reports/no-punches',
      '/api/biotime/reports/employee-emails',
    ],
  },
  {
    id: 'org_chart',
    label: 'Org chart',
    audience: 'HR',
    paths: [
      '/api/biotime/org-chart/tree',
      '/api/biotime/org-chart/manager-options',
    ],
  },
  {
    id: 'health_certs',
    label: 'Health certificate alerts',
    audience: 'HR',
    paths: ['/api/biotime/health-certificates/alerts'],
  },
  {
    id: 'settings',
    label: 'Settings / config / devices / Odoo',
    audience: 'HR',
    paths: [
      '/api/biotime/config/get',
      '/api/biotime/config/sync-status',
      '/api/biotime/devices/list',
      '/api/biotime/branch-managers/list',
      '/api/biotime/insurance-companies/list',
      '/api/biotime/custody-types/list',
      '/api/biotime/odoo/config/get',
      '/api/biotime/odoo/push-status',
      '/api/biotime/company/logo/get',
      '/api/biotime/company/quota',
    ],
  },
  {
    id: 'audit',
    label: 'Audit log',
    audience: 'HR',
    paths: ['/api/biotime/audit/list'],
  },
  {
    id: 'push_admin',
    label: 'Push notifications (HR broadcast)',
    audience: 'HR',
    paths: [
      '/api/biotime/notifications/admin-list',
      '/api/biotime/notifications/broadcast',
    ],
  },
  {
    id: 'assistant',
    label: 'HR assistant chat',
    audience: 'HR',
    paths: ['/api/biotime/assistant/chat'],
  },
  {
    id: 'platform_admin',
    label: 'Platform admin console',
    audience: 'PLATFORM_ADMIN',
    paths: [
      '/api/admin/companies/list',
      '/api/admin/companies/stats',
      '/api/admin/plans/list',
      '/api/admin/plans/feature-catalog',
      '/api/admin/users/list',
      '/api/admin/sales-requests/list',
      '/api/admin/feature-grants/list',
    ],
  },
];

export function allFeaturePaths(): string[] {
  const s = new Set<string>();
  for (const f of MOBILE_FEATURES) {
    for (const p of f.paths) s.add(p);
  }
  return [...s].sort();
}
