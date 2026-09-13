import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/shift-assignments/delete', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? '');
  await prisma.shiftAssignment.delete({ where: { id } });
  jsonRpcSuccess(res, biotimeOk({ message: 'Deleted' }), req.rpcId);
}));

export default router;
