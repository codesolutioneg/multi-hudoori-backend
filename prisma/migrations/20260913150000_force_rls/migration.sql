-- Subject table owners to RLS so policies apply for the application DB role.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'employee_profiles','locations','departments','department_mappings','employee_mappings',
    'devices','transactions','attendances','shifts','shift_assignments','shift_grids',
    'shift_grid_lines','shift_grid_manual_ot_lines','biotime_config','odoo_config',
    'odoo_sync_maps','sync_jobs','payrolls','payroll_lines','deductions','punch_report_imports',
    'advance_loan_imports','advance_loan_import_lines','advances_short','advances_long',
    'advance_long_payments','leave_requests','loan_requests','advance_requests',
    'shift_change_requests','salary_requests','certificate_requests','attendance_edit_requests',
    'overtime_analyses','hiring_appointments','custody_types','employee_custodies',
    'insurance_companies','job_titles','job_levels','archive_reasons','system_counters',
    'users','api_tokens','audit_logs','user_feature_grants','dashboard_notification_reads'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
