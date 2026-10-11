-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "fcm_token" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "app_notifications" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "image_url" TEXT,
    "data" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "app_notifications_user_id_created_at_idx" ON "app_notifications"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "app_notifications_company_id_created_at_idx" ON "app_notifications"("company_id", "created_at");
CREATE INDEX IF NOT EXISTS "app_notifications_company_id_idx" ON "app_notifications"("company_id");

ALTER TABLE "app_notifications" DROP CONSTRAINT IF EXISTS "app_notifications_user_id_fkey";
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_notifications" DROP CONSTRAINT IF EXISTS "app_notifications_company_id_fkey";
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
