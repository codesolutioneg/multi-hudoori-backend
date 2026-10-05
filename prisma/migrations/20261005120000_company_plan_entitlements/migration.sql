-- CreateEnum
CREATE TYPE "CompanyFeatureSource" AS ENUM ('PLAN_SNAPSHOT', 'ADMIN_OVERRIDE');

-- AlterTable companies
ALTER TABLE "companies" ADD COLUMN "subscription_plan_id" TEXT;
ALTER TABLE "companies" ADD COLUMN "plan_name_ar" TEXT;
ALTER TABLE "companies" ADD COLUMN "plan_name_en" TEXT;

-- AlterTable subscription_plans
ALTER TABLE "subscription_plans" ADD COLUMN "feature_keys" JSONB NOT NULL DEFAULT '[]';

-- CreateTable company_features
CREATE TABLE "company_features" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" "CompanyFeatureSource" NOT NULL DEFAULT 'PLAN_SNAPSHOT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_features_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "company_features_company_id_feature_key_key" ON "company_features"("company_id", "feature_key");
CREATE INDEX "company_features_company_id_enabled_idx" ON "company_features"("company_id", "enabled");
CREATE INDEX "companies_subscription_plan_id_idx" ON "companies"("subscription_plan_id");

ALTER TABLE "companies" ADD CONSTRAINT "companies_subscription_plan_id_fkey" FOREIGN KEY ("subscription_plan_id") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "company_features" ADD CONSTRAINT "company_features_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed feature_keys on published plans (catalog defaults)
UPDATE "subscription_plans" SET "feature_keys" = '["attendance"]'::jsonb WHERE slug = 'attendance';
UPDATE "subscription_plans" SET "feature_keys" = '["attendance","hr_employees","hr_leaves","hr_requests","employee_app","hr_reports"]'::jsonb WHERE slug = 'hr';
UPDATE "subscription_plans" SET "feature_keys" = '["attendance","hr_employees","hr_leaves","hr_requests","employee_app","hr_reports","payroll","overtime","advances","deductions","loans","fawry","bank_export"]'::jsonb WHERE slug = 'hr-payroll';
UPDATE "subscription_plans" SET "feature_keys" = '["attendance","hr_employees","hr_leaves","hr_requests","employee_app","hr_reports","payroll","overtime","advances","deductions","loans","fawry","bank_export","advanced_reports","api_access","integrations","advanced_permissions"]'::jsonb WHERE slug = 'professional';
