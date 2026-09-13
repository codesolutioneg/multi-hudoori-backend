import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrManager } from '../../middlewares/auth';
import { p, parseRpcBool, getConfig } from './route-helpers';
import { BioTimeConnector } from '../../services/biotime/biotimeConnector.service';
import { Prisma } from '@prisma/client';
import { config } from '../../config';
import { deleteCompanyLogo, readCompanyLogo, saveCompanyLogo, } from '../../services/companyLogo.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { prisma } from '../../prisma/client';
import {
  parseLateForgivenSelection,
  parseLateGracePrecedence,
} from '../../services/latePolicy.service';
import { parseTeamScheduleScope } from '../../services/employeeSchedule.service';
import { AppError } from '../../utils/errors';

const router = Router();

router.post('/config/get', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const config = await getConfig();
  jsonRpcSuccess(res, biotimeOk({ config: await configSettingsWithCounts(config) }), req.rpcId);
}));

router.post('/config/update', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const config = await getConfig();
  const params = p(req);
  const data: Prisma.BioTimeConfigUpdateInput = {};
  const boolMap: Record<string, keyof Prisma.BioTimeConfigUpdateInput> = {
    scheduledAutoSyncEnabled: 'scheduledAutoSyncEnabled',
    autoSyncDepartments: 'autoSyncDepartments',
    autoSyncEmployees: 'autoSyncEmployees',
    autoSyncTransactions: 'autoSyncTransactions',
    autoPushToBiotime: 'autoPushToBiotime',
    autoPushDeletes: 'autoPushDeletes',
    useHttps: 'useHttps',
    employeeTeamShowShiftTimes: 'employeeTeamShowShiftTimes',
    employeeTeamShowOffDays: 'employeeTeamShowOffDays',
    employeeTeamShowLeave: 'employeeTeamShowLeave',
    employeeTeamShowSickLeave: 'employeeTeamShowSickLeave',
    payrollFixedMonthDaysEnabled: 'payrollFixedMonthDaysEnabled',
  };
  for (const [k, field] of Object.entries(boolMap)) {
    if (k in params) data[field] = parseRpcBool(params[k]);
  }
  if (Object.keys(data).length > 0) {
    console.log('[config/update] incoming:', Object.fromEntries(
      Object.entries(boolMap).filter(([k]) => k in params).map(([k]) => [k, params[k]]),
    ));
    console.log('[config/update] prisma data:', data);
  }
  if ('serverIp' in params) data.serverIp = String(params.serverIp);
  if ('serverPort' in params) data.serverPort = Number(params.serverPort);
  if ('username' in params) data.username = String(params.username);
  if ('password' in params) data.password = String(params.password);
  if ('duplicateGraceMinutes' in params) data.duplicateGraceMinutes = Number(params.duplicateGraceMinutes);
  if ('duplicatePolicy' in params) data.duplicatePolicy = String(params.duplicatePolicy);
  if ('advanceDefaultPercent' in params) data.advanceDefaultPercent = Number(params.advanceDefaultPercent);
  if ('advanceMinimumWorkingDays' in params) data.advanceMinimumWorkingDays = Number(params.advanceMinimumWorkingDays);
  if ('advanceEnforceLimit' in params) data.advanceEnforceLimit = parseRpcBool(params.advanceEnforceLimit);
  if ('advanceEligibilitySource' in params) {
    const src = String(params.advanceEligibilitySource);
    data.advanceEligibilitySource = src === 'shift_grid' ? 'shift_grid' : 'punch_report';
  }
  if ('tipJobTitleIds' in params) {
    const raw = params.tipJobTitleIds;
    const ids = Array.isArray(raw)
      ? raw.map(String).map((s) => s.trim()).filter(Boolean)
      : String(raw ?? '')
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean);
    data.tipJobTitleIds = ids;
  }

  // Late policy. Rungs are stored as given and clamped on read, so a partial
  // update cannot leave the ladder inverted.
  const lateIntFields = [
    'lateGraceMinutes',
    'lateQuarterDayMaxMinutes',
    'lateHalfDayMaxMinutes',
    'lateForgivenDaysCount',
    'latePermissionCap',
  ] as const;
  for (const field of lateIntFields) {
    if (!(field in params)) continue;
    const minutes = Math.round(Number(params[field]));
    if (!Number.isFinite(minutes) || minutes < 0) {
      throw new AppError(`قيمة غير صالحة للحقل ${field}`, 400, 'ACTION_ERROR');
    }
    data[field] = minutes;
  }
  if ('payrollMonthStartDay' in params) {
    const day = Math.round(Number(params.payrollMonthStartDay));
    if (!Number.isFinite(day) || day < 1 || day > 31) {
      throw new AppError('يوم بداية شهر الرواتب لازم يكون من 1 لـ 31', 400, 'ACTION_ERROR');
    }
    data.payrollMonthStartDay = day;
  }
  if ('payrollFixedMonthDays' in params) {
    const days = Math.round(Number(params.payrollFixedMonthDays));
    if (!Number.isFinite(days) || days < 1 || days > 31) {
      throw new AppError('عدد أيام الشهر الثابت لازم يكون من 1 لـ 31', 400, 'ACTION_ERROR');
    }
    data.payrollFixedMonthDays = days;
  }
  if ('absentForgivenDaysCount' in params) {
    const n = Math.round(Number(params.absentForgivenDaysCount));
    if (!Number.isFinite(n) || n < 0 || n > 31) {
      throw new AppError('حد أيام الغياب المسموحة لازم يكون من 0 لـ 31', 400, 'ACTION_ERROR');
    }
    data.absentForgivenDaysCount = n;
  }
  if ('employeeTeamScheduleScope' in params) {
    data.employeeTeamScheduleScope = parseTeamScheduleScope(params.employeeTeamScheduleScope);
  }
  if ('gridWeekStartDay' in params) {
    const day = Math.round(Number(params.gridWeekStartDay));
    if (!Number.isFinite(day) || day < 0 || day > 6) {
      throw new AppError('يوم بداية الأسبوع لازم يكون من 0 (الأحد) لـ 6 (السبت)', 400, 'ACTION_ERROR');
    }
    data.gridWeekStartDay = day;
  }
  if ('lateForgivenDaysSelection' in params) {
    data.lateForgivenDaysSelection = parseLateForgivenSelection(params.lateForgivenDaysSelection);
  }
  if ('lateGracePrecedence' in params) {
    data.lateGracePrecedence = parseLateGracePrecedence(params.lateGracePrecedence);
  }
  if ('latePermissionCapEnabled' in params) {
    data.latePermissionCapEnabled = parseRpcBool(params.latePermissionCapEnabled);
  }
  for (const field of ['defaultLateCheckoutHours', 'defaultEarlyCheckinHours'] as const) {
    if (!(field in params)) continue;
    const hours = Number(params[field]);
    if (!Number.isFinite(hours) || hours < 0 || hours > 12) {
      throw new AppError(`قيمة غير صالحة لـ ${field} (0–12 ساعة)`, 400, 'ACTION_ERROR');
    }
    data[field] = hours;
  }

  const updated = await prisma.bioTimeConfig.update({ where: { id: config.id }, data });
  if (Object.keys(data).length > 0) {
    console.log('[config/update] saved:', {
      scheduledAutoSyncEnabled: updated.scheduledAutoSyncEnabled,
      autoSyncEmployees: updated.autoSyncEmployees,
      autoSyncDepartments: updated.autoSyncDepartments,
      autoSyncTransactions: updated.autoSyncTransactions,
      autoPushToBiotime: updated.autoPushToBiotime,
    });
  }
  jsonRpcSuccess(res, biotimeOk({ config: await configSettingsWithCounts(updated), message: 'تم حفظ الإعدادات' }), req.rpcId);
}));

