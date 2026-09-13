import { PrismaClient } from '@prisma/client';
import {
  getCompanyId,
  modelRequiresCompany,
  OPTIONAL_COMPANY_MODELS,
  PLATFORM_MODELS,
} from './context';

type AnyArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

function andWhere(where: Record<string, unknown> | undefined, companyId: string): Record<string, unknown> {
  if (!where || Object.keys(where).length === 0) return { companyId };
  if (where.companyId !== undefined) return where;
  return { AND: [where, { companyId }] };
}

function injectCreateData(
  data: Record<string, unknown> | Record<string, unknown>[] | undefined,
  companyId: string,
): Record<string, unknown> | Record<string, unknown>[] | undefined {
  if (!data) return data;
  if (Array.isArray(data)) {
    return data.map((row) => (row.companyId !== undefined ? row : { ...row, companyId }));
  }
  if (data.companyId !== undefined) return data;
  return { ...data, companyId };
}

function rowCompanyId(row: unknown): string | null | undefined {
  if (!row || typeof row !== 'object') return undefined;
  return (row as { companyId?: string | null }).companyId;
}

function sameCompany(row: unknown, companyId: string, requires: boolean): boolean {
  const cid = rowCompanyId(row);
  if (requires) return cid === companyId;
  // Optional models: allow platform rows (null) only when we are not scoping — here company is set,
  // so platform rows are hidden and tenant rows must match.
  if (cid == null) return false;
  return cid === companyId;
}

function modelDelegate(
  base: PrismaClient,
  model: string,
): { findUnique: (x: unknown) => Promise<unknown>; findFirst: (x: unknown) => Promise<unknown> } | null {
  const modelKey = model.charAt(0).toLowerCase() + model.slice(1);
  const delegate = (base as unknown as Record<string, unknown>)[modelKey];
  if (!delegate || typeof delegate !== 'object') return null;
  return delegate as {
    findUnique: (x: unknown) => Promise<unknown>;
    findFirst: (x: unknown) => Promise<unknown>;
  };
}

/**
 * Prisma extension: inject active companyId into tenant queries.
 * Does not change payroll/attendance formulas — only scopes which rows are visible.
 */
export function withTenantExtension(base: PrismaClient) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || PLATFORM_MODELS.has(model)) {
            return query(args);
          }

          const companyId = getCompanyId();
          const requires = modelRequiresCompany(model);
          const optional = OPTIONAL_COMPANY_MODELS.has(model);
          const a = { ...(args as AnyArgs) };

          if (requires && !companyId) {
            throw new Error(`COMPANY_CONTEXT_REQUIRED:${model}.${operation}`);
          }

          if (!companyId || (!optional && !requires)) {
            return query(args);
          }

          switch (operation) {
            case 'findMany':
            case 'findFirst':
            case 'findFirstOrThrow':
            case 'count':
            case 'aggregate':
            case 'groupBy':
              a.where = andWhere(a.where, companyId);
              return query(a);

            case 'findUnique':
            case 'findUniqueOrThrow': {
              const row = await query(args);
              if (row == null) return row;
              // `select` may omit companyId — peek via unscoped base before deciding.
              let cid = rowCompanyId(row);
              if (cid === undefined && a.where) {
                const delegate = modelDelegate(base, model);
                const peek = (await delegate?.findUnique?.({
                  where: a.where,
                  select: { companyId: true },
                })) as { companyId?: string | null } | null;
                cid = peek?.companyId;
              }
              const ok = requires ? cid === companyId : cid != null && cid === companyId;
              if (!ok) {
                if (operation === 'findUniqueOrThrow') {
                  throw new Error('RECORD_NOT_FOUND_IN_COMPANY');
                }
                return null;
              }
              return row;
            }

            case 'create':
              a.data = injectCreateData(a.data as Record<string, unknown>, companyId);
              return query(a);

            case 'createMany':
              a.data = injectCreateData(a.data, companyId);
              return query(a);

            case 'update':
            case 'delete': {
              // Peek first so we never mutate another company's row.
              // Prefer findUnique; fall back to findFirst+companyId when where is not a unique key.
              const delegate = modelDelegate(base, model);
              if (delegate && a.where) {
                let existing: unknown = null;
                try {
                  existing = await delegate.findUnique({ where: a.where });
                } catch {
                  existing = await delegate.findFirst({
                    where: andWhere(a.where, companyId),
                  });
                }
                if (!existing || !sameCompany(existing, companyId, requires)) {
                  throw new Error('RECORD_NOT_FOUND_IN_COMPANY');
                }
              }
              return query(args);
            }

            case 'updateMany':
            case 'deleteMany':
              a.where = andWhere(a.where, companyId);
              return query(a);

            case 'upsert': {
              // Never wrap unique `where` in AND — Prisma rejects that for upsert.
              // Inject companyId into create (and update when missing); callers must
              // use compound unique keys that already include companyId when required.
              if (a.create) {
                a.create = injectCreateData(a.create, companyId) as Record<string, unknown>;
              }
              return query(a);
            }

            default:
              return query(args);
          }
        },
      },
    },
  });
}

export type TenantPrisma = ReturnType<typeof withTenantExtension>;
