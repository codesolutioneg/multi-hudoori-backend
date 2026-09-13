import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk } from '../../middlewares/jsonRpc';
import { requireAuth } from '../../middlewares/auth';
import { p } from './route-helpers';
import {
  assertCanViewAudit,
  exportAuditLogXlsx,
  getAuditLog,
  listAuditLogs,
} from '../../services/auditLog.service';
import { parsePagination, paginationMeta } from '../../utils/pagination';

const router = Router();

router.post('/audit/list', requireAuth, asyncHandler(async (req, res) => {
  await assertCanViewAudit(req);
  const params = p(req);
  const { limit, offset } = parsePagination(params, { limit: 40, maxLimit: 100 });
  const result = await listAuditLogs({
    dateFrom: params.dateFrom ? String(params.dateFrom) : undefined,
    dateTo: params.dateTo ? String(params.dateTo) : undefined,
    module: params.module ? String(params.module) : undefined,
    action: params.action ? String(params.action) : undefined,
    actorId: params.actorId ? String(params.actorId) : undefined,
    search: params.search ? String(params.search) : undefined,
    limit,
    offset,
  });
  jsonRpcSuccess(
    res,
    biotimeOk({
      ...result,
      ...paginationMeta(result.total, result.limit, result.offset, Math.floor(result.offset / result.limit) + 1),
    }),
    req.rpcId,
  );
}));

router.post('/audit/get', requireAuth, asyncHandler(async (req, res) => {
  await assertCanViewAudit(req);
  const id = String(p(req).id ?? p(req).auditId ?? '');
  const item = await getAuditLog(id);
  jsonRpcSuccess(res, biotimeOk({ item }), req.rpcId);
}));

router.post('/audit/export-xlsx', requireAuth, asyncHandler(async (req, res) => {
  await assertCanViewAudit(req);
  const id = String(p(req).id ?? p(req).auditId ?? '');
  const file = await exportAuditLogXlsx(id);
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

export default router;
