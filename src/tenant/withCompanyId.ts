import { requireCompanyId } from '../tenant/context';

/**
 * Attach the active company to a Prisma create payload.
 * Runtime Prisma extension also injects companyId; this satisfies TypeScript
 * and keeps business field objects unchanged.
 */
export function withCompanyId<T extends Record<string, unknown>>(
  data: T,
): T & { companyId: string } {
  const existing = data.companyId;
  if (typeof existing === 'string' && existing.length > 0) {
    return data as T & { companyId: string };
  }
  return { ...data, companyId: requireCompanyId() };
}
