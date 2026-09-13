/**
 * Report 4 — missing paperwork (نواقص الأوراق).
 *
 * HR drives this with a checklist: "I can pick health certificates only, or the
 * criminal record only". So the required set is a parameter, and completeness is
 * judged against that selection rather than against every document type. With
 * nothing selected the whole list is required, which is the common case.
 *
 * Health certificate is included as a selectable requirement because HR listed
 * it among the documents to filter by, even though it also has its own report.
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

export const REPORT_DOCUMENT_TYPES = [
  'qualification',
  'birth_certificate',
  'military',
  'criminal_record',
  'id_card',
  'personal_photo',
  'insurance_print',
  'work_stub',
  'health_certificate',
] as const;
export type ReportDocumentType = (typeof REPORT_DOCUMENT_TYPES)[number];

export const DOCUMENT_LABELS: Record<ReportDocumentType, string> = {
  qualification: 'المؤهل',
  birth_certificate: 'شهادة الميلاد',
  military: 'الموقف من التجنيد',
  criminal_record: 'الفيش الجنائي',
  id_card: 'صورة البطاقة',
  personal_photo: 'الصور الشخصية',
  insurance_print: 'طبعة التأمين',
  work_stub: 'كعب العمل',
  health_certificate: 'الشهادة الصحية',
};

export function parseDocumentTypes(value: unknown): ReportDocumentType[] {
  const raw = Array.isArray(value) ? value : [];
  const picked = raw
    .map((v) => String(v ?? '').trim())
    .filter((v): v is ReportDocumentType =>
      (REPORT_DOCUMENT_TYPES as readonly string[]).includes(v),
    );
  // Empty selection means "every document", which is what HR wants by default.
  return picked.length > 0 ? [...new Set(picked)] : [...REPORT_DOCUMENT_TYPES];
}

export const DOCUMENT_FILTERS = ['all', 'incomplete', 'complete'] as const;
export type DocumentFilter = (typeof DOCUMENT_FILTERS)[number];

export function parseDocumentFilter(value: unknown): DocumentFilter {
  const raw = String(value ?? '').trim();
  return (DOCUMENT_FILTERS as readonly string[]).includes(raw)
    ? (raw as DocumentFilter)
    : 'incomplete';
}

/**
 * How selected missing docs match an employee when filter=incomplete:
 * - any (default): missing at least one of the selected types (OR)
 * - all: missing every selected type at once (AND) — rarely what HR wants
 */
export const DOCUMENT_MATCH_MODES = ['any', 'all'] as const;
export type DocumentMatchMode = (typeof DOCUMENT_MATCH_MODES)[number];

export function parseDocumentMatchMode(value: unknown): DocumentMatchMode {
  const raw = String(value ?? '').trim();
  return (DOCUMENT_MATCH_MODES as readonly string[]).includes(raw)
    ? (raw as DocumentMatchMode)
    : 'any';
}

export type DocumentsReportOptions = EmployeeScopeFilters & {
  requiredDocuments?: ReportDocumentType[];
  filter?: DocumentFilter;
  matchMode?: DocumentMatchMode;
  /** Count a photocopy as satisfying a requirement. On by default. */
  acceptCopies?: boolean;
};

export type DocumentsReportRow = {
  employeeId: string;
  code: string;
  name: string;
  locationName: string;
  departmentName: string;
  nationalId: string;
  present: Record<ReportDocumentType, boolean>;
  missing: ReportDocumentType[];
  /** Arabic labels for missing docs — for UI tables. */
  missingLabels: string;
  missingCount: number;
  complete: boolean;
  hiringDate: string;
};

/**
 * Documents are modelled two ways: a `*DocStatus` string of none/copy/original
 * on the newer types, and a plain boolean on the rest. Where a status exists it
 * wins, since the boolean is only kept in sync for legacy rows.
 */
