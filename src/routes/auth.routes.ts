import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import { UserRole } from '@prisma/client';
import { prisma } from '../prisma/client';
import { asyncHandler } from '../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../middlewares/jsonRpc';
import { authLimiter } from '../middlewares/rateLimiter';
import * as authService from '../services/auth.service';
import { hashPassword } from '../services/auth.service';
import { sendPasswordResetLinkEmail } from '../services/mail.service';
import { validateLoginCredentials } from '../utils/loginValidation';
import { logger } from '../utils/logger';
import { config } from '../config';

const router = Router();

function params(req: { rpcParams?: Record<string, unknown> }) {
  return req.rpcParams ?? {};
}

function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

router.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const rawLogin = String(p.login ?? '');
    const rawPassword = String(p.password ?? '');
    const deviceInfo = String(p.device_info ?? p.deviceInfo ?? 'Hudoori App').slice(0, 255);

    const validated = validateLoginCredentials(rawLogin, rawPassword);
    if (!validated.ok) {
      jsonRpcSuccess(
        res,
        biotimeFail(validated.message, validated.code),
        req.rpcId,
      );
      return;
    }

    try {
      const companyCodeRaw = p.companyCode ?? p.company_code ?? p.company ?? null;
      const companyCode =
        companyCodeRaw != null && String(companyCodeRaw).trim() !== ''
          ? String(companyCodeRaw)
          : null;
      const data = await authService.login(
        validated.login,
        validated.password,
        deviceInfo,
        companyCode,
      );
      jsonRpcSuccess(
        res,
        { success: true, message: 'Login successful', data },
        req.rpcId,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Login failed';
      const code =
        e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string'
          ? (e as { code: string }).code
          : 'INVALID_CREDENTIALS';
      jsonRpcSuccess(res, biotimeFail(msg, code), req.rpcId);
    }
  }),
);

/** Public forgot-password: always returns a generic success message. */
router.post(
  '/forgot-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const raw = String(p.loginOrEmail ?? p.login ?? p.email ?? '').trim();
    const generic = {
      message:
        'إذا كان الحساب موجوداً وتم تكوين بريد إلكتروني، ستصلك رسالة برابط إعادة تعيين كلمة المرور.',
    };

    if (!raw || raw.length < 2) {
      jsonRpcSuccess(res, biotimeOk(generic), req.rpcId);
      return;
    }

    try {
      const user = await prisma.user.findFirst({
        where: {
          OR: [
            { login: { equals: raw, mode: 'insensitive' } },
            { email: { equals: raw, mode: 'insensitive' } },
          ],
          active: true,
          role: { not: UserRole.PLATFORM_ADMIN },
        },
      });

      if (user) {
        const rawToken = randomBytes(32).toString('base64url');
        const expires = new Date(Date.now() + 60 * 60 * 1000);
        await prisma.user.update({
          where: { id: user.id },
          data: {
            passwordResetToken: hashResetToken(rawToken),
            passwordResetExpires: expires,
          },
        });
        const base = config.appPublicUrl.replace(/\/$/, '');
        const resetUrl = `${base}/#/reset-password?token=${encodeURIComponent(rawToken)}`;
        const emailResult = await sendPasswordResetLinkEmail({
          name: user.name,
          login: user.login,
          email: user.email,
          resetUrl,
        });
        if (!emailResult.sent) {
          logger.warn(
            { userId: user.id, error: emailResult.error },
            'Forgot-password email not sent',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Forgot-password failed');
    }

    jsonRpcSuccess(res, biotimeOk(generic), req.rpcId);
  }),
);

/** Public: set a new password using the one-time reset token from email. */
router.post(
  '/reset-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const p = params(req);
    const token = String(p.token ?? '').trim();
    const password = String(p.password ?? p.newPassword ?? '');
    const confirm = String(p.confirmPassword ?? p.passwordConfirm ?? password);

    if (!token || token.length < 20) {
      jsonRpcSuccess(res, biotimeFail('رابط إعادة التعيين غير صالح', 'VALIDATION'), req.rpcId);
      return;
    }
    if (password.length < 6) {
      jsonRpcSuccess(res, biotimeFail('كلمة المرور قصيرة جداً (6 أحرف على الأقل)', 'VALIDATION'), req.rpcId);
      return;
    }
    if (password !== confirm) {
      jsonRpcSuccess(res, biotimeFail('تأكيد كلمة المرور غير مطابق', 'VALIDATION'), req.rpcId);
      return;
    }

    const tokenHash = hashResetToken(token);
    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: tokenHash,
        passwordResetExpires: { gt: new Date() },
        active: true,
      },
    });
    if (!user) {
      jsonRpcSuccess(
        res,
        biotimeFail('الرابط منتهي أو غير صالح — اطلب رابطاً جديداً', 'INVALID_TOKEN'),
        req.rpcId,
      );
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(password),
        initialPassword: null,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    jsonRpcSuccess(
      res,
      biotimeOk({ message: 'تم تعيين كلمة المرور بنجاح — يمكنك تسجيل الدخول الآن' }),
      req.rpcId,
    );
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const p = params(req);
    const token = String(p.token ?? req.headers.authorization?.replace('Bearer ', '') ?? '');
    if (token) await authService.logout(token);
    jsonRpcSuccess(res, biotimeOk({ message: 'Logged out' }), req.rpcId);
  }),
);

router.post(
  '/validate',
  asyncHandler(async (req, res) => {
    const p = params(req);
    const token = String(p.token ?? req.headers.authorization?.replace('Bearer ', '') ?? '');
    if (!token) {
      jsonRpcSuccess(res, biotimeFail('Token required', 'MISSING_TOKEN'), req.rpcId);
      return;
    }
    const valid = await authService.validateToken(token);
    jsonRpcSuccess(
      res,
      valid ? biotimeOk({ valid: true }) : biotimeFail('Invalid or expired token', 'INVALID_TOKEN'),
      req.rpcId,
    );
  }),
);

export default router;
