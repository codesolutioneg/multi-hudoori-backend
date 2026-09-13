-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('PLATFORM_ADMIN', 'HR_MANAGER', 'HR_SUPERVISOR', 'HR_USER', 'BRANCH_MANAGER', 'EMPLOYEE', 'DEVICE_MANAGER');

-- CreateEnum
CREATE TYPE "HiringAppointmentStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "PayrollState" AS ENUM ('draft', 'calculated', 'confirmed');

-- CreateEnum
CREATE TYPE "DeductionState" AS ENUM ('draft', 'linked', 'cancelled');

-- CreateEnum
CREATE TYPE "AdvanceState" AS ENUM ('pending', 'applied', 'draft', 'running', 'done', 'cancelled', 'stopped', 'confirmed', 'paid');

-- CreateEnum
CREATE TYPE "ShiftGridState" AS ENUM ('setup', 'grid', 'confirmed');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('pending', 'running', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "RequestState" AS ENUM ('draft', 'pending', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "AdvanceRequestState" AS ENUM ('pending_branch', 'pending_hr', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "AdvanceLoanImportState" AS ENUM ('draft', 'locked');

-- CreateEnum
CREATE TYPE "PunchReportImportState" AS ENUM ('ready', 'applied');

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "company_id" TEXT,
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "initial_password" TEXT,
    "password_reset_token" TEXT,
    "password_reset_expires" TIMESTAMP(3),
    "role" "UserRole" NOT NULL DEFAULT 'EMPLOYEE',
    "location_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_feature_grants" (
    "company_id" TEXT,
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "granted_by_id" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_feature_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "company_id" TEXT,
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "actor_login" TEXT NOT NULL,
    "actor_name" TEXT,
    "actor_role" "UserRole",
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "summary" TEXT NOT NULL,
    "counts" JSONB,
    "diff_preview" JSONB,
    "payload" JSONB,
    "route" TEXT,
    "ip" TEXT,
    "request_id" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_notification_reads" (
    "company_id" TEXT,
    "id" TEXT NOT NULL,
    "reader_key" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_notification_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "company_id" TEXT,
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_info" TEXT,
    "expiry_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_profiles" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "display_name" TEXT,
    "code" TEXT,
    "identification_id" TEXT,
    "barcode" TEXT,
    "department_id" TEXT,
    "job_title" TEXT,
    "work_phone" TEXT,
    "mobile_phone" TEXT,
    "work_email" TEXT,
    "work_email_password" TEXT,
    "gender" TEXT,
    "location" TEXT,
    "address" TEXT,
    "location_id" TEXT,
    "manager_id" TEXT,
    "basic_salary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hiring_date" TIMESTAMP(3),
    "departure_date" TIMESTAMP(3),
    "national_id_confirm" TEXT,
    "is_foreigner" BOOLEAN NOT NULL DEFAULT false,
    "birthday" TIMESTAMP(3),
    "qualification_original" BOOLEAN NOT NULL DEFAULT false,
    "qualification_doc_status" TEXT NOT NULL DEFAULT 'none',
    "criminal_record" BOOLEAN NOT NULL DEFAULT false,
    "birth_certificate_original" BOOLEAN NOT NULL DEFAULT false,
    "birth_certificate_doc_status" TEXT NOT NULL DEFAULT 'none',
    "work_stub" BOOLEAN NOT NULL DEFAULT false,
    "military_service_doc" BOOLEAN NOT NULL DEFAULT false,
    "military_doc_status" TEXT NOT NULL DEFAULT 'none',
    "id_card_photo" BOOLEAN NOT NULL DEFAULT false,
    "id_card_photo_url" TEXT,
    "personal_photo" BOOLEAN NOT NULL DEFAULT false,
    "personal_photo_count" INTEGER NOT NULL DEFAULT 0,
    "personal_photo_doc_url" TEXT,
    "insurance_print" BOOLEAN NOT NULL DEFAULT false,
    "insurance_print_url" TEXT,
    "qualification_doc_url" TEXT,
    "military_doc_url" TEXT,
    "birth_certificate_doc_url" TEXT,
    "criminal_record_doc_url" TEXT,
    "skill_level" TEXT,
    "has_skill_level" BOOLEAN NOT NULL DEFAULT false,
    "health_certificate" BOOLEAN NOT NULL DEFAULT false,
    "health_certificate_issue_date" TIMESTAMP(3),
    "health_certificate_expiry_date" TIMESTAMP(3),
    "insurance_number" TEXT,
    "insurance_status" TEXT,
    "insurance_company_id" TEXT,
    "insurance_salary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "medical_insurance_status" TEXT,
    "medical_insurance_company_id" TEXT,
    "medical_insurance_salary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mobile_line" BOOLEAN NOT NULL DEFAULT false,
    "has_fawry_account" BOOLEAN NOT NULL DEFAULT false,
    "fawry_account" TEXT,
    "misr_account" BOOLEAN NOT NULL DEFAULT false,
    "bank_iban" TEXT,
    "mobile_line_phone" TEXT,
    "laptop_provided" BOOLEAN NOT NULL DEFAULT false,
    "mobile_provided" BOOLEAN NOT NULL DEFAULT false,
    "leave_starting_balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "used_leave_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remaining_leave_balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMP(3),
    "archive_reason" TEXT,
    "biotime_synced" BOOLEAN NOT NULL DEFAULT false,
    "biotime_device_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custody_types" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sequence" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custody_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_custodies" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "custody_type_id" TEXT NOT NULL,
    "provided" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_custodies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sequence" INTEGER NOT NULL DEFAULT 10,
    "actual_name" TEXT,
    "loan_notification_emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "manager_employee_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_companies" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sequence" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_titles" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sequence" INTEGER NOT NULL DEFAULT 10,
    "level_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_levels" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_en" TEXT,
    "code" TEXT,
    "rank" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_reasons" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sequence" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "archive_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biotime_config" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "server_ip" TEXT NOT NULL DEFAULT '',
    "server_port" INTEGER NOT NULL DEFAULT 8090,
    "use_https" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT NOT NULL DEFAULT '',
    "password" TEXT NOT NULL DEFAULT '',
    "auth_type" TEXT NOT NULL DEFAULT 'jwt',
    "auth_token" TEXT,
    "token_expiry" TIMESTAMP(3),
    "is_connected" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
    "scheduled_auto_sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "auto_sync_employees" BOOLEAN NOT NULL DEFAULT true,
    "auto_sync_departments" BOOLEAN NOT NULL DEFAULT true,
    "auto_sync_transactions" BOOLEAN NOT NULL DEFAULT true,
    "auto_push_to_biotime" BOOLEAN NOT NULL DEFAULT false,
    "auto_push_deletes" BOOLEAN NOT NULL DEFAULT false,
    "default_biotime_area_id" INTEGER,
    "employee_sync_interval_hours" INTEGER NOT NULL DEFAULT 12,
    "transaction_sync_interval_mins" INTEGER NOT NULL DEFAULT 15,
    "duplicate_grace_minutes" INTEGER NOT NULL DEFAULT 1,
    "duplicate_policy" TEXT NOT NULL DEFAULT 'mark',
    "last_employee_sync" TIMESTAMP(3),
    "last_department_sync" TIMESTAMP(3),
    "last_transaction_sync" TIMESTAMP(3),
    "company_logo_path" TEXT,
    "advance_default_percent" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "advance_minimum_working_days" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "advance_enforce_limit" BOOLEAN NOT NULL DEFAULT true,
    "advance_eligibility_source" TEXT NOT NULL DEFAULT 'punch_report',
    "late_grace_minutes" INTEGER NOT NULL DEFAULT 20,
    "late_quarter_day_max_minutes" INTEGER NOT NULL DEFAULT 30,
    "late_half_day_max_minutes" INTEGER NOT NULL DEFAULT 60,
    "late_forgiven_days_count" INTEGER NOT NULL DEFAULT 2,
    "late_forgiven_days_selection" TEXT NOT NULL DEFAULT 'oldest',
    "late_grace_precedence" TEXT NOT NULL DEFAULT 'longest',
    "late_permission_cap" INTEGER NOT NULL DEFAULT 2,
    "late_permission_cap_enabled" BOOLEAN NOT NULL DEFAULT true,
    "payroll_month_start_day" INTEGER NOT NULL DEFAULT 26,
    "payroll_fixed_month_days_enabled" BOOLEAN NOT NULL DEFAULT false,
    "payroll_fixed_month_days" INTEGER NOT NULL DEFAULT 30,
    "absent_forgiven_days_count" INTEGER NOT NULL DEFAULT 4,
    "tip_job_title_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grid_week_start_day" INTEGER NOT NULL DEFAULT 0,
    "employee_team_schedule_scope" TEXT NOT NULL DEFAULT 'department',
    "employee_team_show_shift_times" BOOLEAN NOT NULL DEFAULT true,
    "employee_team_show_off_days" BOOLEAN NOT NULL DEFAULT true,
    "employee_team_show_leave" BOOLEAN NOT NULL DEFAULT false,
    "employee_team_show_sick_leave" BOOLEAN NOT NULL DEFAULT false,
    "default_late_checkout_hours" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "default_early_checkin_hours" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "biotime_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_en" TEXT,
    "code" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 10,
    "biotime_dept_id" INTEGER,
    "biotime_dept_code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_mappings" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "biotime_dept_id" INTEGER NOT NULL,
    "biotime_dept_code" TEXT,
    "biotime_dept_name" TEXT,
    "department_id" TEXT NOT NULL,

    CONSTRAINT "department_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_mappings" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "biotime_emp_id" INTEGER,
    "biotime_emp_code" TEXT,
    "employee_id" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "card_no" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "hire_date" TIMESTAMP(3),
    "gender" TEXT,
    "biotime_department_id" INTEGER,
    "biotime_position_id" INTEGER,
    "last_sync" TIMESTAMP(3),
    "push_content_hash" TEXT,

    CONSTRAINT "employee_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "biotime_id" INTEGER,
    "name" TEXT NOT NULL,
    "alias" TEXT,
    "serial_number" TEXT,
    "ip_address" TEXT,
    "location_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "biotime_transaction_id" INTEGER,
    "employee_id" TEXT,
    "emp_code" TEXT,
    "punch_time" TIMESTAMP(3) NOT NULL,
    "punch_state" TEXT,
    "terminal_sn" TEXT,
    "terminal_alias" TEXT,
    "is_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "duplicate_of_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendances" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "shift_id" TEXT,
    "expected_check_in" TEXT,
    "expected_check_out" TEXT,
    "first_check_in" TIMESTAMP(3),
    "last_check_out" TIMESTAMP(3),
    "worked_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "net_worked_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_leave_minutes" INTEGER NOT NULL DEFAULT 0,
    "overtime_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'present',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "is_overnight" BOOLEAN NOT NULL DEFAULT false,
    "work_date_reference" TEXT NOT NULL DEFAULT 'start',
    "early_checkin_threshold" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "late_checkout_threshold" DOUBLE PRECISION NOT NULL DEFAULT 4,
    "rest_days" TEXT,
    "grace_period_in" INTEGER NOT NULL DEFAULT 20,
    "grace_period_out" INTEGER NOT NULL DEFAULT 15,
    "break_duration" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sequence" INTEGER NOT NULL DEFAULT 10,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_assignments" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "shift_id" TEXT,
    "date_from" DATE NOT NULL,
    "date_to" DATE,
    "week_days" TEXT,
    "assignment_type" TEXT NOT NULL DEFAULT 'permanent',
    "notes" TEXT,
    "saturday_shift_id" TEXT,
    "sunday_shift_id" TEXT,
    "monday_shift_id" TEXT,
    "tuesday_shift_id" TEXT,
    "wednesday_shift_id" TEXT,
    "thursday_shift_id" TEXT,
    "friday_shift_id" TEXT,
    "saturday_is_off" BOOLEAN NOT NULL DEFAULT false,
    "sunday_is_off" BOOLEAN NOT NULL DEFAULT false,
    "monday_is_off" BOOLEAN NOT NULL DEFAULT false,
    "tuesday_is_off" BOOLEAN NOT NULL DEFAULT false,
    "wednesday_is_off" BOOLEAN NOT NULL DEFAULT false,
    "thursday_is_off" BOOLEAN NOT NULL DEFAULT false,
    "friday_is_off" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_grids" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "state" "ShiftGridState" NOT NULL DEFAULT 'setup',
    "selection_method" TEXT NOT NULL DEFAULT 'manual',
    "conflict_action" TEXT NOT NULL DEFAULT 'replace',
    "employee_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "department_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "device_id" TEXT,
    "grid_location" TEXT,
    "location_id" TEXT,
    "merged_from_grid_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "merged_at" TIMESTAMP(3),
    "merged_into_grid_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_grids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_grid_lines" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "grid_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "shift_id" TEXT,
    "is_off" BOOLEAN NOT NULL DEFAULT false,
    "is_sick" BOOLEAN NOT NULL DEFAULT false,
    "is_annual_leave" BOOLEAN NOT NULL DEFAULT false,
    "is_excluded" BOOLEAN NOT NULL DEFAULT false,
    "is_bus_delay" BOOLEAN NOT NULL DEFAULT false,
    "is_present" BOOLEAN NOT NULL DEFAULT false,
    "is_finished" BOOLEAN NOT NULL DEFAULT false,
    "is_resignation" BOOLEAN NOT NULL DEFAULT false,
    "is_work_absence" BOOLEAN NOT NULL DEFAULT false,
    "is_work_injury" BOOLEAN NOT NULL DEFAULT false,
    "is_marriage_leave" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "shift_grid_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_grid_manual_ot_lines" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "grid_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_grid_manual_ot_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odoo_config" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "base_url" TEXT NOT NULL DEFAULT '',
    "database" TEXT NOT NULL DEFAULT '',
    "login" TEXT NOT NULL DEFAULT '',
    "password" TEXT NOT NULL DEFAULT '',
    "auth_token" TEXT,
    "token_expiry" TIMESTAMP(3),
    "is_connected" BOOLEAN NOT NULL DEFAULT false,
    "integration_enabled" BOOLEAN NOT NULL DEFAULT false,
    "journal_odoo_id" INTEGER,
    "cash_debit_account_odoo_id" INTEGER,
    "cash_credit_account_odoo_id" INTEGER,
    "fawry_debit_account_odoo_id" INTEGER,
    "fawry_credit_account_odoo_id" INTEGER,
    "last_push_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "odoo_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odoo_sync_maps" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "odoo_id" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content_hash" TEXT,

    CONSTRAINT "odoo_sync_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "grid_id" TEXT,
    "job_type" TEXT NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payrolls" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "state" "PayrollState" NOT NULL DEFAULT 'draft',
    "shift_grid_id" TEXT,
    "device_id" TEXT,
    "total_gross" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_net" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_deductions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "journal_entry_id" TEXT,
    "odoo_move_id" INTEGER,
    "odoo_move_name" TEXT,
    "odoo_payroll_journal_id" INTEGER,
    "odoo_sent_at" TIMESTAMP(3),
    "excluded_employee_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excel_imported_at" TIMESTAMP(3),
    "show_edit_comparison" BOOLEAN NOT NULL DEFAULT false,
    "edit_import_message" TEXT,
    "comparison_total_net_before" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "comparison_total_net_after" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payrolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "payroll_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "employee_code" TEXT,
    "basic_salary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "working_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actual_working_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "work_days_salary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gross_salary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_earnings" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overtime_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overtime_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_deductions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "net_salary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "absent_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "absent_count" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sick_day_count" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "leave_absence_deduction_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "edit_snapshot_set" BOOLEAN NOT NULL DEFAULT false,
    "edit_net_before" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "edit_manual_ded_before" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "late_deductible_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "earned_leave" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "permission_count" INTEGER NOT NULL DEFAULT 0,
    "late_deduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "early_deduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "absent_deduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sick_deduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "manual_debit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "penalty_deduction_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "admin_deduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fines" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deduction_checks" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grouped_checks" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "health_certificates_deduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fraction_deduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "documents_deduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "social_insurance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "medical_insurance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "advance_short_total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "advance_long_total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "previous_settlements" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "previous_insurance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "punch_deduction_checkin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "punch_deduction_checkout" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "late_checkout_deduction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "single_punch_count" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "late_deductible_minutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "early_leave_minutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "off_day_count" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "days_count" INTEGER NOT NULL DEFAULT 0,
    "total_net_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "department_name" TEXT,
    "position_name" TEXT,
    "employee_location" TEXT,
    "notes" TEXT,
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "payment_method" TEXT,
    "resigned_frozen" BOOLEAN,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deductions" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "reference" TEXT,
    "employee_id" TEXT NOT NULL,
    "payroll_id" TEXT,
    "payroll_line_id" TEXT,
    "device_id" TEXT,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "applied_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "state" "DeductionState" NOT NULL DEFAULT 'draft',
    "date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_counters" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "system_counters_pkey" PRIMARY KEY ("company_id","id")
);

-- CreateTable
CREATE TABLE "punch_report_imports" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "shift_grid_id" TEXT NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "source_filename" TEXT,
    "source_file_base64" TEXT,
    "export_wizard_id" TEXT,
    "state" "PunchReportImportState" NOT NULL DEFAULT 'ready',
    "employee_count" INTEGER NOT NULL DEFAULT 0,
    "summaries_json" JSONB NOT NULL,
    "payroll_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "punch_report_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_loan_imports" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "device_id" TEXT,
    "source_grid_id" TEXT,
    "date" DATE NOT NULL,
    "state" "AdvanceLoanImportState" NOT NULL DEFAULT 'draft',
    "default_repayment_months" INTEGER NOT NULL DEFAULT 12,
    "default_reason" TEXT,
    "odoo_accounts_send_id" INTEGER,
    "odoo_move_id" INTEGER,
    "odoo_send_ref" TEXT,
    "notification_emails_sent_at" TIMESTAMP(3),
    "notification_email_error" TEXT,
    "notification_email_recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kind" TEXT NOT NULL DEFAULT 'loan',
    "cash_amount" DOUBLE PRECISION,
    "fawry_amount" DOUBLE PRECISION,
    "total_amount" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advance_loan_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_loan_import_lines" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "employee_id" TEXT,
    "employee_code" TEXT,
    "employee_name" TEXT,
    "requested_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "eligible_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "system_eligible_amount" DOUBLE PRECISION,
    "eligibility_overridden" BOOLEAN NOT NULL DEFAULT false,
    "approved_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actual_working_days" DOUBLE PRECISION,
    "compare_status" TEXT NOT NULL DEFAULT 'ready',
    "to_approve" BOOLEAN NOT NULL DEFAULT true,
    "row_reason" TEXT,
    "repayment_months" INTEGER,
    "short_advance_id" TEXT,
    "note" TEXT,
    "is_fawry" BOOLEAN NOT NULL DEFAULT false,
    "ineligibility_reason" TEXT,

    CONSTRAINT "advance_loan_import_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advances_short" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "source_grid_id" TEXT,
    "payroll_id" TEXT,
    "payroll_line_id" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "state" "AdvanceState" NOT NULL DEFAULT 'pending',
    "is_deducted" BOOLEAN NOT NULL DEFAULT false,
    "date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deduction_start_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "eligibility_percent" DOUBLE PRECISION,
    "max_eligible_at_creation" DOUBLE PRECISION,
    "actual_working_days_at_creation" DOUBLE PRECISION,
    "limit_override" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advances_short_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advances_long" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "total_amount" DOUBLE PRECISION NOT NULL,
    "installment_amount" DOUBLE PRECISION NOT NULL,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "state" "AdvanceState" NOT NULL DEFAULT 'draft',
    "date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "start_date" DATE,
    "next_deduction_date" DATE,
    "notes" TEXT,
    "eligibility_percent" DOUBLE PRECISION,
    "max_eligible_at_creation" DOUBLE PRECISION,
    "actual_working_days_at_creation" DOUBLE PRECISION,
    "limit_override" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" TEXT,
    "is_accounting_locked" BOOLEAN NOT NULL DEFAULT false,
    "remaining_journal_move_id" TEXT,
    "odoo_advance_long_id" INTEGER,
    "odoo_accounts_send_id" INTEGER,
    "odoo_move_id" INTEGER,
    "odoo_move_name" TEXT,
    "odoo_sent_at" TIMESTAMP(3),
    "odoo_sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advances_long_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_long_payments" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "advance_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "state" "AdvanceState" NOT NULL DEFAULT 'applied',
    "payroll_id" TEXT,
    "payroll_line_id" TEXT,
    "payment_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advance_long_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "leave_type" TEXT NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "state" "RequestState" NOT NULL DEFAULT 'pending',
    "approved_by_id" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_requests" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "repayment_months" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL,
    "state" "RequestState" NOT NULL DEFAULT 'pending',
    "approved_by_id" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loan_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_requests" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "location_id" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "state" "AdvanceRequestState" NOT NULL DEFAULT 'pending_branch',
    "eligibility_percent" DOUBLE PRECISION,
    "max_eligible_at_request" DOUBLE PRECISION,
    "available_at_request" DOUBLE PRECISION,
    "actual_working_days_at_request" DOUBLE PRECISION,
    "branch_approved_by_id" TEXT,
    "branch_approved_at" TIMESTAMP(3),
    "hr_approved_by_id" TEXT,
    "hr_approved_at" TIMESTAMP(3),
    "rejected_by_id" TEXT,
    "rejection_reason" TEXT,
    "limit_override" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" TEXT,
    "advance_short_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "advance_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_change_requests" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "current_shift_id" TEXT,
    "new_shift_id" TEXT NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "state" "RequestState" NOT NULL DEFAULT 'pending',
    "approved_by_id" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_requests" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "state" "RequestState" NOT NULL DEFAULT 'pending',
    "approved_by_id" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_requests" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "certificate_type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "state" "RequestState" NOT NULL DEFAULT 'pending',
    "approved_by_id" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificate_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_edit_requests" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "requested_check_in" TEXT,
    "requested_check_out" TEXT,
    "reason" TEXT NOT NULL,
    "state" "RequestState" NOT NULL DEFAULT 'pending',
    "approved_by_id" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_edit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_analyses" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "shift_id" TEXT,
    "expected_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actual_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overtime_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_leave_minutes" INTEGER NOT NULL DEFAULT 0,
    "attendance_status" TEXT NOT NULL DEFAULT 'on_time',
    "state" "RequestState" NOT NULL DEFAULT 'pending',
    "approved_by_id" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overtime_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hiring_appointments" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "appointment_date" DATE NOT NULL,
    "employee_name" TEXT NOT NULL,
    "mobile_phone" TEXT NOT NULL,
    "national_id" TEXT NOT NULL,
    "job_title" TEXT NOT NULL,
    "location_id" TEXT,
    "fingerprint_code" TEXT NOT NULL,
    "first_working_day" DATE NOT NULL,
    "status" "HiringAppointmentStatus" NOT NULL DEFAULT 'pending',
    "status_note" TEXT,
    "notes" TEXT,
    "pdf_path" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3),
    "approved_by_name" TEXT,
    "hr_seen_at" TIMESTAMP(3),
    "external_ref" TEXT,
    "employee_profile_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hiring_appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobile_versions" (
    "id" SERIAL NOT NULL,
    "version" TEXT NOT NULL,
    "is_publish" TEXT NOT NULL DEFAULT 'false',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mobile_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_code_key" ON "companies"("code");

-- CreateIndex
CREATE INDEX "users_location_id_idx" ON "users"("location_id");

-- CreateIndex
CREATE INDEX "users_company_id_idx" ON "users"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_company_id_login_key" ON "users"("company_id", "login");

-- CreateIndex
CREATE INDEX "user_feature_grants_feature_enabled_idx" ON "user_feature_grants"("feature", "enabled");

-- CreateIndex
CREATE INDEX "user_feature_grants_company_id_idx" ON "user_feature_grants"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_feature_grants_user_id_feature_key" ON "user_feature_grants"("user_id", "feature");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_module_created_at_idx" ON "audit_logs"("module", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_idx" ON "audit_logs"("company_id");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_created_at_idx" ON "audit_logs"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "dashboard_notification_reads_reader_key_idx" ON "dashboard_notification_reads"("reader_key");

-- CreateIndex
CREATE INDEX "dashboard_notification_reads_company_id_idx" ON "dashboard_notification_reads"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_notification_reads_reader_key_notification_id_key" ON "dashboard_notification_reads"("reader_key", "notification_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_token_key" ON "api_tokens"("token");

-- CreateIndex
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens"("user_id");

-- CreateIndex
CREATE INDEX "api_tokens_company_id_idx" ON "api_tokens"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_user_id_key" ON "employee_profiles"("user_id");

-- CreateIndex
CREATE INDEX "employee_profiles_company_id_idx" ON "employee_profiles"("company_id");

-- CreateIndex
CREATE INDEX "employee_profiles_company_id_code_idx" ON "employee_profiles"("company_id", "code");

-- CreateIndex
CREATE INDEX "employee_profiles_company_id_active_location_id_idx" ON "employee_profiles"("company_id", "active", "location_id");

-- CreateIndex
CREATE INDEX "employee_profiles_code_idx" ON "employee_profiles"("code");

-- CreateIndex
CREATE INDEX "employee_profiles_active_location_id_idx" ON "employee_profiles"("active", "location_id");

-- CreateIndex
CREATE INDEX "employee_profiles_archived_at_idx" ON "employee_profiles"("archived_at");

-- CreateIndex
CREATE INDEX "employee_profiles_manager_id_idx" ON "employee_profiles"("manager_id");

-- CreateIndex
CREATE INDEX "custody_types_company_id_idx" ON "custody_types"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "custody_types_company_id_code_key" ON "custody_types"("company_id", "code");

-- CreateIndex
CREATE INDEX "employee_custodies_custody_type_id_idx" ON "employee_custodies"("custody_type_id");

-- CreateIndex
CREATE INDEX "employee_custodies_company_id_idx" ON "employee_custodies"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_custodies_employee_id_custody_type_id_key" ON "employee_custodies"("employee_id", "custody_type_id");

-- CreateIndex
CREATE INDEX "locations_manager_employee_id_idx" ON "locations"("manager_employee_id");

-- CreateIndex
CREATE INDEX "locations_company_id_idx" ON "locations"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "locations_company_id_code_key" ON "locations"("company_id", "code");

-- CreateIndex
CREATE INDEX "insurance_companies_company_id_idx" ON "insurance_companies"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_companies_company_id_code_key" ON "insurance_companies"("company_id", "code");

-- CreateIndex
CREATE INDEX "job_titles_level_id_idx" ON "job_titles"("level_id");

-- CreateIndex
CREATE INDEX "job_titles_company_id_idx" ON "job_titles"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_titles_company_id_name_key" ON "job_titles"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "job_titles_company_id_code_key" ON "job_titles"("company_id", "code");

-- CreateIndex
CREATE INDEX "job_levels_company_id_idx" ON "job_levels"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_levels_company_id_name_key" ON "job_levels"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "job_levels_company_id_rank_key" ON "job_levels"("company_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "job_levels_company_id_code_key" ON "job_levels"("company_id", "code");

-- CreateIndex
CREATE INDEX "archive_reasons_company_id_idx" ON "archive_reasons"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "archive_reasons_company_id_name_key" ON "archive_reasons"("company_id", "name");

-- CreateIndex
CREATE INDEX "biotime_config_company_id_idx" ON "biotime_config"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "biotime_config_company_id_key" ON "biotime_config"("company_id");

-- CreateIndex
CREATE INDEX "departments_company_id_idx" ON "departments"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_company_id_code_key" ON "departments"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "department_mappings_department_id_key" ON "department_mappings"("department_id");

-- CreateIndex
CREATE INDEX "department_mappings_company_id_idx" ON "department_mappings"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_mappings_employee_id_key" ON "employee_mappings"("employee_id");

-- CreateIndex
CREATE INDEX "employee_mappings_biotime_emp_code_idx" ON "employee_mappings"("biotime_emp_code");

-- CreateIndex
CREATE INDEX "employee_mappings_company_id_idx" ON "employee_mappings"("company_id");

-- CreateIndex
CREATE INDEX "devices_location_id_idx" ON "devices"("location_id");

-- CreateIndex
CREATE INDEX "devices_company_id_idx" ON "devices"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_company_id_biotime_id_key" ON "devices"("company_id", "biotime_id");

-- CreateIndex
CREATE INDEX "transactions_emp_code_punch_time_idx" ON "transactions"("emp_code", "punch_time");

-- CreateIndex
CREATE INDEX "transactions_employee_id_punch_time_idx" ON "transactions"("employee_id", "punch_time");

-- CreateIndex
CREATE INDEX "transactions_is_duplicate_idx" ON "transactions"("is_duplicate");

-- CreateIndex
CREATE INDEX "transactions_company_id_idx" ON "transactions"("company_id");

-- CreateIndex
CREATE INDEX "transactions_company_id_emp_code_punch_time_idx" ON "transactions"("company_id", "emp_code", "punch_time");

-- CreateIndex
CREATE INDEX "transactions_company_id_employee_id_punch_time_idx" ON "transactions"("company_id", "employee_id", "punch_time");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_company_id_biotime_transaction_id_key" ON "transactions"("company_id", "biotime_transaction_id");

-- CreateIndex
CREATE INDEX "attendances_company_id_idx" ON "attendances"("company_id");

-- CreateIndex
CREATE INDEX "attendances_company_id_employee_id_date_idx" ON "attendances"("company_id", "employee_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendances_employee_id_date_key" ON "attendances"("employee_id", "date");

-- CreateIndex
CREATE INDEX "shifts_company_id_idx" ON "shifts"("company_id");

-- CreateIndex
CREATE INDEX "shift_assignments_company_id_idx" ON "shift_assignments"("company_id");

-- CreateIndex
CREATE INDEX "shift_grids_merged_into_grid_id_idx" ON "shift_grids"("merged_into_grid_id");

-- CreateIndex
CREATE INDEX "shift_grids_company_id_idx" ON "shift_grids"("company_id");

-- CreateIndex
CREATE INDEX "shift_grid_lines_company_id_idx" ON "shift_grid_lines"("company_id");

-- CreateIndex
CREATE INDEX "shift_grid_lines_company_id_grid_id_employee_id_date_idx" ON "shift_grid_lines"("company_id", "grid_id", "employee_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "shift_grid_lines_grid_id_employee_id_date_key" ON "shift_grid_lines"("grid_id", "employee_id", "date");

-- CreateIndex
CREATE INDEX "shift_grid_manual_ot_lines_grid_id_idx" ON "shift_grid_manual_ot_lines"("grid_id");

-- CreateIndex
CREATE INDEX "shift_grid_manual_ot_lines_company_id_idx" ON "shift_grid_manual_ot_lines"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "shift_grid_manual_ot_lines_grid_id_employee_id_date_key" ON "shift_grid_manual_ot_lines"("grid_id", "employee_id", "date");

-- CreateIndex
CREATE INDEX "odoo_config_company_id_idx" ON "odoo_config"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "odoo_config_company_id_key" ON "odoo_config"("company_id");

-- CreateIndex
CREATE INDEX "odoo_sync_maps_entity_type_odoo_id_idx" ON "odoo_sync_maps"("entity_type", "odoo_id");

-- CreateIndex
CREATE INDEX "odoo_sync_maps_company_id_idx" ON "odoo_sync_maps"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "odoo_sync_maps_company_id_entity_type_local_id_key" ON "odoo_sync_maps"("company_id", "entity_type", "local_id");

-- CreateIndex
CREATE INDEX "sync_jobs_company_id_idx" ON "sync_jobs"("company_id");

-- CreateIndex
CREATE INDEX "payrolls_company_id_idx" ON "payrolls"("company_id");

-- CreateIndex
CREATE INDEX "payroll_lines_company_id_idx" ON "payroll_lines"("company_id");

-- CreateIndex
CREATE INDEX "payroll_lines_company_id_payroll_id_idx" ON "payroll_lines"("company_id", "payroll_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_payroll_id_employee_id_key" ON "payroll_lines"("payroll_id", "employee_id");

-- CreateIndex
CREATE INDEX "deductions_employee_id_date_state_idx" ON "deductions"("employee_id", "date", "state");

-- CreateIndex
CREATE INDEX "deductions_payroll_id_type_idx" ON "deductions"("payroll_id", "type");

-- CreateIndex
CREATE INDEX "deductions_company_id_idx" ON "deductions"("company_id");

-- CreateIndex
CREATE INDEX "system_counters_company_id_idx" ON "system_counters"("company_id");

-- CreateIndex
CREATE INDEX "punch_report_imports_shift_grid_id_created_at_idx" ON "punch_report_imports"("shift_grid_id", "created_at");

-- CreateIndex
CREATE INDEX "punch_report_imports_company_id_idx" ON "punch_report_imports"("company_id");

-- CreateIndex
CREATE INDEX "advance_loan_imports_company_id_idx" ON "advance_loan_imports"("company_id");

-- CreateIndex
CREATE INDEX "advance_loan_import_lines_import_id_idx" ON "advance_loan_import_lines"("import_id");

-- CreateIndex
CREATE INDEX "advance_loan_import_lines_company_id_idx" ON "advance_loan_import_lines"("company_id");

-- CreateIndex
CREATE INDEX "advances_short_company_id_idx" ON "advances_short"("company_id");

-- CreateIndex
CREATE INDEX "advances_long_odoo_advance_long_id_idx" ON "advances_long"("odoo_advance_long_id");

-- CreateIndex
CREATE INDEX "advances_long_company_id_idx" ON "advances_long"("company_id");

-- CreateIndex
CREATE INDEX "advance_long_payments_company_id_idx" ON "advance_long_payments"("company_id");

-- CreateIndex
CREATE INDEX "leave_requests_employee_id_state_idx" ON "leave_requests"("employee_id", "state");

-- CreateIndex
CREATE INDEX "leave_requests_company_id_idx" ON "leave_requests"("company_id");

-- CreateIndex
CREATE INDEX "loan_requests_employee_id_state_idx" ON "loan_requests"("employee_id", "state");

-- CreateIndex
CREATE INDEX "loan_requests_company_id_idx" ON "loan_requests"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "advance_requests_advance_short_id_key" ON "advance_requests"("advance_short_id");

-- CreateIndex
CREATE INDEX "advance_requests_employee_id_state_idx" ON "advance_requests"("employee_id", "state");

-- CreateIndex
CREATE INDEX "advance_requests_state_location_id_idx" ON "advance_requests"("state", "location_id");

-- CreateIndex
CREATE INDEX "advance_requests_company_id_idx" ON "advance_requests"("company_id");

-- CreateIndex
CREATE INDEX "shift_change_requests_employee_id_state_idx" ON "shift_change_requests"("employee_id", "state");

-- CreateIndex
CREATE INDEX "shift_change_requests_company_id_idx" ON "shift_change_requests"("company_id");

-- CreateIndex
CREATE INDEX "salary_requests_employee_id_state_idx" ON "salary_requests"("employee_id", "state");

-- CreateIndex
CREATE INDEX "salary_requests_company_id_idx" ON "salary_requests"("company_id");

-- CreateIndex
CREATE INDEX "certificate_requests_employee_id_state_idx" ON "certificate_requests"("employee_id", "state");

-- CreateIndex
CREATE INDEX "certificate_requests_company_id_idx" ON "certificate_requests"("company_id");

-- CreateIndex
CREATE INDEX "attendance_edit_requests_employee_id_state_idx" ON "attendance_edit_requests"("employee_id", "state");

-- CreateIndex
CREATE INDEX "attendance_edit_requests_company_id_idx" ON "attendance_edit_requests"("company_id");

-- CreateIndex
CREATE INDEX "overtime_analyses_state_idx" ON "overtime_analyses"("state");

-- CreateIndex
CREATE INDEX "overtime_analyses_company_id_idx" ON "overtime_analyses"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_analyses_employee_id_date_key" ON "overtime_analyses"("employee_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "hiring_appointments_employee_profile_id_key" ON "hiring_appointments"("employee_profile_id");

-- CreateIndex
CREATE INDEX "hiring_appointments_location_id_status_idx" ON "hiring_appointments"("location_id", "status");

-- CreateIndex
CREATE INDEX "hiring_appointments_created_by_user_id_idx" ON "hiring_appointments"("created_by_user_id");

-- CreateIndex
CREATE INDEX "hiring_appointments_status_hr_seen_at_idx" ON "hiring_appointments"("status", "hr_seen_at");

-- CreateIndex
CREATE INDEX "hiring_appointments_company_id_idx" ON "hiring_appointments"("company_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feature_grants" ADD CONSTRAINT "user_feature_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feature_grants" ADD CONSTRAINT "user_feature_grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feature_grants" ADD CONSTRAINT "user_feature_grants_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_notification_reads" ADD CONSTRAINT "dashboard_notification_reads_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "employee_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_insurance_company_id_fkey" FOREIGN KEY ("insurance_company_id") REFERENCES "insurance_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_medical_insurance_company_id_fkey" FOREIGN KEY ("medical_insurance_company_id") REFERENCES "insurance_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custody_types" ADD CONSTRAINT "custody_types_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_custodies" ADD CONSTRAINT "employee_custodies_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_custodies" ADD CONSTRAINT "employee_custodies_custody_type_id_fkey" FOREIGN KEY ("custody_type_id") REFERENCES "custody_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_custodies" ADD CONSTRAINT "employee_custodies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_manager_employee_id_fkey" FOREIGN KEY ("manager_employee_id") REFERENCES "employee_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_companies" ADD CONSTRAINT "insurance_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_titles" ADD CONSTRAINT "job_titles_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "job_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_titles" ADD CONSTRAINT "job_titles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_levels" ADD CONSTRAINT "job_levels_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_reasons" ADD CONSTRAINT "archive_reasons_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biotime_config" ADD CONSTRAINT "biotime_config_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_mappings" ADD CONSTRAINT "department_mappings_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_mappings" ADD CONSTRAINT "department_mappings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mappings" ADD CONSTRAINT "employee_mappings_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_mappings" ADD CONSTRAINT "employee_mappings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_saturday_shift_id_fkey" FOREIGN KEY ("saturday_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_sunday_shift_id_fkey" FOREIGN KEY ("sunday_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_monday_shift_id_fkey" FOREIGN KEY ("monday_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_tuesday_shift_id_fkey" FOREIGN KEY ("tuesday_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_wednesday_shift_id_fkey" FOREIGN KEY ("wednesday_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_thursday_shift_id_fkey" FOREIGN KEY ("thursday_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_friday_shift_id_fkey" FOREIGN KEY ("friday_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grids" ADD CONSTRAINT "shift_grids_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grids" ADD CONSTRAINT "shift_grids_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grids" ADD CONSTRAINT "shift_grids_merged_into_grid_id_fkey" FOREIGN KEY ("merged_into_grid_id") REFERENCES "shift_grids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grids" ADD CONSTRAINT "shift_grids_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grid_lines" ADD CONSTRAINT "shift_grid_lines_grid_id_fkey" FOREIGN KEY ("grid_id") REFERENCES "shift_grids"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grid_lines" ADD CONSTRAINT "shift_grid_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grid_lines" ADD CONSTRAINT "shift_grid_lines_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grid_lines" ADD CONSTRAINT "shift_grid_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grid_manual_ot_lines" ADD CONSTRAINT "shift_grid_manual_ot_lines_grid_id_fkey" FOREIGN KEY ("grid_id") REFERENCES "shift_grids"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grid_manual_ot_lines" ADD CONSTRAINT "shift_grid_manual_ot_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_grid_manual_ot_lines" ADD CONSTRAINT "shift_grid_manual_ot_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odoo_config" ADD CONSTRAINT "odoo_config_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odoo_sync_maps" ADD CONSTRAINT "odoo_sync_maps_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_grid_id_fkey" FOREIGN KEY ("grid_id") REFERENCES "shift_grids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_shift_grid_id_fkey" FOREIGN KEY ("shift_grid_id") REFERENCES "shift_grids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_payroll_id_fkey" FOREIGN KEY ("payroll_id") REFERENCES "payrolls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_payroll_id_fkey" FOREIGN KEY ("payroll_id") REFERENCES "payrolls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_payroll_line_id_fkey" FOREIGN KEY ("payroll_line_id") REFERENCES "payroll_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_counters" ADD CONSTRAINT "system_counters_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch_report_imports" ADD CONSTRAINT "punch_report_imports_shift_grid_id_fkey" FOREIGN KEY ("shift_grid_id") REFERENCES "shift_grids"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch_report_imports" ADD CONSTRAINT "punch_report_imports_payroll_id_fkey" FOREIGN KEY ("payroll_id") REFERENCES "payrolls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch_report_imports" ADD CONSTRAINT "punch_report_imports_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_imports" ADD CONSTRAINT "advance_loan_imports_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_imports" ADD CONSTRAINT "advance_loan_imports_source_grid_id_fkey" FOREIGN KEY ("source_grid_id") REFERENCES "shift_grids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_imports" ADD CONSTRAINT "advance_loan_imports_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_import_lines" ADD CONSTRAINT "advance_loan_import_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "advance_loan_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_import_lines" ADD CONSTRAINT "advance_loan_import_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_import_lines" ADD CONSTRAINT "advance_loan_import_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advances_short" ADD CONSTRAINT "advances_short_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advances_short" ADD CONSTRAINT "advances_short_source_grid_id_fkey" FOREIGN KEY ("source_grid_id") REFERENCES "shift_grids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advances_short" ADD CONSTRAINT "advances_short_payroll_id_fkey" FOREIGN KEY ("payroll_id") REFERENCES "payrolls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advances_short" ADD CONSTRAINT "advances_short_payroll_line_id_fkey" FOREIGN KEY ("payroll_line_id") REFERENCES "payroll_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advances_short" ADD CONSTRAINT "advances_short_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advances_long" ADD CONSTRAINT "advances_long_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advances_long" ADD CONSTRAINT "advances_long_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_long_payments" ADD CONSTRAINT "advance_long_payments_advance_id_fkey" FOREIGN KEY ("advance_id") REFERENCES "advances_long"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_long_payments" ADD CONSTRAINT "advance_long_payments_payroll_id_fkey" FOREIGN KEY ("payroll_id") REFERENCES "payrolls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_long_payments" ADD CONSTRAINT "advance_long_payments_payroll_line_id_fkey" FOREIGN KEY ("payroll_line_id") REFERENCES "payroll_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_long_payments" ADD CONSTRAINT "advance_long_payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_requests" ADD CONSTRAINT "loan_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_requests" ADD CONSTRAINT "loan_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_requests" ADD CONSTRAINT "advance_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_requests" ADD CONSTRAINT "advance_requests_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_requests" ADD CONSTRAINT "advance_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_change_requests" ADD CONSTRAINT "shift_change_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_change_requests" ADD CONSTRAINT "shift_change_requests_current_shift_id_fkey" FOREIGN KEY ("current_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_change_requests" ADD CONSTRAINT "shift_change_requests_new_shift_id_fkey" FOREIGN KEY ("new_shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_change_requests" ADD CONSTRAINT "shift_change_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_requests" ADD CONSTRAINT "salary_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_requests" ADD CONSTRAINT "salary_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_requests" ADD CONSTRAINT "certificate_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_requests" ADD CONSTRAINT "certificate_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_edit_requests" ADD CONSTRAINT "attendance_edit_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_edit_requests" ADD CONSTRAINT "attendance_edit_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_analyses" ADD CONSTRAINT "overtime_analyses_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_analyses" ADD CONSTRAINT "overtime_analyses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hiring_appointments" ADD CONSTRAINT "hiring_appointments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hiring_appointments" ADD CONSTRAINT "hiring_appointments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hiring_appointments" ADD CONSTRAINT "hiring_appointments_employee_profile_id_fkey" FOREIGN KEY ("employee_profile_id") REFERENCES "employee_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hiring_appointments" ADD CONSTRAINT "hiring_appointments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Platform admins share company_id NULL; enforce unique login among them.
CREATE UNIQUE INDEX "users_platform_login_unique" ON "users" ("login") WHERE "company_id" IS NULL;

-- Tenant users: unique login per company (Prisma @@unique covers this, but NULL company_id rows are excluded from collisions by PG NULL semantics — keep explicit tenant index too).
CREATE UNIQUE INDEX "users_company_login_unique" ON "users" ("company_id", "login") WHERE "company_id" IS NOT NULL;

-- Company codes stored lowercase; case-insensitive uniqueness via lower().
CREATE UNIQUE INDEX "companies_code_lower_unique" ON "companies" (lower("code"));
