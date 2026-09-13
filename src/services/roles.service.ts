import { User, UserRole } from '@prisma/client';

export interface BioTimeRoles {
  isEmployee: boolean;
  isHrUser: boolean;
  isHrManager: boolean;
  isHrSupervisor: boolean;
  isBranchManager: boolean;
  isDeviceManager: boolean;
  isSystemAdmin: boolean;
  isPlatformAdmin: boolean;
}

export function getUserRoles(user: User, hasEmployee: boolean): BioTimeRoles {
  const isPlatformAdmin = user.role === UserRole.PLATFORM_ADMIN;
  const isBranchManager = user.role === UserRole.BRANCH_MANAGER;
  const isHrSupervisor = user.role === UserRole.HR_SUPERVISOR;
  const isHrManager = user.role === UserRole.HR_MANAGER || isPlatformAdmin;
  const isHrUser =
    user.role === UserRole.HR_USER ||
    user.role === UserRole.HR_MANAGER ||
    user.role === UserRole.HR_SUPERVISOR ||
    isPlatformAdmin;
  const isDeviceManager = user.role === UserRole.DEVICE_MANAGER || isHrManager;
  const isEmployee = hasEmployee || user.role === UserRole.EMPLOYEE;

  return {
    isEmployee,
    isHrUser,
    isHrManager,
    isHrSupervisor,
    isBranchManager,
    isDeviceManager,
    isSystemAdmin: isPlatformAdmin,
    isPlatformAdmin,
  };
}

export function getMenusForUser(
  roles: BioTimeRoles,
  _options?: {
    auditLog?: boolean;
    /**
     * Signs off advance requests for at least one branch. Most designated branch
     * managers are plain EMPLOYEE accounts, so this cannot be read off the role.
     */
    runsABranch?: boolean;
    /** Branch has GPS punch enabled — show attendance punch screen. */
    mobileLocationPunch?: boolean;
  },
): Array<{
  id: string;
  name: string;
  icon: string;
  route: string;
}> {
  const menus: Array<{ id: string; name: string; icon: string; route: string }> = [];

  if (roles.isEmployee &&
      !roles.isHrUser &&
      !roles.isBranchManager &&
      !roles.isSystemAdmin) {
    // Branch employees: read-only self-service (own attendance + schedule).
    menus.push(
      { id: 'dashboard', name: 'الرئيسية', icon: 'dashboard', route: '/dashboard' },
      { id: 'my_schedule', name: 'جدولي', icon: 'calendar_month', route: '/my/schedule' },
      { id: 'my_attendance', name: 'حضوري', icon: 'schedule', route: '/attendance/my' },
      // The one thing a branch employee may submit, not just read.
      { id: 'my_advance_request', name: 'طلب سلفة', icon: 'request_quote', route: '/my/advance-request' },
    );
    if (_options?.mobileLocationPunch) {
      menus.push({
        id: 'mobile_punch',
        name: 'بصمة الموقع',
        icon: 'my_location',
        route: '/my/location-punch',
      });
    }
    // Designated as «مدير الفرع» without carrying the role: they still need the
    // queue to sign off their own branch's requests.
    if (_options?.runsABranch) {
      menus.push({
        id: 'advance_requests',
        name: 'طلبات السلف',
        icon: 'request_quote',
        route: '/hr/advance-requests',
      });
    }
  }

  if (roles.isBranchManager) {
    menus.push(
      { id: 'dashboard', name: 'الرئيسية', icon: 'dashboard', route: '/dashboard' },
      { id: 'hiring_appointments', name: 'التعيينات', icon: 'assignment_ind', route: '/hr/hiring-appointments' },
      { id: 'shifts', name: 'الشيفتات', icon: 'access_time', route: '/hr/shifts' },
      { id: 'shift_grid', name: 'جدول الشيفتات', icon: 'grid_on', route: '/hr/shift-grid' },
      { id: 'advance_requests', name: 'طلبات السلف', icon: 'request_quote', route: '/hr/advance-requests' },
    );
  }

  if (roles.isHrUser || roles.isHrManager) {
    const hrMenus = [
      { id: 'hr_dashboard', name: 'لوحة HR', icon: 'dashboard', route: '/hr/dashboard' },
      { id: 'employees', name: 'الموظفين', icon: 'people', route: '/hr/employees' },
      { id: 'hiring_appointments', name: 'التعيينات', icon: 'assignment_ind', route: '/hr/hiring-appointments' },
      { id: 'shifts', name: 'الشيفتات', icon: 'access_time', route: '/hr/shifts' },
      // { id: 'shift_assignments', name: 'تعيين الشيفتات', icon: 'event_repeat', route: '/hr/shift-assignments' },
      { id: 'shift_grid', name: 'جدول الشيفتات', icon: 'grid_on', route: '/hr/shift-grid' },
      { id: 'attendance', name: 'الحضور', icon: 'fact_check', route: '/hr/attendance' },
      // { id: 'overtime', name: 'تحليل الإضافي', icon: 'access_time', route: '/hr/overtime' },
      { id: 'deductions', name: 'الاستقطاعات', icon: 'remove_circle_outline', route: '/hr/deductions' },
      // Branch requests waiting on HR live in a tab inside «السلف» — granting one
      // creates the advance, so the decision sits with the sheet it lands on.
      { id: 'advances', name: 'السلف', icon: 'account_balance_wallet', route: '/hr/advances' },
      { id: 'tips', name: 'Commission', icon: 'card_giftcard', route: '/hr/tips' },
      { id: 'payroll', name: 'الرواتب', icon: 'payments', route: '/hr/payroll' },
      { id: 'reports', name: 'تقارير المتابعة', icon: 'assessment', route: '/hr/reports' },
    ];
    if (roles.isHrManager) {
      // The org chart shows the whole company's reporting line, so it stops with
      // the HR manager (and the platform admin, who is folded into that flag).
      hrMenus.push({ id: 'org_chart', name: 'الهيكل التنظيمي', icon: 'account_tree', route: '/org-chart' });
      hrMenus.push({ id: 'settings', name: 'إعدادات', icon: 'settings', route: '/hr/settings' });
    }
    menus.push(...hrMenus);
  }

  if (!menus.length) {
    menus.push({ id: 'dashboard', name: 'الرئيسية', icon: 'dashboard', route: '/dashboard' });
  }

  return menus;
}
