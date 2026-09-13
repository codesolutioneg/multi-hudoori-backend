import { PrismaClient } from '@prisma/client';
import { withTenantExtension } from '../tenant/prismaExtension';

const globalForPrisma = globalThis as unknown as {
  prismaBase?: PrismaClient;
  prisma?: any;
};

const base =
  globalForPrisma.prismaBase ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

/**
 * Tenant-scoped client. Runtime extension injects companyId on reads/writes.
 * Typed as `any` so existing create payloads (copied from single-tenant Dev)
 * compile while the extension supplies companyId — business formulas untouched.
 */
export const prisma: any = globalForPrisma.prisma ?? withTenantExtension(base);

/** Unscoped client for platform-only operations (company CRUD, auth token lookup). */
export const prismaBase = base;

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prismaBase = base;
  globalForPrisma.prisma = prisma;
}
