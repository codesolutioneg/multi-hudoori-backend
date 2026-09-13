/**
 * Report 2 — Fawry card coverage (كروت فوري).
 *
 * HR's requirement is not just "who has a card": a ticked flag with no number
 * next to it is bad data, not coverage. That case is reported as its own status
 * and highlighted, because it silently breaks the Fawry payroll export, which
 * pays on `hasFawryAccount` while taking the phone from `fawryAccount`
 * (payrollExport.service.ts fawryWorkPhone).
 */
import {
  dateOnly,
  findReportEmployees,
  identityCells,
  IDENTITY_HEADERS,
  yesNo,
  type EmployeeScopeFilters,
  type EmployeeWithReportRelations,
} from './hrReports.service';
import { buildReportWorkbook, type ReportFile } from './hrReportsExcel.service';

export const FAWRY_FILTERS = ['all', 'with_card', 'without_card', 'data_errors'] as const;
export type FawryFilter = (typeof FAWRY_FILTERS)[number];

export function parseFawryFilter(value: unknown): FawryFilter {
  const raw = String(value ?? '').trim();
  return (FAWRY_FILTERS as readonly string[]).includes(raw) ? (raw as FawryFilter) : 'all';
}

export type FawryReportOptions = EmployeeScopeFilters & {
  filter?: FawryFilter;
};

export type FawryStatus = 'complete' | 'missing_number' | 'number_without_flag' | 'none';

/** Where the number shown in the report came from. */
export type FawryNumberSource =
  | 'fawry'
  | 'work_phone'
  | 'mobile_phone'
  | 'biotime_mobile'
  | 'none';

export type FawryReportRow = {
  employeeId: string;
  code: string;
  name: string;
  locationName: string;
  departmentName: string;
  nationalId: string;
  hasFlag: boolean;
  /**
   * Number to reach the employee on: the stored Fawry number, else a phone.
   * `numberSource === 'fawry'` is what says whether it is the real thing.
   */
  fawryNumber: string;
  numberSource: FawryNumberSource;
  numberSourceLabel: string;
  status: FawryStatus;
  statusLabel: string;
  hiringDate: string;
};

const STATUS_LABELS: Record<FawryStatus, string> = {
  complete: 'معاه فوري',
  missing_number: 'العلامة موضوعة والرقم فارغ',
  number_without_flag: 'يوجد رقم والعلامة غير موضوعة',
  none: 'ليس لديه فوري',
};

const NUMBER_SOURCE_LABELS: Record<FawryNumberSource, string> = {
  fawry: 'رقم فوري مسجّل',
  work_phone: 'تليفون العمل',
  mobile_phone: 'الموبايل',
  biotime_mobile: 'موبايل من BioTime',
  none: 'لا يوجد رقم',
};

/**
 * The number column has to be usable: `fawryAccount` is only ever filled by
 * hand (profile form / employees Excel) and the Odoo pull never sets it, so an
 * empty cell here means "nobody typed it in", not "no way to reach this person".
 * Fall back to the phones HR already has, and report which one was used so a
 * fallback is never mistaken for a confirmed Fawry number.
 *
 * Work phone comes before the mobiles because that is the number the Fawry
 * payroll export pays on (payrollExport.service.ts fawryWorkPhone). The
 * employees Excel prefers the mobile instead, which is right for a contact
 * sheet but wrong here.
 */
export function resolveFawryNumber(
  emp: Pick<EmployeeWithReportRelations, 'fawryAccount' | 'workPhone' | 'mobilePhone' | 'mapping'>,
): { number: string; source: FawryNumberSource } {
  const candidates: [string, FawryNumberSource][] = [
    [emp.fawryAccount?.trim() ?? '', 'fawry'],
    [emp.workPhone?.trim() ?? '', 'work_phone'],
    [emp.mobilePhone?.trim() ?? '', 'mobile_phone'],
    [emp.mapping?.mobile?.trim() ?? '', 'biotime_mobile'],
  ];
  for (const [number, source] of candidates) {
    if (number) return { number, source };
  }
  return { number: '', source: 'none' };
}

