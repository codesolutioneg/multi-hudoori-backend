import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrOrBranchManager, isBranchManagerUser } from '../../middlewares/auth';
import { getConfig, p } from './route-helpers';
import * as requestsService from '../../services/requests.service';
import { AdvanceState, DeductionState, PayrollState, ShiftGridState, HiringAppointmentStatus, UserRole } from '@prisma/client';
import { applyHiringAppointmentWebhook, countUnreadHiringUpdates, countPendingHiringAppointments, createHiringAppointment, getHiringAppointmentPdfBase64, hiringAppointmentJson, listHiringAppointments, markHiringAppointmentsSeen, parseCreateHiringAppointmentParams, parseHiringAppointmentWebhookParams, parseUpdateHiringAppointmentParams, updateHiringAppointment, } from '../../services/hiringAppointment.service';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { config } from '../../config';
import { countHealthCertificateAlerts, listHealthCertificateAlerts } from '../../services/healthCertificate.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { getDashboardCharts } from '../../services/dashboard.service';
import { getMySchedule } from '../../services/employeeSchedule.service';
import { AppError } from '../../utils/errors';
import { getDashboardNotifications, markDashboardNotificationsRead, } from '../../services/dashboardNotifications.service';
import { getUserRoles, getMenusForUser } from '../../services/roles.service';
import { locationsManagedBy } from '../../services/branchManager.service';
import { userHasAuditGrant, userHasAssistantGrant, userHasEmployeeDeleteGrant } from '../../services/auditLog.service';
import { listAbsenceAlerts, markAbsenceAlertsRead, } from '../../services/absenceAlerts.service';
import { prisma } from '../../prisma/client';
import { prismaBase } from '../../prisma/client';
import { cairoDateOnly } from '../../utils/payrollPeriod';
import { getMobilePunchContext } from '../../services/mobileLocationPunch.service';

const router = Router();

router.post('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: {
      location: true,
      employeeProfile: { include: { department: true, mapping: true } },
    },
  });
  if (!user) {
    // Local platform-admin token has synthetic id — still return menus/features.
    if (req.user?.role === UserRole.PLATFORM_ADMIN || req.user?.id === 'platform-admin') {
      const roles = getUserRoles(
        {
          id: 'platform-admin',
          companyId: null,
          login: req.user.login,
          email: req.user.email ?? req.user.login,
          name: req.user.name,
          passwordHash: '',
          initialPassword: null,
          passwordResetToken: null,
          passwordResetExpires: null,
          role: UserRole.PLATFORM_ADMIN,
          locationId: null,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        false,
      );
      const menus = getMenusForUser(roles, { auditLog: true });
      // Platform admin without a selected company: no per-company BioTime config.
      const config = req.user.activeCompanyId
        ? await getConfig()
        : {
            id: '',
            serverIp: '',
            serverPort: 8090,
            useHttps: false,
            username: '',
            password: '',
            authType: 'jwt',
            isConnected: false,
            timezone: 'Africa/Cairo',
          };
      let company: { id: string; code: string; name: string } | null = null;
      if (req.user.activeCompanyId) {
        company = await prismaBase.company.findUnique({
          where: { id: req.user.activeCompanyId },
          select: { id: true, code: true, name: true },
        });
      }
      jsonRpcSuccess(res, biotimeOk({
        user: {
          id: 'platform-admin',
          name: req.user.name,
          email: req.user.email ?? req.user.login,
          login: req.user.login,
          role: UserRole.PLATFORM_ADMIN,
          companyId: null,
          activeCompanyId: req.user.activeCompanyId ?? null,
          locationId: null,
          locationName: null,
          locationCode: null,
        },
        employee: {},
        mapping: {},
        roles,
        menus,
        features: { auditLog: true, helpAssistant: true, employeeDelete: true },
        config: configSummaryJson(config as never),
        apiVersion: '1.0.0-node-multi',
        company,
      }), req.rpcId);
      return;
    }
    jsonRpcSuccess(res, biotimeFail('User not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const roles = getUserRoles(user, Boolean(user.employeeProfile));
  const [auditLog, helpAssistant, employeeDelete, managedLocations] = await Promise.all([
    roles.isPlatformAdmin ? Promise.resolve(true) : userHasAuditGrant(user.id),
    roles.isPlatformAdmin ? Promise.resolve(true) : userHasAssistantGrant(user.id),
    roles.isPlatformAdmin ? Promise.resolve(true) : userHasEmployeeDeleteGrant(user.id),
    roles.isHrUser ? Promise.resolve([] as string[]) : locationsManagedBy(user.id),
  ]);
  let mobileLocationPunch = false;
  if (user.employeeProfile) {
    try {
      const punchCtx = await getMobilePunchContext(user.id);
      mobileLocationPunch = punchCtx.enabled;
    } catch {
      mobileLocationPunch = false;
    }
  }
  const menus = getMenusForUser(roles, {
    auditLog,
    runsABranch: managedLocations.length > 0,
    mobileLocationPunch,
  });
  let config: Awaited<ReturnType<typeof getConfig>> | Record<string, unknown>;
  try {
    config = await getConfig();
  } catch {
    config = {
      id: '',
      serverIp: '',
      serverPort: 8090,
      useHttps: false,
      username: '',
      password: '',
      authType: 'jwt',
      isConnected: false,
      timezone: 'Africa/Cairo',
    };
  }

  const companyId = user.companyId ?? req.user?.activeCompanyId ?? null;
  const company = companyId
    ? await prismaBase.company.findUnique({
        where: { id: companyId },
        select: { id: true, code: true, name: true },
      })
    : null;

  jsonRpcSuccess(res, biotimeOk({
    user: {
      id: user.id,
      name: user.name,
      email: user.email ?? user.login,
      login: user.login,
      role: user.role,
      companyId: user.companyId ?? null,
      activeCompanyId: req.user?.activeCompanyId ?? user.companyId ?? null,
      locationId: user.locationId,
      locationName: user.location?.name ?? null,
      locationCode: user.location?.code ?? null,
    },
    employee: user.employeeProfile ? employeeJson(user.employeeProfile, true) : {},
    mapping: user.employeeProfile?.mapping ? {
      biotimeEmpId: user.employeeProfile.mapping.biotimeEmpId,
      biotimeEmpCode: user.employeeProfile.mapping.biotimeEmpCode,
    } : {},
    roles,
    menus,
    features: { auditLog, helpAssistant, employeeDelete, mobileLocationPunch },
        config: configSummaryJson(config as never),
        apiVersion: '1.0.0-node-multi',
        companyId: user.companyId ?? null,
        activeCompanyId: req.user?.activeCompanyId ?? user.companyId ?? null,
        company,
      }), req.rpcId);
}));

router.post('/my-schedule', requireAuth, asyncHandler(async (req, res) => {
  const params = p(req);
  const rawFrom = params.dateFrom == null ? undefined : String(params.dateFrom);
  const rawTo = params.dateTo == null ? undefined : String(params.dateTo);
  if ((rawFrom && !rawTo) || (!rawFrom && rawTo)) {
    throw new AppError('لازم تحدد بداية ونهاية الفترة مع بعض', 400, 'VALIDATION');
  }
  const dateFrom = rawFrom ? new Date(rawFrom) : undefined;
  const dateTo = rawTo ? new Date(rawTo) : undefined;
  if ((dateFrom && Number.isNaN(dateFrom.getTime())) || (dateTo && Number.isNaN(dateTo.getTime()))) {
    throw new AppError('تاريخ غير صالح', 400, 'VALIDATION');
  }
  if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
    throw new AppError('تاريخ البداية بعد تاريخ النهاية', 400, 'VALIDATION');
  }
  const schedule = await getMySchedule({
    userId: req.user!.id,
    dateFrom,
    dateTo,
    forceSelfOnly: req.user!.role === UserRole.EMPLOYEE,
  });
  jsonRpcSuccess(res, biotimeOk(schedule), req.rpcId);
}));

