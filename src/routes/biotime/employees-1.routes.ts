import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrOrBranchManager } from '../../middlewares/auth';
import { p, parseRpcBool } from './route-helpers';
import { Prisma } from '@prisma/client';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { exportEmployeesXlsx, importEmployeesXlsx } from '../../services/employeesExcel.service';
import { exportPayrollXlsx, exportCashFawryXlsx, exportFileResponse, } from '../../services/payrollExport.service';
import { writeAudit } from '../../services/auditLog.service';
import { parsePagination, paginationMeta } from '../../utils/pagination';
import { prisma } from '../../prisma/client';
import { listEmployeesForSearch } from '../../services/employeeSearch.service';

const router = Router();

router.post('/employees/list', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const { limit, offset, page } = parsePagination(params, { limit: 30, maxLimit: 100 });
  const search = String(params.search ?? '').trim();
  const departmentId = params.departmentId != null ? String(params.departmentId) : undefined;
  const locationId = params.locationId != null ? String(params.locationId) : undefined;
  const biotimeDeviceId = params.biotimeDeviceId != null ? String(params.biotimeDeviceId) : undefined;
  const biotimeSynced = params.biotimeSynced;
  const excludeGridId = params.excludeGridId != null ? String(params.excludeGridId) : undefined;
  const includeInactive = parseRpcBool(params.includeInactive);
  const active = params.active === false || params.active === 'false' ? false : true;

  const where: Prisma.EmployeeProfileWhereInput = includeInactive
    ? {}
    : { active };
  if (excludeGridId) {
    where.shiftGridLines = { none: { gridId: excludeGridId } };
  }
  if (departmentId) where.departmentId = departmentId;
  const hrScope = await getHrLocationScopeFromReq(req);
  if (hrScope) {
    where.locationId = hrScope;
  } else if (locationId) {
    where.locationId = locationId;
  }
  if (biotimeDeviceId) where.biotimeDeviceId = biotimeDeviceId;
  if (biotimeSynced === true || biotimeSynced === 'true') where.biotimeSynced = true;
  if (biotimeSynced === false || biotimeSynced === 'false') where.biotimeSynced = false;

  const { employees, total } = await listEmployeesForSearch({
    where,
    search,
    limit,
    offset,
  });

  jsonRpcSuccess(
    res,
    biotimeOk({
      employees: employees.map((e) => employeeListJson(e)),
      ...paginationMeta(total, limit, offset, page),
    }),
    req.rpcId,
  );
}));

router.post('/employees/export-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const search = String(params.search ?? '').trim();
  const departmentId = params.departmentId != null ? String(params.departmentId) : undefined;
  const locationId = params.locationId != null ? String(params.locationId) : undefined;
  const biotimeDeviceId = params.biotimeDeviceId != null ? String(params.biotimeDeviceId) : undefined;
  const biotimeSynced = params.biotimeSynced;
  const templateOnly = params.templateOnly === true || params.templateOnly === 'true';
  const employeeIds = Array.isArray(params.employeeIds)
    ? (params.employeeIds as unknown[]).map(String).filter(Boolean)
    : undefined;
  const { syncJobTitlesFromEmployees } = await import('../../services/jobTitle.service');
  await syncJobTitlesFromEmployees();
  const base64 = await exportEmployeesXlsx({
    search: search || undefined,
    departmentId,
    locationId: (await getHrLocationScopeFromReq(req)) ?? locationId,
    biotimeDeviceId,
    biotimeSynced:
      biotimeSynced === true || biotimeSynced === 'true'
        ? true
        : biotimeSynced === false || biotimeSynced === 'false'
          ? false
          : undefined,
    employeeIds: employeeIds?.length ? employeeIds : undefined,
    templateOnly,
  });
  await writeAudit({
    req,
    module: 'employees',
    action: templateOnly ? 'employees.template_export' : 'employees.export',
    summary: templateOnly ? 'تصدير قالب Excel لموظفين جدد' : 'تصدير Excel للموظفين',
    counts: {
      filters: {
        search: search || null,
        departmentId: departmentId ?? null,
        locationId: locationId ?? null,
        selectedIds: employeeIds?.length ?? 0,
        templateOnly,
      },
    },
    payload: {
      type: templateOnly ? 'template' : 'export',
      filters: { search, departmentId, locationId, biotimeDeviceId, biotimeSynced, employeeIds, templateOnly },
    },
    route: '/employees/export-xlsx',
  });
  jsonRpcSuccess(
    res,
    biotimeOk(exportFileResponse(base64, templateOnly ? 'employees_new_template.xlsx' : 'employees.xlsx')),
    req.rpcId,
  );
}));

router.post('/employees/import-xlsx', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const base64 = String(p(req).base64 ?? '');
  if (!base64.trim()) {
    jsonRpcSuccess(res, biotimeFail('ملف Excel مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  const result = await importEmployeesXlsx(base64);
  await writeAudit({
    req,
    module: 'employees',
    action: 'employees.import',
    summary: result.message?.toString() || 'استيراد موظفين من Excel',
    counts: {
      created: result.created ?? 0,
      updated: result.updated ?? 0,
      skipped: result.skipped ?? 0,
      unchanged: result.unchanged ?? 0,
    },
    diffPreview: Array.isArray(result.changes) ? result.changes : [],
    payload: {
      type: 'import',
      result: {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        unchanged: result.unchanged,
        message: result.message,
        changeCount: Array.isArray(result.changes) ? result.changes.length : 0,
        errors: Array.isArray(result.errors) ? result.errors.slice(0, 50) : [],
        errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
      },
    },
    route: '/employees/import-xlsx',
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

export default router;
