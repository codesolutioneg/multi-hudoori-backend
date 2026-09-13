import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { custodyTypeJson } from '../../services/custodyType.service';
import { ensureDefaultCustodyTypes, listEmployeeCustodies, syncEmployeeCustodies, } from '../../services/employeeCustody.service';
import { generateDepartmentCode, generateInsuranceCompanyCode, generateLocationCode, generateCustodyTypeCode, } from '../../services/settingsCode.service';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/custody-types/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  await ensureDefaultCustodyTypes();
  const params = p(req);
  const activeOnly = params.activeOnly !== false && params.activeOnly !== 'false';
  const types = await prisma.custodyType.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
  });
  jsonRpcSuccess(
    res,
    biotimeOk({ types: types.map(custodyTypeJson), count: types.length }),
    req.rpcId,
  );
}));

router.post('/custody-types/create', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const name = String(params.name ?? '').trim();
  if (!name) {
    jsonRpcSuccess(res, biotimeFail('اسم العهدة مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  let code = params.code ? String(params.code).trim().toUpperCase() : '';
  if (!code) code = await generateCustodyTypeCode();
  const dup = await prisma.custodyType.findFirst({ where: { code } });
  if (dup) {
    jsonRpcSuccess(res, biotimeFail(`كود "${code}" موجود`, 'DUPLICATE'), req.rpcId);
    return;
  }
  const row = await prisma.custodyType.create({
    data: {
      name,
      code,
      active: params.active !== false && params.active !== 'false',
      sequence: Number(params.sequence ?? 10),
    },
  });
  jsonRpcSuccess(res, biotimeOk({ type: custodyTypeJson(row) }), req.rpcId);
}));

router.post('/custody-types/update', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.typeId ?? '');
  if (params.code != null) {
    const code = String(params.code).trim().toUpperCase();
    const dup = await prisma.custodyType.findFirst({ where: { code, NOT: { id } } });
    if (dup) {
      jsonRpcSuccess(res, biotimeFail(`كود "${code}" موجود`, 'DUPLICATE'), req.rpcId);
      return;
    }
  }
  const row = await prisma.custodyType.update({
    where: { id },
    data: {
      name: params.name != null ? String(params.name).trim() : undefined,
      code: params.code !== undefined ? (params.code ? String(params.code).trim().toUpperCase() : null) : undefined,
      active: params.active !== undefined ? params.active === true || params.active === 'true' : undefined,
      sequence: params.sequence != null ? Number(params.sequence) : undefined,
    },
  });
  jsonRpcSuccess(res, biotimeOk({ type: custodyTypeJson(row) }), req.rpcId);
}));

router.post('/custody-types/delete', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).typeId ?? '');
  const inUse = await prisma.employeeCustody.count({ where: { custodyTypeId: id, provided: true } });
  if (inUse > 0) {
    jsonRpcSuccess(res, biotimeFail(`العهدة مستخدمة من ${inUse} موظف`, 'IN_USE'), req.rpcId);
    return;
  }
  await prisma.employeeCustody.deleteMany({ where: { custodyTypeId: id } });
  await prisma.custodyType.delete({ where: { id } });
  jsonRpcSuccess(res, biotimeOk({ message: 'Deleted' }), req.rpcId);
}));

// --- Health certificate alerts ---

export default router;
