import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { generateDepartmentCode, generateInsuranceCompanyCode, generateLocationCode, generateCustodyTypeCode, } from '../../services/settingsCode.service';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/insurance-companies/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const activeOnly = params.activeOnly !== false && params.activeOnly !== 'false';
  const companies = await prisma.insuranceCompany.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
  });
  jsonRpcSuccess(
    res,
    biotimeOk({ companies: companies.map(insuranceCompanyJson), count: companies.length }),
    req.rpcId,
  );
}));

router.post('/insurance-companies/create', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const name = String(params.name ?? '').trim();
  if (!name) {
    jsonRpcSuccess(res, biotimeFail('اسم شركة التأمين مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  let code = params.code ? String(params.code).trim() : '';
  if (!code) code = await generateInsuranceCompanyCode();
  const dup = await prisma.insuranceCompany.findFirst({ where: { code } });
  if (dup) {
    jsonRpcSuccess(res, biotimeFail(`كود "${code}" موجود`, 'DUPLICATE'), req.rpcId);
    return;
  }
  const company = await prisma.insuranceCompany.create({
    data: {
      name,
      code,
      active: params.active !== false && params.active !== 'false',
      sequence: Number(params.sequence ?? 10),
    },
  });
  jsonRpcSuccess(res, biotimeOk({ company: insuranceCompanyJson(company) }), req.rpcId);
}));

router.post('/insurance-companies/update', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.companyId ?? '');
  if (params.code != null) {
    const code = String(params.code).trim();
    const dup = await prisma.insuranceCompany.findFirst({ where: { code, NOT: { id } } });
    if (dup) {
      jsonRpcSuccess(res, biotimeFail(`كود "${code}" موجود`, 'DUPLICATE'), req.rpcId);
      return;
    }
  }
  const company = await prisma.insuranceCompany.update({
    where: { id },
    data: {
      name: params.name != null ? String(params.name).trim() : undefined,
      code: params.code !== undefined ? (params.code ? String(params.code).trim() : null) : undefined,
      active: params.active !== undefined ? params.active === true || params.active === 'true' : undefined,
      sequence: params.sequence != null ? Number(params.sequence) : undefined,
    },
  });
  jsonRpcSuccess(res, biotimeOk({ company: insuranceCompanyJson(company) }), req.rpcId);
}));

router.post('/insurance-companies/delete', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).companyId ?? '');
  const inUse = await prisma.employeeProfile.count({
    where: { OR: [{ insuranceCompanyId: id }, { medicalInsuranceCompanyId: id }] },
  });
  if (inUse > 0) {
    jsonRpcSuccess(res, biotimeFail(`شركة التأمين مستخدمة من ${inUse} موظف`, 'IN_USE'), req.rpcId);
    return;
  }
  await prisma.insuranceCompany.delete({ where: { id } });
  jsonRpcSuccess(res, biotimeOk({ message: 'Deleted' }), req.rpcId);
}));

// --- Custody types (العهد) ---

export default router;
