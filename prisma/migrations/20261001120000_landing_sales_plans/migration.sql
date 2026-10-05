-- Landing: subscription plans + sales requests

CREATE TYPE "SubscriptionPlanStatus" AS ENUM ('DRAFT', 'PUBLISHED');
CREATE TYPE "SalesRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "description_ar" TEXT,
    "description_en" TEXT,
    "price_display_ar" TEXT NOT NULL,
    "price_display_en" TEXT NOT NULL,
    "features_ar" JSONB NOT NULL DEFAULT '[]',
    "features_en" JSONB NOT NULL DEFAULT '[]',
    "default_max_employees" INTEGER,
    "default_max_users" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "highlighted" BOOLEAN NOT NULL DEFAULT false,
    "status" "SubscriptionPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscription_plans_slug_key" ON "subscription_plans"("slug");

CREATE TABLE "sales_requests" (
    "id" TEXT NOT NULL,
    "company_code" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "requested_employees" INTEGER NOT NULL,
    "plan_id" TEXT,
    "status" "SalesRequestStatus" NOT NULL DEFAULT 'PENDING',
    "rejection_reason" TEXT,
    "notes" TEXT,
    "created_company_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sales_requests_status_created_at_idx" ON "sales_requests"("status", "created_at");
CREATE INDEX "sales_requests_company_code_idx" ON "sales_requests"("company_code");
CREATE INDEX "sales_requests_email_idx" ON "sales_requests"("email");

ALTER TABLE "sales_requests" ADD CONSTRAINT "sales_requests_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_requests" ADD CONSTRAINT "sales_requests_created_company_id_fkey" FOREIGN KEY ("created_company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed default plans (match current landing copy)
INSERT INTO "subscription_plans" (
  "id", "slug", "name_ar", "name_en", "description_ar", "description_en",
  "price_display_ar", "price_display_en", "features_ar", "features_en",
  "default_max_employees", "default_max_users", "sort_order", "highlighted", "status", "updated_at"
) VALUES
(
  'plan_start', 'start', 'البداية', 'Start',
  'لموقع واحد يريد ضبط الحضور.', 'For one location that wants to control attendance.',
  '$2 / موظف/شهر', '$2 / employee/month',
  '["مزامنة أجهزة BioTime","جدول الشيفتات والحضور","تطبيق الخدمة الذاتية","حتى ١٠٠ موظف"]'::jsonb,
  '["BioTime device sync","Shifts and attendance schedule","Self-service app","Up to 100 employees"]'::jsonb,
  100, 3, 1, false, 'PUBLISHED', CURRENT_TIMESTAMP
),
(
  'plan_business', 'business', 'الأعمال', 'Business',
  'أتمتة رواتب كاملة للشركات النامية.', 'Complete payroll automation for growing companies.',
  '$4 / موظف/شهر', '$4 / employee/month',
  '["كل ما في باقة البداية","رواتب وساعات إضافية مؤتمتة","سلف واستقطاعات وفوري","موظفون وفروع بلا حدود"]'::jsonb,
  '["Everything in Start","Automated payroll and overtime","Advances, deductions, instant pay","Unlimited employees and branches"]'::jsonb,
  NULL, 10, 2, true, 'PUBLISHED', CURRENT_TIMESTAMP
),
(
  'plan_enterprise', 'enterprise', 'المؤسسات', 'Enterprise',
  'محلي أو هجين، مع دعم التنفيذ.', 'Local or hybrid, with implementation support.',
  'حسب الطلب', 'Custom pricing',
  '["كل ما في باقة الأعمال","نشر محلي / هجين","إعداد مخصص واتفاقية خدمة","تكاملات وتقارير مخصصة"]'::jsonb,
  '["Everything in Business","Local / hybrid deployment","Custom setup and SLA","Custom integrations and reports"]'::jsonb,
  NULL, NULL, 3, false, 'PUBLISHED', CURRENT_TIMESTAMP
);
