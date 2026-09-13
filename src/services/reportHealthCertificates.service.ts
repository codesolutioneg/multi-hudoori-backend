/**
 * Report 5 — health certificates (الشهادات الصحية).
 *
 * healthCertificate.service already powers the dashboard alert for "expired or
 * expiring within 15 days", but it has no export, no mode filter and no way to
 * change the window. HR asked for expired ones to renew, and confirmed 15 days
 * as the warning window, so both modes are selectable and the window is a
 * parameter defaulting to 15.
 *
 * Employees with no certificate on file are their own mode: they are a different
 * action (issue a first certificate) from a renewal.
 */
import { prisma } from '../prisma/client';
import {
  applyNationalIdGate,
  dateOnly,
  employeeScopeWhere,
  identityCells,
  IDENTITY_HEADERS,
  REPORT_EMPLOYEE_INCLUDE,
  yesNo,
  type EmployeeScopeFilters,
} from './hrReports.service';
import { buildReportWorkbook, type ReportFile } from './hrReportsExcel.service';
import { addUtcDays, utcDateOnly } from '../utils/payrollPeriod';

export const HEALTH_CERT_MODES = ['expired', 'expiring', 'expired_or_expiring', 'missing', 'all'] as const;
export type HealthCertMode = (typeof HEALTH_CERT_MODES)[number];

export function parseHealthCertMode(value: unknown): HealthCertMode {
  const raw = String(value ?? '').trim();
  return (HEALTH_CERT_MODES as readonly string[]).includes(raw)
    ? (raw as HealthCertMode)
    : 'expired_or_expiring';
}

export const DEFAULT_EXPIRY_WARNING_DAYS = 15;

export type HealthCertReportOptions = EmployeeScopeFilters & {
  mode?: HealthCertMode;
  /** Days ahead to treat a certificate as expiring soon. Defaults to 15. */
  warningDays?: number;
};

export type HealthCertStatus = 'expired' | 'expiring' | 'valid' | 'missing';

export type HealthCertReportRow = {
  employeeId: string;
  code: string;
  name: string;
  locationName: string;
  departmentName: string;
  nationalId: string;
  hasCertificate: boolean;
  issueDate: string;
  expiryDate: string;
  daysRemaining: number | '';
  status: HealthCertStatus;
  statusLabel: string;
};

function statusLabel(status: HealthCertStatus, daysRemaining: number | ''): string {
  switch (status) {
    case 'missing':
      return 'لا توجد شهادة';
    case 'expired':
      return daysRemaining === '' ? 'منتهية' : `منتهية من ${Math.abs(Number(daysRemaining))} يوم`;
    case 'expiring':
      return `تنتهي بعد ${daysRemaining} يوم`;
    default:
      return 'سارية';
  }
}

function matchesMode(status: HealthCertStatus, mode: HealthCertMode): boolean {
  switch (mode) {
    case 'expired':
      return status === 'expired';
    case 'expiring':
      return status === 'expiring';
    case 'expired_or_expiring':
      return status === 'expired' || status === 'expiring';
    case 'missing':
      return status === 'missing';
    default:
      return true;
  }
}

export async function buildHealthCertReport(
  options: HealthCertReportOptions,
): Promise<HealthCertReportRow[]> {
  const mode = options.mode ?? 'expired_or_expiring';
  const warningDays = Math.max(0, Math.round(options.warningDays ?? DEFAULT_EXPIRY_WARNING_DAYS));
  const today = utcDateOnly(new Date());
  const warnCutoff = addUtcDays(today, warningDays);

  const employees = applyNationalIdGate(
    await prisma.employeeProfile.findMany({
      where: employeeScopeWhere(options),
      include: REPORT_EMPLOYEE_INCLUDE,
      orderBy: [{ healthCertificateExpiryDate: 'asc' }, { name: 'asc' }],
    }),
    options.requireNationalId,
  );

  const rows: HealthCertReportRow[] = [];
  for (const emp of employees) {
    const expiry = emp.healthCertificateExpiryDate;
    let status: HealthCertStatus;
    let daysRemaining: number | '' = '';

    if (!emp.healthCertificate || !expiry) {
      status = 'missing';
    } else {
      const expiryDay = utcDateOnly(expiry);
      daysRemaining = Math.round((expiryDay.getTime() - today.getTime()) / 86400000);
      // Expiring on today's date still needs renewing today, so treat <= 0 as expired.
      if (daysRemaining <= 0) status = 'expired';
      else if (expiryDay.getTime() <= warnCutoff.getTime()) status = 'expiring';
      else status = 'valid';
    }

    if (!matchesMode(status, mode)) continue;

    const identity = identityCells(emp);
    rows.push({
      employeeId: emp.id,
      locationName: identity[0],
      departmentName: identity[1],
      code: identity[2],
      name: identity[3],
      nationalId: identity[4],
      hasCertificate: emp.healthCertificate,
      issueDate: dateOnly(emp.healthCertificateIssueDate),
      expiryDate: dateOnly(expiry),
      daysRemaining,
      status,
      statusLabel: statusLabel(status, daysRemaining),
    });
  }
  return rows;
}

const HEADERS = [
  ...IDENTITY_HEADERS,
  'يوجد شهادة',
  'تاريخ الصدور',
  'تاريخ الانتهاء',
  'الأيام المتبقية',
  'الحالة',
] as const;

const MODE_LABELS: Record<HealthCertMode, string> = {
  expired: 'المنتهية فقط',
  expiring: 'القريبة من الانتهاء فقط',
  expired_or_expiring: 'المنتهية والقريبة من الانتهاء',
  missing: 'من ليس لها شهادة',
  all: 'الكل',
};

export async function exportHealthCertReportXlsx(
  options: HealthCertReportOptions,
): Promise<ReportFile> {
  const rows = await buildHealthCertReport(options);
  const warningDays = Math.max(0, Math.round(options.warningDays ?? DEFAULT_EXPIRY_WARNING_DAYS));

  return buildReportWorkbook(
    [
      {
        title: 'الشهادات الصحية',
        criteria: [
          `العرض: ${MODE_LABELS[options.mode ?? 'expired_or_expiring']}`,
          `تُعتبر قريبة من الانتهاء قبل: ${warningDays} يوم`,
          `بشرط وجود رقم قومي: ${yesNo(Boolean(options.requireNationalId))}`,
          `عدد النتائج: ${rows.length}`,
        ],
        headers: HEADERS,
        rows: rows.map((r) => [
          r.locationName,
          r.departmentName,
          r.code,
          r.name,
          r.nationalId,
          yesNo(r.hasCertificate),
          r.issueDate,
          r.expiryDate,
          r.daysRemaining,
          r.statusLabel,
        ]),
        alertRows: new Set(
          rows
            .map((r, i) => (r.status === 'expired' || r.status === 'missing' ? i : -1))
            .filter((i) => i >= 0),
        ),
        emptyMessage: 'لا توجد شهادات تحتاج إجراء',
      },
    ],
    'report_health_certificates',
  );
}
