/**
 * Report — employee work emails + HR-visible passwords (credentials sheet).
 */
import {
  findReportEmployees,
  reportEmployeeCode,
  reportEmployeeName,
  type EmployeeScopeFilters,
} from './hrReports.service';
import { buildReportWorkbook, type ReportFile } from './hrReportsExcel.service';

export type EmployeeEmailsReportRow = {
  employeeId: string;
  code: string;
  name: string;
  locationName: string;
  departmentName: string;
  workEmail: string;
  workEmailPassword: string;
  hasPassword: boolean;
};

export async function buildEmployeeEmailsReport(
  options: EmployeeScopeFilters,
): Promise<EmployeeEmailsReportRow[]> {
  const employees = await findReportEmployees(options);
  const rows: EmployeeEmailsReportRow[] = [];

  for (const emp of employees) {
    const workEmail = emp.workEmail?.trim() ?? '';
    if (!workEmail) continue;
    const workEmailPassword = emp.workEmailPassword?.trim() ?? '';
    rows.push({
      employeeId: emp.id,
      code: reportEmployeeCode(emp),
      name: reportEmployeeName(emp),
      locationName: emp.workLocation?.name ?? emp.location ?? '',
      departmentName: emp.department?.name ?? '',
      workEmail,
      workEmailPassword,
      hasPassword: Boolean(workEmailPassword),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return rows;
}

export async function exportEmployeeEmailsReportXlsx(
  options: EmployeeScopeFilters,
): Promise<ReportFile> {
  const rows = await buildEmployeeEmailsReport(options);
  const headers = [
    'الفرع',
    'القسم',
    'الكود',
    'الاسم',
    'الإيميل',
    'كلمة المرور',
  ] as const;

  return buildReportWorkbook(
    [
      {
        title: 'إيميلات الموظفين',
        criteria: [
          'الموظفون الذين لديهم work email',
          `عدد النتائج: ${rows.length}`,
        ],
        headers,
        rows: rows.map((r) => [
          r.locationName,
          r.departmentName,
          r.code,
          r.name,
          r.workEmail,
          r.workEmailPassword || '—',
        ]),
        alertRows: new Set(
          rows.map((r, i) => (r.hasPassword ? -1 : i)).filter((i) => i >= 0),
        ),
        emptyMessage: 'لا يوجد موظفون بإيميل في النطاق المحدد',
      },
    ],
    'report_employee_emails',
  );
}