function documentPresent(
  emp: EmployeeWithReportRelations,
  type: ReportDocumentType,
  acceptCopies: boolean,
): boolean {
  const hasUrl = (url: string | null | undefined): boolean => Boolean(url?.trim());

  const fromStatus = (status: string | null | undefined, legacy: boolean, url?: string | null): boolean => {
    if (hasUrl(url)) return true;
    const value = status?.trim();
    if (!value || value === 'none') return legacy && acceptCopies;
    if (value === 'copy') return acceptCopies;
    return true;
  };

  switch (type) {
    case 'qualification':
      return fromStatus(emp.qualificationDocStatus, emp.qualificationOriginal, emp.qualificationDocUrl);
    case 'birth_certificate':
      return fromStatus(
        emp.birthCertificateDocStatus,
        emp.birthCertificateOriginal,
        emp.birthCertificateDocUrl,
      );
    case 'military':
      return fromStatus(emp.militaryDocStatus, emp.militaryServiceDoc, emp.militaryDocUrl);
    case 'criminal_record':
      return emp.criminalRecord || hasUrl(emp.criminalRecordDocUrl);
    case 'id_card':
      return emp.idCardPhoto || hasUrl(emp.idCardPhotoUrl);
    case 'personal_photo':
      return emp.personalPhoto || (emp.personalPhotoCount ?? 0) > 0 || hasUrl(emp.personalPhotoDocUrl);
    case 'insurance_print':
      return emp.insurancePrint || hasUrl(emp.insurancePrintUrl);
    case 'work_stub':
      return emp.workStub;
    case 'health_certificate':
      return emp.healthCertificate;
    default:
      return false;
  }
}

export async function buildDocumentsReport(
  options: DocumentsReportOptions,
): Promise<{ rows: DocumentsReportRow[]; required: ReportDocumentType[] }> {
  const employees = await findReportEmployees(options);
  const required = options.requiredDocuments?.length
    ? options.requiredDocuments
    : [...REPORT_DOCUMENT_TYPES];
  const acceptCopies = options.acceptCopies !== false;
  const filter = options.filter ?? 'incomplete';

  const rows: DocumentsReportRow[] = [];
  for (const emp of employees) {
    const present = {} as Record<ReportDocumentType, boolean>;
    for (const type of REPORT_DOCUMENT_TYPES) {
      present[type] = documentPresent(emp, type, acceptCopies);
    }
    const missing = required.filter((type) => !present[type]);
    const complete = missing.length === 0;
    // incomplete: anyone missing at least one of the selected docs (OR — never AND)
    if (filter === 'incomplete' && complete) continue;
    if (filter === 'complete' && !complete) continue;

    const identity = identityCells(emp);
    rows.push({
      employeeId: emp.id,
      locationName: identity[0],
      departmentName: identity[1],
      code: identity[2],
      name: identity[3],
      nationalId: identity[4],
      present,
      missing,
      missingLabels: missing.map((t) => DOCUMENT_LABELS[t]).join('، '),
      missingCount: missing.length,
      complete,
      hiringDate: dateOnly(emp.hiringDate),
    });
  }

  // Fewest missing first so "missing one of nine" is not buried under full gaps.
  rows.sort((a, b) => {
    if (a.missingCount !== b.missingCount) return a.missingCount - b.missingCount;
    return a.name.localeCompare(b.name, 'ar');
  });

  return { rows, required };
}

const FILTER_LABELS: Record<DocumentFilter, string> = {
  all: 'الكل',
  incomplete: 'الناقص فقط',
  complete: 'المكتمل فقط',
};

export async function exportDocumentsReportXlsx(
  options: DocumentsReportOptions,
): Promise<ReportFile> {
  const { rows, required } = await buildDocumentsReport(options);

  // Only the selected documents get a column, so the sheet stays readable when
  // HR asks about one document.
  const headers = [
    ...IDENTITY_HEADERS,
    ...required.map((type) => DOCUMENT_LABELS[type]),
    'الورق مكتمل',
    'عدد النواقص',
    'النواقص',
    'تاريخ التعيين',
  ];

  return buildReportWorkbook(
    [
      {
        title: 'نواقص الأوراق',
        criteria: [
          `الورق المطلوب: ${required.map((t) => DOCUMENT_LABELS[t]).join('، ')}`,
          `العرض: ${FILTER_LABELS[options.filter ?? 'incomplete']}`,
          `طريقة المطابقة: أي ورقة ناقصة من المختار (أو) — وليس بالضرورة كلها`,
          `الصورة تُقبل بدل الأصل: ${yesNo(options.acceptCopies !== false)}`,
          `بشرط وجود رقم قومي: ${yesNo(Boolean(options.requireNationalId))}`,
          `عدد النتائج: ${rows.length}`,
        ],
        headers,
        rows: rows.map((r) => [
          r.locationName,
          r.departmentName,
          r.code,
          r.name,
          r.nationalId,
          ...required.map((type) => yesNo(r.present[type])),
          yesNo(r.complete),
          r.missingCount,
          r.missingLabels,
          r.hiringDate,
        ]),
        alertRows: new Set(rows.map((r, i) => (r.complete ? -1 : i)).filter((i) => i >= 0)),
        emptyMessage: 'لا توجد نواقص في الورق المطلوب',
      },
    ],
    'report_documents',
  );
}
