/**
 * «مدير الفرع» settings — who signs off advance requests for each branch.
 *
 * Reading is open to HR so the advance screens can explain who a request is
 * waiting on; only an HR manager may change a designation.
 */
import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { prisma } from '../../prisma/client';
import { writeAudit } from '../../services/auditLog.service';
import {
  branchManagerJson,
  resolveBranchManager,
} from '../../services/branchManager.service';

const router = Router();

router.post('/branch-managers/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const locations = await prisma.location.findMany({
    where: { active: true },
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, code: true, managerEmployeeId: true },
  });

  const branches = await Promise.all(
    locations.map(async (loc) => ({
      locationId: loc.id,
      locationName: loc.name,
      locationCode: loc.code,
      manager: branchManagerJson(await resolveBranchManager(loc.id)),
    })),
  );

  jsonRpcSuccess(res, biotimeOk({ branches }), req.rpcId);
}));

/** Pass a null `employeeId` to clear the choice and fall back to the org chart. */
router.post('/branch-managers/set', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const locationId = String(params.locationId ?? '');
  const employeeId = params.employeeId != null && String(params.employeeId).length
    ? String(params.employeeId)
    : null;

  const location = await prisma.location.findUnique({ where: { id: locationId } });
  if (!location) {
    jsonRpcSuccess(res, biotimeFail('الفرع غير موجود', 'NOT_FOUND'), req.rpcId);
    return;
  }

  if (employeeId) {
    const employee = await prisma.employeeProfile.findUnique({
      where: { id: employeeId },
      select: { id: true, name: true, active: true, locationId: true, userId: true },
    });
    if (!employee) {
      jsonRpcSuccess(res, biotimeFail('الموظف غير موجود', 'NOT_FOUND'), req.rpcId);
      return;
    }
    if (!employee.active) {
      jsonRpcSuccess(res, biotimeFail('الموظف غير نشط', 'ACTION_ERROR'), req.rpcId);
      return;
    }
    // A manager from another branch would be approving requests for people they
    // do not work with, and would see that branch's queue.
    if (employee.locationId !== locationId) {
      jsonRpcSuccess(
        res,
        biotimeFail('اختر موظفًا من نفس الفرع', 'VALIDATION_ERROR'),
        req.rpcId,
      );
      return;
    }
  }

  await prisma.location.update({
    where: { id: locationId },
    data: { managerEmployeeId: employeeId },
  });

  const resolved = await resolveBranchManager(locationId);
  await writeAudit({
    req,
    module: 'settings',
    action: 'branch_manager.set',
    entityType: 'Location',
    entityId: locationId,
    summary: employeeId
      ? `تعيين ${resolved?.employeeName ?? employeeId} مديرًا لفرع ${location.name}`
      : `إلغاء تحديد مدير فرع ${location.name}`,
  });

  jsonRpcSuccess(
    res,
    biotimeOk({ locationId, manager: branchManagerJson(resolved) }),
    req.rpcId,
  );
}));

export default router;
