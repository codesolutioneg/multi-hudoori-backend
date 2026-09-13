import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk } from '../../middlewares/jsonRpc';
import { requireAuth } from '../../middlewares/auth';
import { p } from './route-helpers';
import { assertCanViewAssistant } from '../../services/auditLog.service';
import { chatWithAssistant } from '../../services/assistant.service';
import { AppError } from '../../utils/errors';
import { presentedToken } from '../../middlewares/rateLimiter';

const router = Router();

const assistantLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `assistant:${presentedToken(req) ?? req.ip ?? 'anon'}`,
  message: {
    jsonrpc: '2.0',
    result: { success: false, message: 'طلبات كتير — استنى لحظة.', error_code: 'RATE_LIMIT' },
    id: null,
  },
});

const chatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  page: z.string().trim().max(200).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(20)
    .optional()
    .default([]),
});

router.post(
  '/assistant/chat',
  requireAuth,
  assistantLimiter,
  asyncHandler(async (req, res) => {
    await assertCanViewAssistant(req);
    const parsed = chatSchema.safeParse({
      message: p(req).message,
      page: p(req).page,
      history: p(req).history,
    });
    if (!parsed.success) {
      throw new AppError('السؤال غير صالح', 400, 'VALIDATION');
    }
    const result = await chatWithAssistant(parsed.data);
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  }),
);

export default router;
