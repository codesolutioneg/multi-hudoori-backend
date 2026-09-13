import { AsyncLocalStorage } from 'async_hooks';

export type TenantStore = {
  /** Active company for this request. Null = platform scope only (Super Admin, no company selected). */
  companyId: string | null;
  /** True when Super Admin selected a company from the switcher. */
  isImpersonatingCompany: boolean;
  actorUserId?: string;
  /** Bumped by test resetDatabase so stale enterWith leaks are ignored. */
  generation?: number;
};

const als = new AsyncLocalStorage<TenantStore>();

/** Monotonic generation — tests bump this on DB wipe so leaked enterWith stores are ignored. */
let tenantGeneration = 0;

export function bumpTenantGeneration(): void {
  tenantGeneration += 1;
}

export function getTenantGeneration(): number {
  return tenantGeneration;
}

export function runWithTenant<T>(store: TenantStore, fn: () => T): T {
  return als.run({ ...store, generation: tenantGeneration }, fn);
}

/** Bind tenant for the rest of this Express request (survives async next()). */
export function enterTenant(store: TenantStore): void {
  als.enterWith({ ...store, generation: tenantGeneration });
}

export function getTenantStore(): TenantStore | undefined {
  return als.getStore();
}

export function getCompanyId(): string | null {
  const store = als.getStore();
  if (store && store.generation === tenantGeneration) {
    return store.companyId ?? null;
  }
  // Vitest worker: stale enterWith from a prior HTTP request (wrong generation),
  // or no ALS at all across await/beforeEach boundaries.
  if (process.env.NODE_ENV === 'test') {
    const fallback = process.env.TEST_FALLBACK_COMPANY_ID?.trim();
    if (fallback) return fallback;
  }
  return store?.companyId ?? null;
}

export function requireCompanyId(): string {
  const id = getCompanyId();
  if (!id) {
    throw new Error('COMPANY_CONTEXT_REQUIRED');
  }
  return id;
}

/** Models that never carry companyId (platform catalog). */
export const PLATFORM_MODELS = new Set(['Company', 'MobileVersion']);

/** Models whose companyId may be null (platform admin sessions / platform audit). */
export const OPTIONAL_COMPANY_MODELS = new Set([
  'User',
  'UserFeatureGrant',
  'AuditLog',
  'DashboardNotificationRead',
  'ApiToken',
]);

export function modelRequiresCompany(model: string): boolean {
  if (PLATFORM_MODELS.has(model)) return false;
  if (OPTIONAL_COMPANY_MODELS.has(model)) return false;
  return true;
}
