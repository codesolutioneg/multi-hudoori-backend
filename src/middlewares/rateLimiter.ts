import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { config } from '../config';
import { extractRequestToken } from '../utils/requestToken';

/**
 * Two layers, because neither alone is correct.
 *
 * The IP layer is the ceiling and cannot be bypassed: a caller controls their
 * token but not their source address. The token layer sits underneath it and
 * gives each authenticated user a fair share, so one busy HR user cannot spend
 * the whole budget of a branch that shares a single NAT egress address.
 *
 * Keying only by IP starves colleagues. Keying only by token is bypassable,
 * since this runs before authentication and an attacker can rotate a fake
 * token on every request to mint fresh buckets. Together they hold.
 */

function isHealthCheck(req: Request): boolean {
  // Uptime monitors must never be throttled.
  return req.path === '/api/health';
}

function ipKey(req: Request): string {
  return `ip:${req.ip ?? 'unknown'}`;
}

/**
 * The token a request presents, if any. Shares extractRequestToken with the auth
 * middleware so the two cannot disagree about where a token lives. Not verified
 * here: this runs before authentication, so the value only ever narrows a budget,
 * never widens one past the IP ceiling.
 *
 * Exported for testing.
 */
export function presentedToken(req: Request): string | null {
  return extractRequestToken(req);
}

/** Absolute ceiling per source address. Applies to everyone, authenticated or not. */
export const ipLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.ipMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  skip: isHealthCheck,
});

/** Fair share per token, so one user cannot drain a shared branch address. */
export const tokenLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  // ipLimiter already owns the RateLimit-* response headers; emitting them from
  // both layers would leave the client reading whichever ran last.
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => `t:${presentedToken(req)}`,
  // Unauthenticated traffic carries no token and is bounded by ipLimiter alone.
  skip: (req) => isHealthCheck(req) || presentedToken(req) === null,
});

/**
 * Login stays keyed by IP: this is the brute-force guard, and an attacker
 * guessing passwords has no token to be budgeted by.
 */
export const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
});
