-- Enable row-level security for multi-tenant isolation (defense in depth).
-- App sets: SET LOCAL app.company_id = '<id>';
-- Platform admin / migrations use the table owner role (bypass unless FORCE).

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'employee_profiles',
    'locations',
    'departments',
    'department_mappings',
    'employee_mappings',
    'devices',
    'transactions',
    'attendances',
    'shifts',
    'shift_assignments',
    'shift_grids',
    'shift_grid_lines',
    'shift_grid_manual_ot_lines',
    'biotime_config',
    'odoo_config',
    'odoo_sync_maps',
    'sync_jobs',
    'payrolls',
    'payroll_lines',
    'deductions',
    'punch_report_imports',
    'advance_loan_imports',
    'advance_loan_import_lines',
    'advances_short',
    'advances_long',
    'advance_long_payments',
    'leave_requests',
    'loan_requests',
    'advance_requests',
    'shift_change_requests',
    'salary_requests',
    'certificate_requests',
    'attendance_edit_requests',
    'overtime_analyses',
    'hiring_appointments',
    'custody_types',
    'employee_custodies',
    'insurance_companies',
    'job_titles',
    'job_levels',
    'archive_reasons',
    'system_counters'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (
           current_setting(''app.company_id'', true) IS NULL
           OR current_setting(''app.company_id'', true) = ''''
           OR company_id = current_setting(''app.company_id'', true)
         )
         WITH CHECK (
           current_setting(''app.company_id'', true) IS NULL
           OR current_setting(''app.company_id'', true) = ''''
           OR company_id = current_setting(''app.company_id'', true)
         )',
      t
    );
  END LOOP;
END $$;

-- Users / tokens / audit: optional company_id (platform rows allowed)
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['users', 'api_tokens', 'audit_logs', 'user_feature_grants', 'dashboard_notification_reads'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (
           current_setting(''app.company_id'', true) IS NULL
           OR current_setting(''app.company_id'', true) = ''''
           OR company_id IS NULL
           OR company_id = current_setting(''app.company_id'', true)
         )
         WITH CHECK (
           current_setting(''app.company_id'', true) IS NULL
           OR current_setting(''app.company_id'', true) = ''''
           OR company_id IS NULL
           OR company_id = current_setting(''app.company_id'', true)
         )',
      t
    );
  END LOOP;
END $$;
