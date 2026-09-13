import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrOrBranchManager, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { loadShiftGridForAccess, shiftGridPayload } from './shift-grid-helpers';
import { AppError, ForbiddenError } from '../../utils/errors';
import { getHrLocationScopeFromReq } from '../../services/userLocationScope.service';
import {
  findMergeCandidates,
  mergeShiftGrids,
  parseMergeConflictStrategy,
  previewShiftGridMerge,
} from '../../services/shiftGridMerge.service';

const router = Router();

/** Optional payroll period; both ends must be given together. */
function periodRange(params: Record<string, unknown>): { periodFrom?: Date; periodTo?: Date } {
  const rawFrom = params.periodFrom ?? params.dateFrom;
  const rawTo = params.periodTo ?? params.dateTo;
  if (rawFrom == null && rawTo == null) return {};
  if (rawFrom == null || rawTo == null) {
    throw new AppError('لازم تحدد بداية ونهاية الفترة مع بعض', 400, 'VALIDATION');
  }
  const periodFrom = new Date(String(rawFrom));
  const periodTo = new Date(String(rawTo));
  if (Number.isNaN(periodFrom.getTime()) || Number.isNaN(periodTo.getTime())) {
    throw new AppError('تاريخ غير صالح', 400, 'VALIDATION');
  }
  return { periodFrom, periodTo };
}

function sourceGridIds(params: Record<string, unknown>): string[] {
  const raw = params.sourceGridIds ?? params.gridIds;
  if (!Array.isArray(raw)) {
    throw new AppError('لازم تبعت قائمة الجداول المطلوب دمجها', 400, 'VALIDATION');
  }
  return raw.map((id) => String(id ?? '').trim()).filter(Boolean);
}

/** Grids inside the current payroll month: available weeks, consumed weeks, monthly targets. */
router.post('/shift-grid/merge/candidates', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const reference = params.reference ? new Date(String(params.reference)) : undefined;
  if (reference && Number.isNaN(reference.getTime())) {
    throw new AppError('تاريخ غير صالح', 400, 'VALIDATION');
  }
  // A location-scoped user must not learn about other branches' grids, and this
  // path queries directly rather than going through per-grid access checks.
  const scope = await getHrLocationScopeFromReq(req);
  const requested = params.locationId == null ? undefined : String(params.locationId);
  if (scope && requested && requested !== scope) {
    throw new ForbiddenError('Access denied for this location', 'ACCESS_DENIED');
  }
  const result = await findMergeCandidates({
    reference,
    monthStartDay: params.monthStartDay == null ? undefined : Number(params.monthStartDay),
    locationId: scope ?? requested,
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

/** Dry run, so overlaps and uncovered days are visible before anything is written. */
router.post('/shift-grid/merge/preview', requireAuth, requireHrOrBranchManager, asyncHandler(async (req, res) => {
  const params = p(req);
  const ids = sourceGridIds(params);
  for (const id of ids) {
    await loadShiftGridForAccess(req, id);
  }
  const targetGridId = params.targetGridId == null ? undefined : String(params.targetGridId).trim();
  if (targetGridId) await loadShiftGridForAccess(req, targetGridId);
  const result = await previewShiftGridMerge({
    sourceGridIds: ids,
    targetGridId: targetGridId || undefined,
    ...periodRange(params),
  });
  jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
}));

router.post('/shift-grid/merge', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const ids = sourceGridIds(params);
  for (const id of ids) {
    await loadShiftGridForAccess(req, id);
  }
  const targetGridId = params.targetGridId == null ? undefined : String(params.targetGridId).trim();
  if (targetGridId) await loadShiftGridForAccess(req, targetGridId);
  const result = await mergeShiftGrids({
    sourceGridIds: ids,
    targetGridId: targetGridId || undefined,
    name: params.name == null ? undefined : String(params.name),
    conflictStrategy: parseMergeConflictStrategy(params.conflictStrategy),
    state: params.confirm === true ? 'confirmed' : 'grid',
    ...periodRange(params),
  });
  const payload = await shiftGridPayload(result.gridId, { includeData: false, req });
  jsonRpcSuccess(res, biotimeOk({ ...result, ...payload }), req.rpcId);
}));

export default router;
