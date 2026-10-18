-- Field mission requests + grid/transaction display helpers.
-- Additive only: device punch sync and payroll formulas unchanged.

CREATE TYPE "FieldMissionRequestState" AS ENUM (
  'pending_branch',
  'approved',
  'rejected',
  'cancelled'
);

CREATE TABLE "field_mission_requests" (
  "company_id" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "requested_by_id" TEXT NOT NULL,
  "location_id" TEXT,
  "details" TEXT NOT NULL,
  "date_from" DATE NOT NULL,
  "date_to" DATE NOT NULL,
  "state" "FieldMissionRequestState" NOT NULL DEFAULT 'pending_branch',
  "branch_approved_by_id" TEXT,
  "branch_approved_at" TIMESTAMP(3),
  "rejected_by_id" TEXT,
  "rejection_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "field_mission_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "field_mission_requests_employee_id_state_idx"
  ON "field_mission_requests"("employee_id", "state");
CREATE INDEX "field_mission_requests_state_location_id_idx"
  ON "field_mission_requests"("state", "location_id");
CREATE INDEX "field_mission_requests_company_id_idx"
  ON "field_mission_requests"("company_id");
CREATE INDEX "field_mission_requests_company_id_date_from_date_to_idx"
  ON "field_mission_requests"("company_id", "date_from", "date_to");

ALTER TABLE "field_mission_requests"
  ADD CONSTRAINT "field_mission_requests_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "field_mission_requests"
  ADD CONSTRAINT "field_mission_requests_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "field_mission_requests"
  ADD CONSTRAINT "field_mission_requests_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shift_grid_lines"
  ADD COLUMN IF NOT EXISTS "is_field_mission" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "field_mission_request_id" TEXT;

CREATE INDEX IF NOT EXISTS "shift_grid_lines_field_mission_request_id_idx"
  ON "shift_grid_lines"("field_mission_request_id");

ALTER TABLE "shift_grid_lines"
  ADD CONSTRAINT "shift_grid_lines_field_mission_request_id_fkey"
  FOREIGN KEY ("field_mission_request_id") REFERENCES "field_mission_requests"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "location_display_name" TEXT;
