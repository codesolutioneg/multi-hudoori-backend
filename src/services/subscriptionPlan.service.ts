import { SubscriptionPlanStatus } from '@prisma/client';
import { prismaBase } from '../prisma/client';
import { normalizeFeatureKeys } from './featureCatalog';

export function planToPublic(row: {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string | null;
  descriptionEn: string | null;
  priceDisplayAr: string;
  priceDisplayEn: string;
  featuresAr: unknown;
  featuresEn: unknown;
  highlighted: boolean;
  sortOrder: number;
  defaultMaxEmployees?: number | null;
}) {
  return {
    id: row.id,
    slug: row.slug,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    descriptionAr: row.descriptionAr,
    descriptionEn: row.descriptionEn,
    priceDisplayAr: row.priceDisplayAr,
    priceDisplayEn: row.priceDisplayEn,
    featuresAr: row.featuresAr,
    featuresEn: row.featuresEn,
    highlighted: row.highlighted,
    sortOrder: row.sortOrder,
    defaultMaxEmployees:
      row.defaultMaxEmployees == null || !Number.isFinite(Number(row.defaultMaxEmployees))
        ? null
        : Number(row.defaultMaxEmployees),
  };
}

export async function listPublishedPlans() {
  const rows = await prismaBase.subscriptionPlan.findMany({
    where: { status: SubscriptionPlanStatus.PUBLISHED },
    orderBy: { sortOrder: 'asc' },
  });
  return rows.map(planToPublic);
}

export async function listAllPlans() {
  return prismaBase.subscriptionPlan.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] });
}

export async function getPlanById(id: string) {
  return prismaBase.subscriptionPlan.findUnique({ where: { id } });
}

export async function getPlanBySlug(slug: string) {
  return prismaBase.subscriptionPlan.findUnique({ where: { slug } });
}

export type UpsertPlanInput = {
  slug: string;
  nameAr: string;
  nameEn: string;
  descriptionAr?: string | null;
  descriptionEn?: string | null;
  priceDisplayAr: string;
  priceDisplayEn: string;
  featuresAr: unknown;
  featuresEn: unknown;
  defaultMaxEmployees?: number | null;
  defaultMaxUsers?: number | null;
  featureKeys?: unknown;
  sortOrder?: number;
  highlighted?: boolean;
  status?: SubscriptionPlanStatus;
};

function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

export async function createPlan(input: UpsertPlanInput) {
  const slug = normalizeSlug(input.slug);
  if (!slug) throw Object.assign(new Error('Slug is required'), { errorCode: 'VALIDATION_ERROR' });
  return prismaBase.subscriptionPlan.create({
    data: {
      slug,
      nameAr: input.nameAr.trim(),
      nameEn: input.nameEn.trim(),
      descriptionAr: input.descriptionAr?.trim() || null,
      descriptionEn: input.descriptionEn?.trim() || null,
      priceDisplayAr: input.priceDisplayAr.trim(),
      priceDisplayEn: input.priceDisplayEn.trim(),
      featuresAr: input.featuresAr ?? [],
      featuresEn: input.featuresEn ?? [],
      defaultMaxEmployees: input.defaultMaxEmployees ?? null,
      defaultMaxUsers: input.defaultMaxUsers ?? null,
      featureKeys: normalizeFeatureKeys(input.featureKeys ?? []),
      sortOrder: input.sortOrder ?? 0,
      highlighted: input.highlighted ?? false,
      status: input.status ?? SubscriptionPlanStatus.DRAFT,
    },
  });
}

export async function updatePlan(id: string, input: Partial<UpsertPlanInput>) {
  const data: Record<string, unknown> = {};
  if (input.slug != null) data.slug = normalizeSlug(input.slug);
  if (input.nameAr != null) data.nameAr = input.nameAr.trim();
  if (input.nameEn != null) data.nameEn = input.nameEn.trim();
  if (input.descriptionAr !== undefined) data.descriptionAr = input.descriptionAr?.trim() || null;
  if (input.descriptionEn !== undefined) data.descriptionEn = input.descriptionEn?.trim() || null;
  if (input.priceDisplayAr != null) data.priceDisplayAr = input.priceDisplayAr.trim();
  if (input.priceDisplayEn != null) data.priceDisplayEn = input.priceDisplayEn.trim();
  if (input.featuresAr !== undefined) data.featuresAr = input.featuresAr;
  if (input.featuresEn !== undefined) data.featuresEn = input.featuresEn;
  if (input.defaultMaxEmployees !== undefined) data.defaultMaxEmployees = input.defaultMaxEmployees;
  if (input.defaultMaxUsers !== undefined) data.defaultMaxUsers = input.defaultMaxUsers;
  if (input.featureKeys !== undefined) data.featureKeys = normalizeFeatureKeys(input.featureKeys);
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.highlighted !== undefined) data.highlighted = input.highlighted;
  if (input.status !== undefined) data.status = input.status;
  return prismaBase.subscriptionPlan.update({ where: { id }, data });
}

/** Soft lifecycle only — no DELETE. */
export async function setPlanStatus(id: string, status: SubscriptionPlanStatus) {
  return prismaBase.subscriptionPlan.update({ where: { id }, data: { status } });
}
