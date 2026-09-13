/**
 * PostgreSQL RLS helpers.
 *
 * Policies are enabled with FORCE ROW LEVEL SECURITY. They allow all rows when
 * `app.company_id` is NULL/empty, and filter when it is set.
 *
 * IMPORTANT: Prisma uses a connection pool. Calling set_config on one checkout
 * does NOT apply to the next query on a different connection. Therefore the
 * request path relies on the Prisma tenant extension (ALS), not session RLS.
 *
 * Use `withTenantRls` for same-connection checks (tests / scripts).
 */
import type { Request, Response, NextFunction } from 'express';
import { prismaBase } from '../prisma/client';

/** Best-effort clear of a leaked session var on whatever connection we get. */
export async function clearPostgresTenantSetting(): Promise<void> {
  await prismaBase.$executeRawUnsafe(`SELECT set_config('app.company_id', '', false)`);
}

/** Clears RLS session var when the response completes (pool hygiene). */
export function clearTenantSettingOnFinish(_req: Request, res: Response, next: NextFunction): void {
  const done = () => {
    void clearPostgresTenantSetting().catch(() => undefined);
  };
  res.on('finish', done);
  res.on('close', done);
  next();
}

/**
 * Run `fn` inside a transaction with SET LOCAL app.company_id so RLS applies
 * on the same connection as the queries.
 */
export async function withTenantRls<T>(
  companyId: string | null,
  fn: (tx: Parameters<Parameters<typeof prismaBase.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prismaBase.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.company_id', $1, true)`,
      companyId ?? '',
    );
    return fn(tx);
  });
}
