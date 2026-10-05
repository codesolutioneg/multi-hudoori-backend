import { CompanyFeatureSource } from '@prisma/client';
import { prismaBase } from '../prisma/client';
import { allFeatureKeys, isValidFeatureKey, normalizeFeatureKeys } from './featureCatalog';

/** Legacy tenants: no snapshot rows → all catalog features enabled. */
export async function companyHasFeatureSnapshot(companyId: string): Promise<boolean> {
  const n = await prismaBase.companyFeature.count({ where: { companyId } });
  return n > 0;
}

export async function getEnabledFeatureSet(companyId: string | null | undefined): Promise<Set<string>> {
  if (!companyId) return new Set(allFeatureKeys());
  const rows = await prismaBase.companyFeature.findMany({
    where: { companyId },
    select: { featureKey: true, enabled: true },
  });
  if (!rows.length) return new Set(allFeatureKeys());
  const set = new Set<string>();
  for (const r of rows) {
    if (r.enabled) set.add(r.featureKey);
  }
  return set;
}

export async function isFeatureEnabled(companyId: string | null | undefined, featureKey: string): Promise<boolean> {
  if (!companyId) return true;
  const rows = await prismaBase.companyFeature.findMany({
    where: { companyId, featureKey },
    select: { enabled: true },
  });
  if (!rows.length) {
    const any = await prismaBase.companyFeature.count({ where: { companyId } });
    return any === 0 ? true : false;
  }
  return rows.some((r) => r.enabled);
}

export type CompanyFeatureRow = {
  key: string;
  enabled: boolean;
  source: CompanyFeatureSource;
};

export async function listCompanyFeaturesForAdmin(companyId: string): Promise<CompanyFeatureRow[]> {
  const rows = await prismaBase.companyFeature.findMany({
    where: { companyId },
    orderBy: { featureKey: 'asc' },
  });
  const hasSnapshot = rows.length > 0;
  const byKey = new Map(rows.map((r) => [r.featureKey, r]));
  return allFeatureKeys().map((key) => {
    if (!hasSnapshot) {
      return { key, enabled: true, source: CompanyFeatureSource.PLAN_SNAPSHOT };
    }
    const row = byKey.get(key);
    return {
      key,
      enabled: row?.enabled ?? false,
      source: row?.source ?? CompanyFeatureSource.PLAN_SNAPSHOT,
    };
  });
}

export async function applyPlanSnapshotToCompany(
  companyId: string,
  plan: { id: string; nameAr: string; nameEn: string; featureKeys: unknown },
) {
  const keys = normalizeFeatureKeys(plan.featureKeys);
  await prismaBase.company.update({
    where: { id: companyId },
    data: {
      subscriptionPlanId: plan.id,
      planNameAr: plan.nameAr,
      planNameEn: plan.nameEn,
    },
  });
  await prismaBase.companyFeature.deleteMany({ where: { companyId } });
  if (!keys.length) return;
  await prismaBase.companyFeature.createMany({
    data: keys.map((featureKey) => ({
      companyId,
      featureKey,
      enabled: true,
      source: CompanyFeatureSource.PLAN_SNAPSHOT,
    })),
  });
}

export async function setCompanyFeaturesFromAdmin(
  companyId: string,
  toggles: Array<{ key: string; enabled: boolean }>,
) {
  for (const t of toggles) {
    const key = String(t.key ?? '').trim();
    if (!isValidFeatureKey(key)) continue;
    await prismaBase.companyFeature.upsert({
      where: { companyId_featureKey: { companyId, featureKey: key } },
      create: {
        companyId,
        featureKey: key,
        enabled: !!t.enabled,
        source: CompanyFeatureSource.ADMIN_OVERRIDE,
      },
      update: {
        enabled: !!t.enabled,
        source: CompanyFeatureSource.ADMIN_OVERRIDE,
      },
    });
  }
}