router.post('/company/logo/upload', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const base64 = String(params.base64 ?? params.file ?? '');
  if (!base64.trim()) {
    jsonRpcSuccess(res, biotimeFail('ملف فارغ', 'VALIDATION'), req.rpcId);
    return;
  }
  try {
    const result = await saveCompanyLogo(base64, params.mimeType ? String(params.mimeType) : undefined);
    const config = await getConfig();
    jsonRpcSuccess(res, biotimeOk({
      relativePath: result.relativePath,
      hasCompanyLogo: true,
      config: await configSettingsWithCounts(config),
      message: 'تم رفع شعار الشركة',
    }), req.rpcId);
  } catch (e) {
    jsonRpcSuccess(res, biotimeFail(e instanceof Error ? e.message : 'فشل رفع الشعار', 'VALIDATION'), req.rpcId);
  }
}));

router.post('/company/logo/get', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const file = await readCompanyLogo();
  if (!file) {
    jsonRpcSuccess(res, biotimeFail('لا يوجد شعار للشركة', 'NOT_FOUND'), req.rpcId);
    return;
  }
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

router.post('/company/logo/delete', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  await deleteCompanyLogo();
  const config = await getConfig();
  jsonRpcSuccess(res, biotimeOk({
    hasCompanyLogo: false,
    config: await configSettingsWithCounts(config),
    message: 'تم حذف شعار الشركة',
  }), req.rpcId);
}));

router.post('/config/test-connection', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  try {
    const connector = await BioTimeConnector.fromDb();
    await connector.testConnection();
    const config = await getConfig();
    jsonRpcSuccess(res, biotimeOk({ config: await configSettingsWithCounts(config), message: 'Connection successful' }), req.rpcId);
  } catch (e: unknown) {
    jsonRpcSuccess(res, biotimeFail(e instanceof Error ? e.message : 'Connection failed', 'ACTION_ERROR'), req.rpcId);
  }
}));

// --- Locations (master list) ---

export default router;
