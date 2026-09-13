-- Location GPS punch settings + Transaction source/coords (same tables; no new tables).

ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "location_punch_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "geofence_radius_meters" INTEGER NOT NULL DEFAULT 200;

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "punch_source" TEXT,
  ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS "transactions_company_id_punch_source_idx"
  ON "transactions"("company_id", "punch_source");
