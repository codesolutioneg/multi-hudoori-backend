/**
 * Report 3 — insurance status (الموقف التأميني).
 *
 * HR asked for social and medical each on their own, so `kind` selects one or
 * both, and "both" writes two sheets rather than interleaving the columns.
 *
 * The employees export already carried status, number and salary but never the
 * company name, which is half of what HR asked for ("متأمن عليه فين"). That
 * relation is included here.
 */
import {
  findReportEmployees,
  identityCells,
  IDENTITY_HEADERS,
  yesNo,
  type EmployeeScopeFilters,
  type EmployeeWithReportRelations,
} from './hrReports.service';
import { buildReportWorkbook, type ReportFile, type ReportSheet } from './hrReportsExcel.service';

export const INSURANCE_KINDS = ['social', 'medical', 'both'] as const;
export type InsuranceKind = (typeof INSURANCE_KINDS)[number];

export const INSURANCE_FILTERS = ['all', 'insured', 'not_insured'] as const;
export type InsuranceFilter = (typeof INSURANCE_FILTERS)[number];

export function parseInsuranceKind(value: unknown): InsuranceKind {
  const raw = String(value ?? '').trim();
  return (INSURANCE_KINDS as readonly string[]).includes(raw) ? (raw as InsuranceKind) : 'both';
}

export function parseInsuranceFilter(value: unknown): InsuranceFilter {
  const raw = String(value ?? '').trim();
  return (INSURANCE_FILTERS as readonly string[]).includes(raw)
    ? (raw as InsuranceFilter)
    : 'all';
}

export type InsuranceReportOptions = EmployeeScopeFilters & {
  kind?: InsuranceKind;
  filter?: InsuranceFilter;
};

export type InsuranceReportRow = {
  employeeId: string;
  code: string;
  name: string;
  locationName: string;
  departmentName: string;
  nationalId: string;
  insured: boolean;
  status: string;
  companyName: string;
  insuredSalary: number;
  insuranceNumber: string;
  basicSalary: number;
};

/**
 * "Insured" means a company is on file. The status text alone is unreliable:
 * it is a free-text enum that can read "مؤمن عليه" with no company attached,
 * which is not something HR can act on.
 */
function isInsured(companyId: string | null, status: string | null): boolean {
  if (companyId) return true;
  const text = status?.trim() ?? '';
  return text !== '' && text !== 'غير مؤمن عليه' && text !== 'not_insured';
}

function socialRow(emp: EmployeeWithReportRelations): InsuranceReportRow {
  const identity = identityCells(emp);
  return {
    employeeId: emp.id,
    locationName: identity[0],
    departmentName: identity[1],
    code: identity[2],
    name: identity[3],
    nationalId: identity[4],
    insured: isInsured(emp.insuranceCompanyId, emp.insuranceStatus),
    status: emp.insuranceStatus?.trim() ?? '',
    companyName: emp.insuranceCompany?.name ?? '',
    insuredSalary: emp.insuranceSalary ?? 0,
    insuranceNumber: emp.insuranceNumber?.trim() ?? '',
    basicSalary: emp.basicSalary ?? 0,
  };
}

function medicalRow(emp: EmployeeWithReportRelations): InsuranceReportRow {
  const identity = identityCells(emp);
  return {
    employeeId: emp.id,
    locationName: identity[0],
    departmentName: identity[1],
    code: identity[2],
    name: identity[3],
    nationalId: identity[4],
    insured: isInsured(emp.medicalInsuranceCompanyId, emp.medicalInsuranceStatus),
    status: emp.medicalInsuranceStatus?.trim() ?? '',
    companyName: emp.medicalInsuranceCompany?.name ?? '',
    insuredSalary: emp.medicalInsuranceSalary ?? 0,
    insuranceNumber: '',
    basicSalary: emp.basicSalary ?? 0,
  };
}

function matchesFilter(row: InsuranceReportRow, filter: InsuranceFilter): boolean {
  if (filter === 'insured') return row.insured;
  if (filter === 'not_insured') return !row.insured;
  return true;
}

export async function buildInsuranceReport(options: InsuranceReportOptions): Promise<{
  social: InsuranceReportRow[];
  medical: InsuranceReportRow[];
}> {
  const employees = await findReportEmployees(options);
  const kind = options.kind ?? 'both';
  const filter = options.filter ?? 'all';

  const social =
    kind === 'medical'
      ? []
      : employees.map(socialRow).filter((r) => matchesFilter(r, filter));
  const medical =
    kind === 'social'
      ? []
      : employees.map(medicalRow).filter((r) => matchesFilter(r, filter));
  return { social, medical };
}

const SOCIAL_HEADERS = [
  ...IDENTITY_HEADERS,
  'متأمن عليه',
  'الموقف التأميني',
  'جهة التأمين',
  'الأجر التأميني',
  'الرقم التأميني',
  'الراتب الأساسي',
] as const;

const MEDICAL_HEADERS = [
  ...IDENTITY_HEADERS,
  'متأمن طبيًا',
  'الموقف التأميني الطبي',
  'جهة التأمين الطبي',
  'الأجر التأميني الطبي',
  'الراتب الأساسي',
] as const;

const FILTER_LABELS: Record<InsuranceFilter, string> = {
  all: 'الكل',
  insured: 'المتأمن عليهم فقط',
  not_insured: 'غير المتأمن عليهم فقط',
};

export async function exportInsuranceReportXlsx(
  options: InsuranceReportOptions,
): Promise<ReportFile> {
  const { social, medical } = await buildInsuranceReport(options);
  const kind = options.kind ?? 'both';
  const baseCriteria = (count: number) => [
    `العرض: ${FILTER_LABELS[options.filter ?? 'all']}`,
    `بشرط وجود رقم قومي: ${yesNo(Boolean(options.requireNationalId))}`,
    `عدد النتائج: ${count}`,
  ];

  const sheets: ReportSheet[] = [];
  if (kind !== 'medical') {
    sheets.push({
      title: 'التأمين الاجتماعي',
      criteria: baseCriteria(social.length),
      headers: SOCIAL_HEADERS,
      rows: social.map((r) => [
        r.locationName,
        r.departmentName,
        r.code,
        r.name,
        r.nationalId,
        yesNo(r.insured),
        r.status,
        r.companyName,
        r.insuredSalary,
        r.insuranceNumber,
        r.basicSalary,
      ]),
      alertRows: new Set(social.map((r, i) => (r.insured ? -1 : i)).filter((i) => i >= 0)),
    });
  }
  if (kind !== 'social') {
    sheets.push({
      title: 'التأمين الطبي',
      criteria: baseCriteria(medical.length),
      headers: MEDICAL_HEADERS,
      rows: medical.map((r) => [
        r.locationName,
        r.departmentName,
        r.code,
        r.name,
        r.nationalId,
        yesNo(r.insured),
        r.status,
        r.companyName,
        r.insuredSalary,
        r.basicSalary,
      ]),
      alertRows: new Set(medical.map((r, i) => (r.insured ? -1 : i)).filter((i) => i >= 0)),
    });
  }

  return buildReportWorkbook(sheets, 'report_insurance');
}
