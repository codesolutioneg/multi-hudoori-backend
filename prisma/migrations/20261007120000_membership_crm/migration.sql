-- Company parent (display tree only)
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "parent_company_id" TEXT;
CREATE INDEX IF NOT EXISTS "companies_parent_company_id_idx" ON "companies"("parent_company_id");
DO $$ BEGIN
  ALTER TABLE "companies" ADD CONSTRAINT "companies_parent_company_id_fkey"
    FOREIGN KEY ("parent_company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- User company memberships
CREATE TABLE IF NOT EXISTS "user_company_memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_company_memberships_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_company_memberships_user_id_company_id_key"
  ON "user_company_memberships"("user_id", "company_id");
CREATE INDEX IF NOT EXISTS "user_company_memberships_company_id_idx"
  ON "user_company_memberships"("company_id");
DO $$ BEGIN
  ALTER TABLE "user_company_memberships" ADD CONSTRAINT "user_company_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "user_company_memberships" ADD CONSTRAINT "user_company_memberships_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill: one membership per user on their home company
INSERT INTO "user_company_memberships" ("id", "user_id", "company_id", "role", "created_at", "updated_at")
SELECT
  md5(random()::text || clock_timestamp()::text || u.id)::text,
  u.id,
  u.company_id,
  u.role,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "users" u
WHERE u.company_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "user_company_memberships" m
    WHERE m.user_id = u.id AND m.company_id = u.company_id
  );

-- Sales request CRM
CREATE TYPE "SalesRequestSource" AS ENUM ('LANDING', 'MANUAL');
CREATE TYPE "SalesRequestActivityKind" AS ENUM ('NOTE', 'STATUS_CHANGE');

ALTER TABLE "sales_requests" ADD COLUMN IF NOT EXISTS "owner_user_id" TEXT;
ALTER TABLE "sales_requests" ADD COLUMN IF NOT EXISTS "next_follow_up_at" TIMESTAMP(3);
ALTER TABLE "sales_requests" ADD COLUMN IF NOT EXISTS "source" "SalesRequestSource" NOT NULL DEFAULT 'LANDING';

CREATE INDEX IF NOT EXISTS "sales_requests_owner_user_id_idx" ON "sales_requests"("owner_user_id");
CREATE INDEX IF NOT EXISTS "sales_requests_next_follow_up_at_idx" ON "sales_requests"("next_follow_up_at");

DO $$ BEGIN
  ALTER TABLE "sales_requests" ADD CONSTRAINT "sales_requests_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "sales_request_activities" (
    "id" TEXT NOT NULL,
    "sales_request_id" TEXT NOT NULL,
    "kind" "SalesRequestActivityKind" NOT NULL,
    "body" TEXT,
    "from_status" "SalesRequestStatus",
    "to_status" "SalesRequestStatus",
    "actor_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_request_activities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "sales_request_activities_sales_request_id_created_at_idx"
  ON "sales_request_activities"("sales_request_id", "created_at");
DO $$ BEGIN
  ALTER TABLE "sales_request_activities" ADD CONSTRAINT "sales_request_activities_sales_request_id_fkey"
    FOREIGN KEY ("sales_request_id") REFERENCES "sales_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "sales_request_activities" ADD CONSTRAINT "sales_request_activities_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
