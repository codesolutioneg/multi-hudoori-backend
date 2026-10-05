import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../middlewares/asyncHandler';
import { createSalesRequest } from '../services/salesRequest.service';
import { listPublishedPlans } from '../services/subscriptionPlan.service';
import { AppError } from '../utils/errors';

const router = Router();

const publicWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests', error_code: 'RATE_LIMIT' },
});

function mapError(err: unknown) {
  if (err instanceof AppError) {
    return { status: err.statusCode >= 500 ? 500 : 400, message: err.message, error_code: err.errorCode };
  }
  const e = err as { message?: string; errorCode?: string };
  if (e?.errorCode) {
    return { status: 400, message: e.message ?? 'Validation error', error_code: e.errorCode };
  }
  return { status: 500, message: 'Internal server error', error_code: 'SERVER_ERROR' };
}

/** GET /api/public/plans — published packages for the landing page */
router.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    const plans = await listPublishedPlans();
    res.json({ success: true, data: { plans } });
  }),
);

/** POST /api/public/sales-requests — contact sales form */
router.post(
  '/sales-requests',
  publicWriteLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const row = await createSalesRequest({
        companyCode: String(body.companyCode ?? ''),
        companyName: String(body.companyName ?? ''),
        contactName: String(body.contactName ?? ''),
        email: String(body.email ?? ''),
        phone: String(body.phone ?? ''),
        requestedEmployees: Number(body.requestedEmployees ?? 0),
        planId: body.planId != null ? String(body.planId) : null,
        notes: body.notes != null ? String(body.notes) : null,
      });
      res.status(201).json({
        success: true,
        message: 'تم استلام طلبك — سنتواصل معك بعد المراجعة.',
        data: { id: row.id },
      });
    } catch (err) {
      const mapped = mapError(err);
      res.status(mapped.status).json({ success: false, message: mapped.message, error_code: mapped.error_code });
    }
  }),
);

export default router;
