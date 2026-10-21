-- Per-company annual leave balance policy (SaaS settings).
ALTER TABLE "biotime_config" ADD COLUMN "annual_leave_balance_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "biotime_config" ADD COLUMN "annual_leave_default_days" DOUBLE PRECISION NOT NULL DEFAULT 21;
ALTER TABLE "biotime_config" ADD COLUMN "annual_leave_carry_over_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "biotime_config" ADD COLUMN "annual_leave_payout_enabled" BOOLEAN NOT NULL DEFAULT false;