/** A flag without a number, or a number without a flag, is a data entry error. */
export function isFawryDataError(status: FawryStatus): boolean {
  return status === 'missing_number' || status === 'number_without_flag';
}

function resolveStatus(hasFlag: boolean, number: string): FawryStatus {
  if (hasFlag && number) return 'complete';
  if (hasFlag && !number) return 'missing_number';
  if (!hasFlag && number) return 'number_without_flag';
  return 'none';
}

function matchesFilter(status: FawryStatus, filter: FawryFilter): boolean {
  switch (filter) {
    case 'with_card':
      return status === 'complete';
    case 'without_card':
      return status === 'none' || status === 'missing_number';
    case 'data_errors':
      return isFawryDataError(status);
    default:
      return true;
  }
}

export async function buildFawryReport(
  options: FawryReportOptions,
): Promise<FawryReportRow[]> {
  const employees = await findReportEmployees(options);
  const filter = options.filter ?? 'all';

  const rows: FawryReportRow[] = [];
  for (const emp of employees) {
    const stored = emp.fawryAccount?.trim() ?? '';
    // Status is judged on the stored number only, so the data-error filter keeps
    // surfacing records nobody has filled in even though a phone is shown.
    const status = resolveStatus(emp.hasFawryAccount, stored);
    if (!matchesFilter(status, filter)) continue;

    const identity = identityCells(emp);
    const { number, source } = resolveFawryNumber(emp);
    rows.push({
      employeeId: emp.id,
      locationName: identity[0],
      departmentName: identity[1],
      code: identity[2],
      name: identity[3],
      nationalId: identity[4],
      hasFlag: emp.hasFawryAccount,
      fawryNumber: number,
      numberSource: source,
      numberSourceLabel: NUMBER_SOURCE_LABELS[source],
      status,
      statusLabel: STATUS_LABELS[status],
      hiringDate: dateOnly(emp.hiringDate),
    });
  }
  return rows;
}

const HEADERS = [
  ...IDENTITY_HEADERS,
  'علامة فوري',
  'رقم فوري',
  // A fallback phone must never be mistaken for a confirmed Fawry number.
  'مصدر الرقم',
  'الحالة',
  'تاريخ التعيين',
] as const;

const FILTER_LABELS: Record<FawryFilter, string> = {
  all: 'الكل',
  with_card: 'من لديهم فوري',
  without_card: 'من ليس لديهم فوري',
  data_errors: 'أخطاء بيانات فقط',
};

export async function exportFawryReportXlsx(
  options: FawryReportOptions,
): Promise<ReportFile> {
  const rows = await buildFawryReport(options);
  const errorCount = rows.filter((r) => isFawryDataError(r.status)).length;
  const fallbackCount = rows.filter(
    (r) => r.numberSource !== 'fawry' && r.numberSource !== 'none',
  ).length;
  const noNumberCount = rows.filter((r) => r.numberSource === 'none').length;

  return buildReportWorkbook(
    [
      {
        title: 'كروت فوري',
        criteria: [
          `العرض: ${FILTER_LABELS[options.filter ?? 'all']}`,
          `بشرط وجود رقم قومي: ${yesNo(Boolean(options.requireNationalId))}`,
          `عدد النتائج: ${rows.length}`,
          `أخطاء بيانات تحتاج مراجعة: ${errorCount}`,
          `الرقم مأخوذ من التليفون: ${fallbackCount} | بدون أي رقم: ${noNumberCount}`,
        ],
        headers: HEADERS,
        rows: rows.map((r) => [
          r.locationName,
          r.departmentName,
          r.code,
          r.name,
          r.nationalId,
          yesNo(r.hasFlag),
          r.fawryNumber,
          r.numberSourceLabel,
          r.statusLabel,
          r.hiringDate,
        ]),
        alertRows: new Set(
          rows.map((r, i) => (isFawryDataError(r.status) ? i : -1)).filter((i) => i >= 0),
        ),
        emptyMessage: 'لا توجد نتائج',
      },
    ],
    'report_fawry',
  );
}
