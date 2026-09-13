import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { applyEmployeeLocation, employeesForLocation, resolveLocation, relocateEmployeesToGridLocation, } from '../../services/location.service';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { generateUniqueEmployeeCode, isValidEmployeeCode } from '../../services/employeeCode.service';
import { parseEgyptianNationalId, validateEgyptianNationalId } from '../../utils/egyptianNationalId';
import { prisma } from '../../prisma/client';
import { pushEmployeeToBioTime } from '../../services/biotime/employeePush.service';
import { writeAudit } from '../../services/auditLog.service';

const router = Router();

router.post('/employees/create', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const name = String(params.name ?? '').trim();
  let code = String(params.identificationId ?? params.code ?? '').trim();
  const pushToBiotime = params.pushToBiotime === true;
  const workPhone = params.workPhone != null ? String(params.workPhone).trim() : '';
  const nationalIdRaw = String(params.nationalIdConfirm ?? params.nationalId ?? '').trim();

  if (!name || name.length < 2) {
    jsonRpcSuccess(res, biotimeFail('الاسم مطلوب (حرفان على الأقل)', 'VALIDATION'), req.rpcId);
    return;
  }

  const isForeigner =
    params.isForeigner === true ||
    params.isForeigner === 'true' ||
    String(params.isForeigner ?? '').trim().toLowerCase() === 'yes';

  let nationalId: string | null = null;
  let birthday: Date | null = null;
  let gender: string | null = null;
  if (nationalIdRaw) {
    if (isForeigner) {
      nationalId = nationalIdRaw;
    } else {
      const nidError = validateEgyptianNationalId(nationalIdRaw);
      if (nidError) {
        jsonRpcSuccess(res, biotimeFail(nidError, 'VALIDATION'), req.rpcId);
        return;
      }
      const parsedNid = parseEgyptianNationalId(nationalIdRaw);
      nationalId = parsedNid.nationalId;
      birthday = parsedNid.birthDate;
      const genderDigit = Number(nationalId[12]);
      gender = Number.isNaN(genderDigit) ? null : (genderDigit % 2 === 1 ? 'male' : 'female');
    }

    const duplicateNid = await prisma.employeeProfile.findFirst({
      where: { nationalIdConfirm: nationalId },
    });
    if (duplicateNid) {
      jsonRpcSuccess(res, biotimeFail('الرقم القومي مستخدم بالفعل لموظف آخر', 'DUPLICATE'), req.rpcId);
      return;
    }
  }

  let basicSalary = 0;
  if (params.basicSalary != null && params.basicSalary !== '') {
    basicSalary = Number(params.basicSalary);
    if (Number.isNaN(basicSalary) || basicSalary < 0) {
      jsonRpcSuccess(res, biotimeFail('الراتب غير صالح', 'VALIDATION'), req.rpcId);
      return;
    }
  }

  if (!code) {
    code = await generateUniqueEmployeeCode(name);
  } else if (!isValidEmployeeCode(code)) {
    jsonRpcSuccess(res, biotimeFail('كود البصمة: أحرف إنجليزية وأرقام و _ - فقط', 'VALIDATION'), req.rpcId);
    return;
  }
  if (workPhone && workPhone.length < 8) {
    jsonRpcSuccess(res, biotimeFail('رقم الهاتف قصير جداً', 'VALIDATION'), req.rpcId);
    return;
  }

  const duplicate = await prisma.employeeProfile.findFirst({ where: { code } });
  if (duplicate) {
    jsonRpcSuccess(res, biotimeFail(`الكود ${code} مستخدم بالفعل`, 'DUPLICATE'), req.rpcId);
    return;
  }

  let departmentId: string | null = null;
  if (params.departmentId) {
    departmentId = String(params.departmentId);
    const dept = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!dept) {
      jsonRpcSuccess(res, biotimeFail('القسم غير موجود', 'VALIDATION'), req.rpcId);
      return;
    }
  }

  let jobTitle: string | null = null;
  if (params.jobTitle != null && String(params.jobTitle).trim()) {
    jobTitle = String(params.jobTitle).trim();
    const known = await prisma.jobTitle.findFirst({
      where: { name: { equals: jobTitle, mode: 'insensitive' }, active: true },
    });
    if (known) jobTitle = known.name;
  }

  const hrScope = await getHrLocationScopeFromReq(req);
  let locationId: string | null = params.locationId ? String(params.locationId) : null;
  if (hrScope) {
    locationId = hrScope;
  }
  const locData = await applyEmployeeLocation(locationId);

  let employee = await prisma.employeeProfile.create({
    data: {
      name,
      displayName: name,
      code,
      identificationId: code,
      barcode: code,
      departmentId,
      jobTitle,
      locationId: locData.locationId,
      location: locData.location || null,
      workPhone: workPhone || null,
      nationalIdConfirm: nationalId,
      birthday,
      isForeigner,
      basicSalary,
      gender,
      biotimeSynced: false,
      active: true,
    },
    include: { department: true, mapping: true },
  });

  if (pushToBiotime) {
    try {
      await pushEmployeeToBioTime(employee.id);
      employee = await prisma.employeeProfile.findUniqueOrThrow({
        where: { id: employee.id },
        include: { department: true, mapping: true, workLocation: true },
      });
    } catch (err) {
      await writeAudit({
        req,
        module: 'employees',
        action: 'employees.create',
        entityType: 'EmployeeProfile',
        entityId: employee.id,
        summary: `إنشاء موظف: ${employee.name || employee.id}`,
        payload: { code, pushFailed: true },
        route: '/employees/create',
      });
      jsonRpcSuccess(
        res,
        biotimeOk({
          employee: employeeJson(employee, true),
          message: `تم إنشاء الموظف — فشل الرفع إلى BioTime: ${err instanceof Error ? err.message : 'خطأ'}`,
          pushFailed: true,
        }),
        req.rpcId,
      );
      return;
    }
  }

  await writeAudit({
    req,
    module: 'employees',
    action: 'employees.create',
    entityType: 'EmployeeProfile',
    entityId: employee.id,
    summary: `إنشاء موظف: ${employee.name || employee.id}`,
    payload: { code, pushToBiotime: Boolean(pushToBiotime) },
    route: '/employees/create',
  });

  jsonRpcSuccess(
    res,
    biotimeOk({
      employee: employeeJson(employee, true),
      generatedCode: code,
      message: pushToBiotime
        ? `تم إنشاء الموظف (${code}) ورفعه إلى BioTime`
        : `تم إنشاء الموظف — الكود: ${code}`,
    }),
    req.rpcId,
  );
}));

export default router;