/**
 * Dashboard tiles. Every figure here is company-wide — headcount, today's
 * attendance, open payrolls, the request queue — so a branch employee gets a
 * response of zeros rather than the real numbers. Their own dashboard reads
 * their attendance from `my-attendance`, not from here; hiding the tiles in
 * Flutter alone would still have put the counts in the JSON.
 */
router.post('/dashboard/stats', requireAuth, asyncHandler(async (req, res) => {
  const today = cairoDateOnly();
  const isBranchManager = isBranchManagerUser(req);
  const overviewRoles: UserRole[] = [
    UserRole.HR_MANAGER,
    UserRole.HR_SUPERVISOR,
    UserRole.HR_USER,
    UserRole.BRANCH_MANAGER,
    UserRole.PLATFORM_ADMIN,
  ];
  const canViewOverview = overviewRoles.includes(req.user!.role);
  if (!canViewOverview) {
    jsonRpcSuccess(res, biotimeOk({
      attendanceToday: 0,
      payrollDraft: 0,
      employeesCount: 0,
      employees: 0,
      pendingRequests: 0,
      healthCertAlerts: 0,
      hiringUnread: 0,
      absentUnread: 0,
    }), req.rpcId);
    return;
  }

  const hrScope = await getHrLocationScopeFromReq(req);
  const [attendanceToday, payrollDraft, employees, pendingRequests, healthCertAlerts, hiringUnread, absenceAlerts] = await Promise.all([
    prisma.attendance.count({ where: { date: today, employee: { active: true } } }),
    prisma.payroll.count({ where: { state: PayrollState.draft } }),
    prisma.employeeProfile.count({ where: { active: true, ...(hrScope ? { locationId: hrScope } : {}) } }),
    isBranchManager ? Promise.resolve(0) : requestsService.countPendingRequests(),
    isBranchManager ? Promise.resolve(0) : countHealthCertificateAlerts(),
    isBranchManager
      ? countPendingHiringAppointments(hrScope)
      : countUnreadHiringUpdates(hrScope),
    listAbsenceAlerts(req),
  ]);
  jsonRpcSuccess(res, biotimeOk({
    attendanceToday,
    payrollDraft,
    employeesCount: employees,
    employees: employees,
    pendingRequests,
    healthCertAlerts,
    hiringUnread,
    absentUnread: absenceAlerts?.unreadCount ?? 0,
  }), req.rpcId);
}));

router.post('/dashboard/notifications', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const data = await getDashboardNotifications(req);
  jsonRpcSuccess(res, biotimeOk(data), req.rpcId);
}));

router.post('/dashboard/notifications/read-all', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const data = await markDashboardNotificationsRead(req);
  jsonRpcSuccess(res, biotimeOk(data), req.rpcId);
}));

router.post('/absences/list', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const data = await listAbsenceAlerts(req);
  jsonRpcSuccess(res, biotimeOk(data), req.rpcId);
}));

router.post('/absences/read', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const data = await markAbsenceAlertsRead(req);
  jsonRpcSuccess(res, biotimeOk(data), req.rpcId);
}));

router.post('/dashboard/charts', requireAuth, asyncHandler(async (req, res) => {
  const charts = await getDashboardCharts();
  jsonRpcSuccess(res, biotimeOk(charts), req.rpcId);
}));

// --- Attendance ---

export default router;
