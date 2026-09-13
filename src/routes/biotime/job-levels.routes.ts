/**
 * «تدرج الوظائف» settings — the seniority ladder the org chart derives from.
 * Read is open to HR (the org chart page shows level badges); every write is
 * restricted to HR managers, like the rest of the settings screen.
 */
import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { writeAudit } from '../../services/auditLog.service';
import { AppError } from '../../utils/errors';
import {
  getJobLadder,
  createJobLevel,
  updateJobLevel,
  deleteJobLevel,
  reorderJobLevels,
  assignTitleToLevel,
} from '../../services/jobLevel.service';

const router = Router();

/** Runs `fn`, turning business errors into the JSON-RPC failure shape the UI reads. */
async function guard(
  res: Parameters<typeof jsonRpcSuccess>[0],
  rpcId: unknown,
  fn: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    if (err instanceof AppError) {
      jsonRpcSuccess(res, biotimeFail(err.message, err.errorCode), rpcId as never);
      return false;
    }
    throw err;
  }
}

router.post('/job-levels/list', requireAuth, requireHr, asyncHandler(async (req, res) => {
  jsonRpcSuccess(res, biotimeOk(await getJobLadder()), req.rpcId);
}));

router.post('/job-levels/create', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const ok = await guard(res, req.rpcId, async () => {
    const level = await createJobLevel({
      name: String(params.name ?? ''),
      nameEn: params.nameEn != null ? String(params.nameEn) : null,
      code: params.code != null ? String(params.code) : null,
    });
    await writeAudit({
      req,
      module: 'settings',
      action: 'job_levels.create',
      entityType: 'JobLevel',
      entityId: level.id,
      summary: `إضافة مستوى وظيفي: ${level.name}`,
      route: '/job-levels/create',
    });
  });
  if (ok) jsonRpcSuccess(res, biotimeOk(await getJobLadder()), req.rpcId);
}));

router.post('/job-levels/update', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? '');
  const ok = await guard(res, req.rpcId, async () => {
    await updateJobLevel({
      id,
      ...(params.name !== undefined ? { name: String(params.name) } : {}),
      ...(params.nameEn !== undefined ? { nameEn: params.nameEn != null ? String(params.nameEn) : null } : {}),
      ...(params.code !== undefined ? { code: params.code != null ? String(params.code) : null } : {}),
    });
    await writeAudit({
      req,
      module: 'settings',
      action: 'job_levels.update',
      entityType: 'JobLevel',
      entityId: id,
      summary: `تعديل مستوى وظيفي: ${params.name ?? id}`,
      route: '/job-levels/update',
    });
  });
  if (ok) jsonRpcSuccess(res, biotimeOk(await getJobLadder()), req.rpcId);
}));

router.post('/job-levels/delete', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? '');
  const ok = await guard(res, req.rpcId, async () => {
    await deleteJobLevel(id);
    await writeAudit({
      req,
      module: 'settings',
      action: 'job_levels.delete',
      entityType: 'JobLevel',
      entityId: id,
      summary: 'حذف مستوى وظيفي',
      route: '/job-levels/delete',
    });
  });
  if (ok) jsonRpcSuccess(res, biotimeOk(await getJobLadder()), req.rpcId);
}));

router.post('/job-levels/reorder', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const raw = p(req).orderedIds;
  const ids = Array.isArray(raw) ? raw.map((x) => String(x)) : [];
  const ok = await guard(res, req.rpcId, async () => {
    await reorderJobLevels(ids);
    await writeAudit({
      req,
      module: 'settings',
      action: 'job_levels.reorder',
      entityType: 'JobLevel',
      summary: `إعادة ترتيب تدرج الوظائف (${ids.length} مستوى)`,
      route: '/job-levels/reorder',
    });
  });
  if (ok) jsonRpcSuccess(res, biotimeOk(await getJobLadder()), req.rpcId);
}));

/** Drag a title onto a level, or pass levelId = null to take it off the ladder. */
router.post('/job-levels/assign-title', requireAuth, requireHrManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const jobTitleId = String(params.jobTitleId ?? '');
  const rawLevel = params.levelId;
  const levelId =
    rawLevel === null || rawLevel === false || rawLevel === '' || String(rawLevel ?? '') === 'false'
      ? null
      : String(rawLevel);

  const ok = await guard(res, req.rpcId, async () => {
    await assignTitleToLevel(jobTitleId, levelId);
    await writeAudit({
      req,
      module: 'settings',
      action: 'job_levels.assign_title',
      entityType: 'JobTitle',
      entityId: jobTitleId,
      summary: levelId ? 'نقل مسمى وظيفي إلى مستوى' : 'إزالة مسمى وظيفي من التدرج',
      payload: { jobTitleId, levelId },
      route: '/job-levels/assign-title',
    });
  });
  if (ok) jsonRpcSuccess(res, biotimeOk(await getJobLadder()), req.rpcId);
}));

export default router;
