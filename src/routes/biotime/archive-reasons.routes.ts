import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { prisma } from '../../prisma/client';

const router = Router();

function archiveReasonJson(row: {
  id: string;
  name: string;
  active: boolean;
  sequence: number;
}) {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    sequence: row.sequence,
  };
}

router.post('/archive-reasons/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const activeOnly = params.activeOnly !== false && params.activeOnly !== 'false';
  const reasons = await prisma.archiveReason.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
  });
  jsonRpcSuccess(
    res,
    biotimeOk({ reasons: reasons.map(archiveReasonJson), count: reasons.length }),
    req.rpcId,
  );
}));

router.post('/archive-reasons/create', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const name = String(params.name ?? '').trim();
  if (!name) {
    jsonRpcSuccess(res, biotimeFail('سبب الأرشفة مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  const dup = await prisma.archiveReason.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
  });
  if (dup) {
    jsonRpcSuccess(res, biotimeFail(`السبب "${name}" موجود بالفعل`, 'DUPLICATE'), req.rpcId);
    return;
  }
  const row = await prisma.archiveReason.create({
    data: {
      name,
      active: params.active !== false && params.active !== 'false',
      sequence: Number(params.sequence ?? 10),
    },
  });
  jsonRpcSuccess(res, biotimeOk({ reason: archiveReasonJson(row) }), req.rpcId);
}));

router.post('/archive-reasons/update', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.reasonId ?? '');
  if (!id) {
    jsonRpcSuccess(res, biotimeFail('المعرّف مطلوب', 'VALIDATION'), req.rpcId);
    return;
  }
  if (params.name != null) {
    const name = String(params.name).trim();
    const dup = await prisma.archiveReason.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, NOT: { id } },
    });
    if (dup) {
      jsonRpcSuccess(res, biotimeFail(`السبب "${name}" موجود بالفعل`, 'DUPLICATE'), req.rpcId);
      return;
    }
  }
  const row = await prisma.archiveReason.update({
    where: { id },
    data: {
      name: params.name != null ? String(params.name).trim() : undefined,
      active: params.active !== undefined ? params.active === true || params.active === 'true' : undefined,
      sequence: params.sequence != null ? Number(params.sequence) : undefined,
    },
  });
  jsonRpcSuccess(res, biotimeOk({ reason: archiveReasonJson(row) }), req.rpcId);
}));

router.post('/archive-reasons/delete', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? p(req).reasonId ?? '');
  const row = await prisma.archiveReason.findUnique({ where: { id } });
  if (!row) {
    jsonRpcSuccess(res, biotimeFail('السبب غير موجود', 'NOT_FOUND'), req.rpcId);
    return;
  }
  await prisma.archiveReason.delete({ where: { id } });
  jsonRpcSuccess(res, biotimeOk({ message: 'Deleted' }), req.rpcId);
}));

export default router;
