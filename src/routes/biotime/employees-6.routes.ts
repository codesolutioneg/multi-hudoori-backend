import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p, getConfig } from './route-helpers';
import { applyEmployeeLocation, employeesForLocation, resolveLocation, relocateEmployeesToGridLocation, } from '../../services/location.service';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { config } from '../../config';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { ensureDefaultCustodyTypes, listEmployeeCustodies, syncEmployeeCustodies, } from '../../services/employeeCustody.service';
import { paramKeysAffectBioTimePush } from '../../services/biotime/employeeBiotimeFingerprint';
import { parseEmployeeCustomUpdate } from '../../services/employeeProfileFields.service';
import { prisma } from '../../prisma/client';
import { pushEmployeeToBioTime } from '../../services/biotime/employeePush.service';
import { validateEgyptianIban } from '../../utils/iban';
import { writeAudit, shallowFieldDiffs } from '../../services/auditLog.service';
import { generateWorkEmailPassword } from '../../services/employeeWorkEmail.service';
import { syncEmployeeLoginFromWorkEmail } from '../../services/employeeLogin.service';

const router = Router();

router.post('/employees/update', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.employeeId ?? '');
  const existing = await prisma.employeeProfile.findUnique({ where: { id } });
  if (!existing) {
    jsonRpcSuccess(res, biotimeFail('Employee not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const hrScope = await getHrLocationScopeFromReq(req);
  assertEmployeeLocationAccess(hrScope, existing.locationId);

  const pushToBiotime = params.pushToBiotime === true;
  const config = await getConfig();
  const data: Record<string, unknown> = {};
  const markBioTimeDirty = paramKeysAffectBioTimePush(params as Record<string, unknown>);

  if ('name' in params) {
    const name = String(params.name);
    data.name = name;
    data.displayName = name;
  }
  if ('displayName' in params) data.displayName = String(params.displayName);
  if ('identificationId' in params) {
    const code = String(params.identificationId);
    data.identificationId = code;
    data.code = code;
    data.barcode = code;
  }
  if ('code' in params) {
    const code = String(params.code);
    data.code = code;
    data.barcode = code;
  }
  if ('departmentId' in params) {
    const deptId = params.departmentId ? String(params.departmentId) : null;
    data.departmentId = deptId;
  }
  if ('gender' in params) data.gender = String(params.gender);
  if ('basicSalary' in params) data.basicSalary = Number(params.basicSalary);
  if ('workPhone' in params) data.workPhone = String(params.workPhone);
  if ('mobilePhone' in params) data.mobilePhone = String(params.mobilePhone);
  if ('workEmail' in params) data.workEmail = String(params.workEmail);
  if ('workEmailPassword' in params) {
    const pwd = String(params.workEmailPassword ?? '').trim();
    data.workEmailPassword = pwd || null;
  }
  // First-time password: if there is an email and no password yet, mint one.
  {
    const nextEmail = String(
      'workEmail' in data ? data.workEmail : existing.workEmail ?? '',
    ).trim();
    const nextPwd = String(
      'workEmailPassword' in data
        ? (data.workEmailPassword ?? '')
        : (existing.workEmailPassword ?? ''),
    ).trim();
    if (nextEmail && !nextPwd) {
      data.workEmailPassword = generateWorkEmailPassword();
    }
  }
  if ('location' in params && !('locationId' in params)) {
    data.location = String(params.location);
  }
  if ('locationId' in params) {
    let nextLocationId = params.locationId ? String(params.locationId) : null;
    if (hrScope) nextLocationId = hrScope;
    const locData = await applyEmployeeLocation(nextLocationId);
    data.locationId = locData.locationId;
    data.location = locData.location;
  }
  if ('active' in params) {
    // Archive/restore endpoints are the primary path; this keeps the legacy
    // update path consistent so archived employees always carry metadata.
    const nextActive = params.active === true || params.active === 'true';
    data.active = nextActive;
    if (!nextActive) {
      if (!existing.archivedAt) data.archivedAt = new Date();
      if (!existing.archiveReason) data.archiveReason = 'Archived via update';
    } else if (!existing.active) {
      data.departureDate = null;
    }
  }
  if ('biotimeDeviceId' in params) {
    data.biotimeDeviceId = params.biotimeDeviceId ? String(params.biotimeDeviceId) : null;
  }
  if ('jobTitle' in params) data.jobTitle = String(params.jobTitle ?? '');
  if ('managerId' in params) {
    const raw = params.managerId;
    const nextManagerId =
      raw === null ||
      raw === false ||
      raw === '' ||
      String(raw).trim() === '' ||
      String(raw) === 'false'
        ? null
        : String(raw).trim();
    if (nextManagerId) {
      if (nextManagerId === id) {
        jsonRpcSuccess(
          res,
          biotimeFail('لا يمكن تعيين الموظف مديرًا لنفسه', 'VALIDATION'),
          req.rpcId,
        );
        return;
      }
      const manager = await prisma.employeeProfile.findUnique({
        where: { id: nextManagerId },
        select: { id: true, active: true, archivedAt: true },
      });
      if (!manager || !manager.active || manager.archivedAt) {
        jsonRpcSuccess(
          res,
          biotimeFail('المدير المباشر غير موجود أو غير نشط', 'NOT_FOUND'),
          req.rpcId,
        );
        return;
      }
      const { wouldCreateManagerCycle } = await import('../../services/orgChart.service');
      if (await wouldCreateManagerCycle(id, nextManagerId)) {
        jsonRpcSuccess(
          res,
          biotimeFail('تعيين هذا المدير ينشئ حلقة في الهيكل التنظيمي', 'VALIDATION'),
          req.rpcId,
        );
        return;
      }
    }
    data.managerId = nextManagerId;
  }
  if ('insuranceSalary' in params) data.insuranceSalary = Number(params.insuranceSalary);
  if ('medicalInsuranceSalary' in params) data.medicalInsuranceSalary = Number(params.medicalInsuranceSalary);
  Object.assign(
    data,
    parseEmployeeCustomUpdate(params, { existingIsForeigner: existing.isForeigner === true }),
  );

  const nextMisr = 'misrAccount' in data ? Boolean(data.misrAccount) : existing.misrAccount;
  const nextIban = 'bankIban' in data ? data.bankIban : existing.bankIban;
  const ibanCheck = validateEgyptianIban(nextIban, nextMisr);
  if (!ibanCheck.valid) {
    jsonRpcSuccess(res, biotimeFail(ibanCheck.error ?? 'رقم IBAN غير صالح', 'VALIDATION'), req.rpcId);
    return;
  }
  if ('bankIban' in data || nextMisr !== existing.misrAccount) {
    data.bankIban = ibanCheck.normalized;
  }

  if (markBioTimeDirty) {
    data.biotimeSynced = false;
  }

  let employee = await prisma.employeeProfile.update({
    where: { id },
    data,
    include: { department: true, mapping: true, workLocation: true, manager: true },
  });

  if (Array.isArray(params.custodies)) {
    const items = (params.custodies as unknown[])
      .map((row) => {
        const m = row as Record<string, unknown>;
        return {
          custodyTypeId: String(m.custodyTypeId ?? m.id ?? ''),
          provided: m.provided === true || m.provided === 'true',
        };
      })
      .filter((row) => row.custodyTypeId);
    await syncEmployeeCustodies(id, items);
    employee = await prisma.employeeProfile.findUniqueOrThrow({
      where: { id },
      include: { department: true, mapping: true, workLocation: true, manager: true },
    });
  }

  if (pushToBiotime && config.autoPushToBiotime) {
    await pushEmployeeToBioTime(id);
    employee = await prisma.employeeProfile.findUniqueOrThrow({
      where: { id },
      include: { department: true, mapping: true, workLocation: true, manager: true },
    });
  }

  const beforeSnap: Record<string, unknown> = {};
  const afterSnap: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    const b = (existing as Record<string, unknown>)[key];
    beforeSnap[key] = b instanceof Date ? b.toISOString() : b;
    const a = (employee as Record<string, unknown>)[key];
    afterSnap[key] = a instanceof Date ? a.toISOString() : (a ?? data[key]);
  }
  await writeAudit({
    req,
    module: 'employees',
    action: 'employees.update',
    entityType: 'EmployeeProfile',
    entityId: id,
    summary: `تعديل موظف: ${employee.name || id}`,
    diffPreview: shallowFieldDiffs(beforeSnap, afterSnap, {
      entityId: id,
      entityLabel: employee.name,
      keys: Object.keys(data),
    }),
    route: '/employees/update',
  });

  // Keep app login in sync with work email credentials (EMPLOYEE self-service).
  // Never fail the employee save if login sync breaks (unique/login edge cases).
  if (
    'workEmail' in data ||
    'workEmailPassword' in data ||
    'active' in data ||
    'name' in data ||
    'displayName' in data ||
    'locationId' in data
  ) {
    try {
      await syncEmployeeLoginFromWorkEmail(id);
    } catch (err) {
      // Profile row is already saved; surface sync issues in logs only.
      const { logger } = await import('../../utils/logger');
      logger.warn({ err, employeeId: id }, 'syncEmployeeLoginFromWorkEmail failed after update');
    }
  }

  jsonRpcSuccess(res, biotimeOk({
    employee: {
      ...employeeJson(employee, true),
      custodies: await listEmployeeCustodies(id),
    },
  }), req.rpcId);
}));

export default router;
