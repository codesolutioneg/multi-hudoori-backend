import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { jobTitleJson, syncJobTitlesFromEmployees } from '../../services/jobTitle.service';
import { generateJobTitleCode } from '../../services/settingsCode.service';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/job-titles/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  if (params.syncFromEmployees === true || params.syncFromEmployees === 'true') {
    await syncJobTitlesFromEmployees();
  }
  const activeOnly = params.activeOnly !== false && params.activeOnly !== 'false';
  const titles = await prisma.jobTitle.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
  });
  jsonRpcSuccess(
    res,
    biotimeOk({ titles: titles.map(jobTitleJson), count: titles.length }),
    req.rpcId,
  );
}));

router.post('/job-titles/sync-from-employees', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const created = await syncJobTitlesFromEmployees();
  const titles = await prisma.jobTitle.findMany({
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
  });
  jsonRpcSuccess(
    res,
    biotimeOk({
      created,
      message: created > 0 ? `تمت إضافة ${created} مسمى وظيفي من الموظفين` : 'كل المسميات موجودة بالفعل',
      titles: titles.map(jobTitleJson),
      count: titles.length,
    }),
    req.rpcId,
  );
}));

router.post('/job-titles/create', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const name = String(params.name ?? '').trim();
  if (!name) {
    jsonRpcSuccess(res, biotimeFail('اسم الوظيفة مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  const dupName = await prisma.jobTitle.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
  });
  if (dupName) {
    jsonRpcSuccess(res, biotimeFail(`الوظيفة "${name}" موجودة بالفعل`, 'DUPLICATE'), req.rpcId);
    return;
  }
  let code = params.code ? String(params.code).trim().toUpperCase() : '';
  if (!code) code = await generateJobTitleCode();
  const dup = await prisma.jobTitle.findFirst({ where: { code } });
  if (dup) {
    jsonRpcSuccess(res, biotimeFail(`كود "${code}" موجود`, 'DUPLICATE'), req.rpcId);
    return;
  }
  const row = await prisma.jobTitle.create({
    data: {
      name,
      code,
      active: params.active !== false && params.active !== 'false',
      sequence: Number(params.sequence ?? 10),
    },
  });
  jsonRpcSuccess(res, biotimeOk({ title: jobTitleJson(row) }), req.rpcId);
}));

router.post('/job-titles/update', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.titleId ?? '');
  if (params.name != null) {
    const name = String(params.name).trim();
    const dupName = await prisma.jobTitle.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, NOT: { id } },
    });
    if (dupName) {
      jsonRpcSuccess(res, biotimeFail(`الوظيفة "${name}" موجودة بالفعل`, 'DUPLICATE'), req.rpcId);
      return;
    }
  }
  if (params.code != null) {
    const code = String(params.code).trim().toUpperCase();
    const dup = await prisma.jobTitle.findFirst({ where: { code, NOT: { id } } });
    if (dup) {
      jsonRpcSuccess(res, biotimeFail(`كود "${code}" موجود`, 'DUPLICATE'), req.rpcId);
      return;
    }
  }
  const row = await prisma.jobTitle.update({
    where: { id },
    data: {
      name: params.name != null ? String(params.name).trim() : undefined,
      code: params.code !== undefined ? (params.code ? String(params.code).trim().toUpperCase() : null) : undefined,
      active: params.active !== undefined ? params.active === true || params.active === 'true' : undefined,
      sequence: params.sequence != null ? Number(params.sequence) : undefined,
    },
  });
  jsonRpcSuccess(res, biotimeOk({ title: jobTitleJson(row) }), req.rpcId);
}));

router.post('/job-titles/delete', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).titleId ?? '');
  const row = await prisma.jobTitle.findUnique({ where: { id } });
  if (!row) {
    jsonRpcSuccess(res, biotimeFail('الوظيفة غير موجودة', 'NOT_FOUND'), req.rpcId);
    return;
  }
  const inUse = await prisma.employeeProfile.count({
    where: { jobTitle: { equals: row.name, mode: 'insensitive' } },
  });
  if (inUse > 0) {
    jsonRpcSuccess(
      res,
      biotimeFail(`الوظيفة مستخدمة على ${inUse} موظف — عطّلها بدل الحذف`, 'IN_USE'),
      req.rpcId,
    );
    return;
  }
  await prisma.jobTitle.delete({ where: { id } });
  jsonRpcSuccess(res, biotimeOk({ message: 'Deleted' }), req.rpcId);
}));

export default router;
