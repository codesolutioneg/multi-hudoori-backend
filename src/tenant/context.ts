import { AsyncLocalStorage } from 'async_hooks';

export type TenantStore = {
  /** Active company for this request. Null = platform scope only (Super Admin, no company selected). */
  companyId: string | null;
  /** True when Super Admin selected a company from the switcher. */
  isImpersonatingCompany: boolean;
  actorUserId?: string;
};

const als = new AsyncLocalStorage<TenantStore>();

export function runWithTenant<T>(store: TenantStore, fn: () => T): T {
  return als.run(store, fn);
}

/** Bind tenant for the rest of this Express request (survives async next()). */
export function enterTenant(store: TenantStore): void {
  als.enterWith(store);
}

export function getTenantStore(): TenantStore | undefined {
  return als.getStore();
}

export function getCompanyId(): string | null {
  return als.getStore()?.companyId ?? null;
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
