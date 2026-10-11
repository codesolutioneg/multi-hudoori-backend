-- Punch-report overnight / pairing floors (defaults match Hudoori-dev hardcoded 10 / 5 / 6).
ALTER TABLE "biotime_config" ADD COLUMN "punch_report_min_late_checkout_hours" DOUBLE PRECISION NOT NULL DEFAULT 10;
ALTER TABLE "biotime_config" ADD COLUMN "punch_report_min_early_checkin_hours" DOUBLE PRECISION NOT NULL DEFAULT 5;
ALTER TABLE "biotime_config" ADD COLUMN "punch_report_calendar_day_floor_hour" INTEGER NOT NULL DEFAULT 6;
