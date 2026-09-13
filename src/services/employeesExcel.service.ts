import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import {
  DOCUMENT_STATUS_LABELS,
  SKILL_LEVELS,
  employeeCustomFieldsJson,
  parseEmployeeCustomUpdate,
} from './employeeProfileFields.service';
import { normalizeDocumentStatus } from './employeeDocuments.service';
import { BIOTIME_PUSH_PROFILE_FIELDS } from './biotime/employeeBiotimeFingerprint';
import { resolveEmployeeDisplayName } from './serialize.service';
import { parseEgyptianNationalId } from '../utils/egyptianNationalId';

/**
 * Legacy Odoo-style employee Excel (row 1 headers RTL, data from row 2).
 * Column A (right in RTL) = Location … User ID is last (left, hidden) for re-import.
 */
const HEADERS = [
  'Location',
  'Code',
  'Name-Arabic',
  'Department',
  'Job Title',
  'Hiring Date',
  'الرقم القومي',
  'تأكيد الرقم',
  'تاريخ الميلاد',
  'العمر',
  'الهاتف',
  'أصل المؤهل',
  'أصل التجنيد',
  'أصل الميلاد',
  'صورة البطاقة',
  'الصور الشخصية',
  'برنت تأميني',
  'مستوى المؤهل',
  'كعب عمل',
  'فيش جنائي',
  'تاريخ صدور',
  'تاريخ انتهاء',
  'الموقف التأميني',
  'الرقم التأميني',
  'الأجر التأميني',
  'موقف التأمين الطبي',
  'الأجر التأميني الطبي',
  'الأجر الأساسي',
  'Basic Salary',
  'Notes',
  'Mobile Line',
  'Fawry',
  'Misr ACCOUNT',
  'رصيد الإجازات',
  'الأيام المستحقة',
  'الرصيد المتبقي',
  'User ID',
] as const;

/** Import aliases — legacy English export + Arabic headers */
const HEADER_ALIASES: Record<(typeof HEADERS)[number], readonly string[]> = {
  Location: ['Location', 'location'],
  Code: ['Code', 'code'],
  'Name-Arabic': ['Name-Arabic', 'name-arabic'],
  Department: ['Department', 'department'],
  'Job Title': ['Job Title', 'job title'],
  'Hiring Date': ['Hiring Date', 'hiring date'],
  'الرقم القومي': ['الرقم القومي', 'National ID Confirm', 'national id confirm'],
  'تأكيد الرقم': ['تأكيد الرقم', 'تأكيد الرقم القومي'],
  'تاريخ الميلاد': ['تاريخ الميلاد', 'Birthday', 'birthday'],
  العمر: ['العمر', 'Age', 'age'],
  الهاتف: ['الهاتف', 'Mobile Phone', 'Work Phone', 'mobile phone', 'work phone'],
  'أصل المؤهل': ['أصل المؤهل', 'Qualification Original', 'qualification original'],
  'أصل التجنيد': ['أصل التجنيد', 'Military Service Doc', 'military service doc'],
  'أصل الميلاد': ['أصل الميلاد', 'Birth Certificate Original', 'birth certificate original'],
  'صورة البطاقة': ['صورة البطاقة', 'ID Card Photo', 'id card photo'],
  'الصور الشخصية': ['الصور الشخصية', 'Personal Photo', 'personal photo'],
  'برنت تأميني': ['برنت تأميني', 'Insurance Print', 'insurance print'],
  'مستوى المؤهل': ['مستوى المؤهل', 'Skill Level', 'skill level'],
  'كعب عمل': ['كعب عمل', 'Work Stub', 'work stub'],
  'فيش جنائي': ['فيش جنائي', 'Criminal Record', 'criminal record'],
  'تاريخ صدور': ['تاريخ صدور', 'Health Certificate Issue Date', 'health certificate issue date'],
  'تاريخ انتهاء': ['تاريخ انتهاء', 'Health Certificate Expiry Date', 'health certificate expiry date'],
  'الموقف التأميني': ['الموقف التأميني', 'Insurance Status', 'insurance status', 'شركة التأمين الاجتماعي'],
  'الرقم التأميني': ['الرقم التأميني', 'Insurance Number', 'insurance number'],
  'الأجر التأميني': ['الأجر التأميني', 'Insurance Salary', 'insurance salary'],
  'موقف التأمين الطبي': ['موقف التأمين الطبي', 'موقف التأمين', 'Medical Insurance Status', 'medical insurance status', 'شركة التأمين الطبي'],
  'الأجر التأميني الطبي': ['الأجر التأميني الطبي', 'الاجر التأميني الطبي', 'Medical Insurance Salary', 'medical insurance salary'],
  'الأجر الأساسي': ['الأجر الأساسي'],
  'Basic Salary': ['Basic Salary', 'basic salary'],
  Notes: ['Notes', 'notes'],
  'Mobile Line': ['Mobile Line', 'mobile line'],
  Fawry: ['Fawry', 'Fawry Account', 'Fawry Phone', 'fawry account', 'fawry phone', 'houry'],
  'Misr ACCOUNT': ['Misr ACCOUNT', 'Misr Account', 'misr account'],
  'رصيد الإجازات': ['رصيد الإجازات', 'Leave Starting Balance', 'leave starting balance'],
  'الأيام المستحقة': ['الأيام المستحقة', 'Used Leave Days', 'used leave days'],
  'الرصيد المتبقي': ['الرصيد المتبقي', 'Remaining Leave Balance', 'remaining leave balance'],
  'User ID': ['User ID', 'user id', 'Employee ID', 'employee id'],
};

const RTL_HEADER_SET = new Set<string>([
  'Name-Arabic',
  'الرقم القومي',
  'تأكيد الرقم',
  'تاريخ الميلاد',
  'العمر',
  'الهاتف',
  'أصل المؤهل',
  'أصل التجنيد',
  'أصل الميلاد',
  'صورة البطاقة',
  'الصور الشخصية',
  'برنت تأميني',
  'مستوى المؤهل',
  'كعب عمل',
  'فيش جنائي',
  'تاريخ صدور',
  'تاريخ انتهاء',
  'الموقف التأميني',
  'الرقم التأميني',
  'الأجر التأميني',
  'موقف التأمين الطبي',
  'الأجر التأميني الطبي',
  'الأجر الأساسي',
  'رصيد الإجازات',
  'الأيام المستحقة',
  'الرصيد المتبقي',
  'Department',
  'Job Title',
]);

const COL_COUNT = HEADERS.length;
const EMPLOYEE_ID_COL = COL_COUNT;
const NATIONAL_ID_COL = HEADERS.indexOf('الرقم القومي') + 1;
const BIRTHDAY_COL = HEADERS.indexOf('تاريخ الميلاد') + 1;
const AGE_COL = HEADERS.indexOf('العمر') + 1;
const EXPORT_TEMPLATE_ROWS = 300;

function nationalIdBirthdayFormula(row: number): string {
  const nidCol = columnLetter(NATIONAL_ID_COL);
  const cell = `${nidCol}${row}`;
  return `IF(LEN(${cell})=14,DATE(IF(LEFT(${cell},1)="2",1900,2000)+VALUE(MID(${cell},2,2)),VALUE(MID(${cell},4,2)),VALUE(MID(${cell},6,2))),"")`;
}

function ageFromBirthdayFormula(row: number): string {
  const bdayCol = columnLetter(BIRTHDAY_COL);
  const cell = `${bdayCol}${row}`;
  return `IF(${cell}="","",DATEDIF(${cell},TODAY(),"Y"))`;
}

function applyNationalIdFormulas(sheet: ExcelJS.Worksheet, lastRow: number) {
  const endRow = Math.max(lastRow, EXPORT_TEMPLATE_ROWS);
  for (let row = 2; row <= endRow; row++) {
    const birthdayCell = sheet.getRow(row).getCell(BIRTHDAY_COL);
    const ageCell = sheet.getRow(row).getCell(AGE_COL);
    birthdayCell.value = { formula: nationalIdBirthdayFormula(row) };
    ageCell.value = { formula: ageFromBirthdayFormula(row) };
    birthdayCell.protection = { locked: true };
    ageCell.protection = { locked: true };
    birthdayCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    ageCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  }
}

const BOOL_LIST_FORMULA = '"نعم,لا"';
const DOC_STATUS_LIST_FORMULA = `"${DOCUMENT_STATUS_LABELS.none},${DOCUMENT_STATUS_LABELS.copy},${DOCUMENT_STATUS_LABELS.original}"`;

function addListValidation(
  sheet: ExcelJS.Worksheet,
  col: number,
  lastRow: number,
  formulae: string[],
) {
  const letter = columnLetter(col);
  const validations = (sheet as ExcelJS.Worksheet & {
    dataValidations: { add: (address: string, validation: Record<string, unknown>) => void };
  }).dataValidations;
  validations.add(`${letter}2:${letter}${lastRow}`, {
    type: 'list',
    allowBlank: true,
    formulae,
    showErrorMessage: true,
    errorTitle: 'قيمة غير مسموحة',
    error: 'اختر قيمة من القائمة المنسدلة',
  });
}

type LookupLists = {
  locationRange: string;
  departmentRange: string;
  jobTitleRange: string;
  skillRange: string;
  insuranceRange: string;
  medicalInsuranceRange: string;
};

function buildLookupSheet(
  workbook: ExcelJS.Workbook,
  locations: { name: string }[],
  departments: { name: string }[],
  jobTitles: { name: string }[],
  insuranceCompanies: { name: string }[],
): LookupLists {
  const lists = workbook.addWorksheet('Lookups');
  lists.state = 'hidden';

  lists.getRow(1).values = [
    undefined,
    'Location',
    'Department',
    'Job Title',
    'Skill',
    'Social Insurance',
    'Medical Insurance',
  ];

  locations.forEach((loc, i) => {
    lists.getCell(i + 2, 1).value = loc.name;
  });
  departments.forEach((dep, i) => {
    lists.getCell(i + 2, 2).value = dep.name;
  });
  jobTitles.forEach((job, i) => {
    lists.getCell(i + 2, 3).value = job.name;
  });
  SKILL_LEVELS.forEach((skill, i) => {
    lists.getCell(i + 2, 4).value = skill.label;
  });
  insuranceCompanies.forEach((company, i) => {
    lists.getCell(i + 2, 5).value = company.name;
    lists.getCell(i + 2, 6).value = company.name;
  });

  const locEnd = Math.max(locations.length, 1) + 1;
  const depEnd = Math.max(departments.length, 1) + 1;
  const jobEnd = Math.max(jobTitles.length, 1) + 1;
  const insEnd = Math.max(insuranceCompanies.length, 1) + 1;
  return {
    locationRange: `$A$2:$A$${locEnd}`,
    departmentRange: `$B$2:$B$${depEnd}`,
    jobTitleRange: `$C$2:$C$${jobEnd}`,
    skillRange: `$D$2:$D$${SKILL_LEVELS.length + 1}`,
    insuranceRange: `$E$2:$E$${insEnd}`,
    medicalInsuranceRange: `$F$2:$F$${insEnd}`,
  };
}

function applyDropdownValidations(
  sheet: ExcelJS.Worksheet,
  lastRow: number,
  lists: LookupLists,
) {
  const endRow = Math.max(lastRow, EXPORT_TEMPLATE_ROWS);
  const col = (header: (typeof HEADERS)[number]) => HEADERS.indexOf(header) + 1;

  addListValidation(sheet, col('Location'), endRow, [`Lookups!${lists.locationRange}`]);
  addListValidation(sheet, col('Department'), endRow, [`Lookups!${lists.departmentRange}`]);
  addListValidation(sheet, col('Job Title'), endRow, [`Lookups!${lists.jobTitleRange}`]);
  addListValidation(sheet, col('أصل المؤهل'), endRow, [DOC_STATUS_LIST_FORMULA]);
  addListValidation(sheet, col('أصل التجنيد'), endRow, [DOC_STATUS_LIST_FORMULA]);
  addListValidation(sheet, col('أصل الميلاد'), endRow, [DOC_STATUS_LIST_FORMULA]);
  addListValidation(sheet, col('صورة البطاقة'), endRow, [BOOL_LIST_FORMULA]);
  addListValidation(sheet, col('الصور الشخصية'), endRow, [BOOL_LIST_FORMULA]);
  addListValidation(sheet, col('برنت تأميني'), endRow, [BOOL_LIST_FORMULA]);
  addListValidation(sheet, col('مستوى المؤهل'), endRow, [`Lookups!${lists.skillRange}`]);
  addListValidation(sheet, col('كعب عمل'), endRow, [BOOL_LIST_FORMULA]);
  addListValidation(sheet, col('فيش جنائي'), endRow, [BOOL_LIST_FORMULA]);
  addListValidation(sheet, col('الموقف التأميني'), endRow, [`Lookups!${lists.insuranceRange}`]);
  addListValidation(sheet, col('موقف التأمين الطبي'), endRow, [`Lookups!${lists.medicalInsuranceRange}`]);
  addListValidation(sheet, col('Mobile Line'), endRow, [BOOL_LIST_FORMULA]);
  addListValidation(sheet, col('Misr ACCOUNT'), endRow, [BOOL_LIST_FORMULA]);
}
const READONLY_ID_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE2E8F0' },
};

const COLUMN_WIDTHS: Record<string, number> = {
  Location: 14,
  Code: 10,
  'Name-Arabic': 24,
  Department: 14,
  'Job Title': 16,
  'Hiring Date': 12,
  'الرقم القومي': 16,
  'تأكيد الرقم': 16,
  'تاريخ الميلاد': 12,
  العمر: 6,
  الهاتف: 14,
  'أصل المؤهل': 10,
  'أصل التجنيد': 10,
  'أصل الميلاد': 10,
  'صورة البطاقة': 10,
  'الصور الشخصية': 12,
  'برنت تأميني': 10,
  'مستوى المؤهل': 12,
  'كعب عمل': 10,
  'فيش جنائي': 10,
  'تاريخ صدور': 12,
  'تاريخ انتهاء': 12,
  'الموقف التأميني': 14,
  'الرقم التأميني': 16,
  'الأجر التأميني': 12,
  'موقف التأمين الطبي': 16,
  'الأجر التأميني الطبي': 14,
  'الأجر الأساسي': 12,
  'Basic Salary': 12,
  Notes: 16,
  'Mobile Line': 10,
  Fawry: 14,
  'Misr ACCOUNT': 12,
  'رصيد الإجازات': 12,
  'الأيام المستحقة': 12,
  'الرصيد المتبقي': 12,
  'User ID': 28,
};

function columnLetter(col: number): string {
  let n = col;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type EmployeeWithRelations = Prisma.EmployeeProfileGetPayload<{
  include: {
    department: true;
    mapping: true;
    workLocation: true;
    insuranceCompany: true;
    medicalInsuranceCompany: true;
  };
}>;

export type EmployeesExportFilters = {
  search?: string;
  departmentId?: string;
  locationId?: string;
  biotimeDeviceId?: string;
  biotimeSynced?: boolean;
  /** Defaults to true (active only). Pass false for archived export. */
  active?: boolean;
  employeeIds?: string[];
  /** Headers + empty template rows only (for onboarding new employees). */
  templateOnly?: boolean;
};

function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: 'thin' as const, color: { argb: 'FFCCCCCC' } };
  return { top: side, left: side, bottom: side, right: side };
}

function styleEmployeeIdCell(cell: ExcelJS.Cell, isHeader: boolean) {
  cell.protection = { locked: true };
  if (!isHeader) {
    cell.fill = READONLY_ID_FILL;
    cell.font = { size: 10, color: { argb: 'FF64748B' } };
  }
}

async function protectEmployeeSheet(sheet: ExcelJS.Worksheet, lastRow: number) {
  for (let r = 1; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= COL_COUNT; c++) {
      const cell = row.getCell(c);
      if (!cell.protection) {
        cell.protection = { locked: c === EMPLOYEE_ID_COL };
      }
    }
  }

  await sheet.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: true,
    formatColumns: true,
    formatRows: true,
    insertColumns: false,
    insertRows: true,
    insertHyperlinks: false,
    deleteColumns: false,
    deleteRows: false,
    sort: true,
    autoFilter: true,
    pivotTables: false,
  });
}

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

function buildWhere(filters: EmployeesExportFilters): Prisma.EmployeeProfileWhereInput {
  const where: Prisma.EmployeeProfileWhereInput = {
    active: filters.active === false ? false : true,
  };

  if (filters.employeeIds?.length) {
    where.id = { in: filters.employeeIds };
    // Explicit IDs may include archived employees intentionally
    delete where.active;
    return where;
  }

  if (filters.active === true || filters.active === false) {
    where.active = filters.active;
  }

  if (filters.departmentId) where.departmentId = filters.departmentId;
  if (filters.locationId) where.locationId = filters.locationId;
  if (filters.biotimeDeviceId) where.biotimeDeviceId = filters.biotimeDeviceId;
  if (filters.biotimeSynced === true) where.biotimeSynced = true;
  if (filters.biotimeSynced === false) where.biotimeSynced = false;

  const search = filters.search?.trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { displayName: { contains: search, mode: 'insensitive' } },
      { code: { contains: search, mode: 'insensitive' } },
      { identificationId: { contains: search, mode: 'insensitive' } },
      { nationalIdConfirm: { contains: search } },
      { workPhone: { contains: search } },
      { mobilePhone: { contains: search } },
      { workEmail: { contains: search, mode: 'insensitive' } },
      { mapping: { firstName: { contains: search, mode: 'insensitive' } } },
      { mapping: { lastName: { contains: search, mode: 'insensitive' } } },
      { mapping: { biotimeEmpCode: { contains: search, mode: 'insensitive' } } },
      { mapping: { mobile: { contains: search } } },
    ];
  }

  return where;
}

function employeeCode(emp: EmployeeWithRelations): string {
  return (
    emp.mapping?.biotimeEmpCode?.trim() ||
    emp.identificationId?.trim() ||
    emp.code?.trim() ||
    emp.barcode?.trim() ||
    ''
  );
}

function employeeLocation(emp: EmployeeWithRelations): string {
  return emp.workLocation?.name?.trim() || emp.location?.trim() || '';
}

function boolExcel(value: boolean): string {
  return value ? 'نعم' : 'لا';
}

function docStatusExcel(status: string, legacyOriginal = false): string {
  if (status === 'original' || legacyOriginal) return DOCUMENT_STATUS_LABELS.original;
  if (status === 'copy') return DOCUMENT_STATUS_LABELS.copy;
  return DOCUMENT_STATUS_LABELS.none;
}

function skillLevelExcel(value: string): string {
  const found = SKILL_LEVELS.find((s) => s.value === value);
  return found?.label ?? value;
}

function enumLabelExcel(
  value: string,
  options: ReadonlyArray<{ value: string; label: string }>,
): string {
  const found = options.find((o) => o.value === value);
  return found?.label ?? value;
}

function parseDocStatusCell(value: string): string {
  const v = value.trim();
  if (!v || v === 'لا' || v.toLowerCase() === 'no' || v === 'لا يوجد') return 'none';
  if (v === 'أصل' || v === 'original' || v.toLowerCase() === 'yes' || v === 'نعم') return 'original';
  if (v === 'صورة' || v === 'copy') return 'copy';
  return normalizeDocumentStatus(v);
}

function parseBoolCell(value: string): boolean {
  const s = value.trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'نعم', 'أصل', 'صورة'].includes(s);
}

function parseEnumByLabel(
  value: string,
  options: ReadonlyArray<{ value: string; label: string }>,
): string {
  const v = value.trim();
  if (!v) return '';
  const byLabel = options.find((o) => o.label === v);
  if (byLabel) return byLabel.value;
  const byValue = options.find((o) => o.value === v);
  return byValue?.value ?? v;
}

function numExcel(value: number | null | undefined): number | string {
  if (value == null || Number.isNaN(value)) return '';
  return value;
}

/** Medical insurance salary is stored/displayed to one decimal (Excel often has long fractions). */
function roundInsuranceSalary1(value: unknown): number | null {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

function employeePhone(emp: EmployeeWithRelations): string {
  return emp.mobilePhone?.trim() || emp.workPhone?.trim() || emp.mapping?.mobile?.trim() || '';
}

function fawryExcel(custom: ReturnType<typeof employeeCustomFieldsJson>): string {
  if (custom.fawryPhone) return custom.fawryPhone;
  return boolExcel(Boolean(custom.fawryAccount));
}

function employeeRowValues(emp: EmployeeWithRelations): (string | number)[] {
  const custom = employeeCustomFieldsJson(emp);
  const age = custom.employeeAge;
  const displayName = resolveEmployeeDisplayName(emp);
  const basicSalary = numExcel(emp.basicSalary);

  return [
    employeeLocation(emp),
    employeeCode(emp),
    displayName,
    emp.department?.name?.trim() || '',
    emp.jobTitle?.trim() || '',
    custom.hiringDate,
    custom.nationalIdConfirm,
    custom.nationalIdConfirm,
    custom.birthday,
    age > 0 ? age : '',
    employeePhone(emp),
    docStatusExcel(custom.qualificationDocStatus, custom.qualificationOriginal),
    docStatusExcel(custom.militaryDocStatus, custom.militaryServiceDoc),
    docStatusExcel(custom.birthCertificateDocStatus, custom.birthCertificateOriginal),
    boolExcel(custom.idCardPhoto),
    boolExcel(custom.personalPhoto),
    boolExcel(custom.insurancePrint),
    skillLevelExcel(custom.skillLevel),
    boolExcel(custom.workStub),
    boolExcel(custom.criminalRecord),
    custom.healthCertificateIssueDate,
    custom.healthCertificateExpiryDate,
    emp.insuranceCompany?.name?.trim() || '',
    custom.insuranceNumber,
    numExcel(custom.insuranceSalary),
    emp.medicalInsuranceCompany?.name?.trim() || '',
    numExcel(custom.medicalInsuranceSalary),
    basicSalary,
    basicSalary,
    '',
    boolExcel(custom.mobileLine),
    fawryExcel(custom),
    boolExcel(custom.misrAccount),
    numExcel(custom.leaveStartingBalance),
    numExcel(custom.usedLeaveDays),
    numExcel(custom.remainingLeaveBalance),
    emp.userId ?? '',
  ];
}

export async function exportEmployeesXlsx(filters: EmployeesExportFilters = {}): Promise<string> {
  const templateOnly = filters.templateOnly === true;
  const where = templateOnly ? { id: { in: [] as string[] } } : buildWhere(filters);
  const [employees, locations, departments, jobTitles, insuranceCompanies] = await Promise.all([
    templateOnly
      ? Promise.resolve([])
      : prisma.employeeProfile.findMany({
          where,
          include: {
            department: true,
            mapping: true,
            workLocation: true,
            insuranceCompany: true,
            medicalInsuranceCompany: true,
          },
          orderBy: [{ displayName: 'asc' }, { name: 'asc' }],
        }),
    prisma.location.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { name: true } }),
    prisma.department.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { name: true } }),
    prisma.jobTitle.findMany({ where: { active: true }, orderBy: [{ sequence: 'asc' }, { name: 'asc' }], select: { name: true } }),
    prisma.insuranceCompany.findMany({ where: { active: true }, orderBy: [{ sequence: 'asc' }, { name: 'asc' }], select: { name: true } }),
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hudoori';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Employees', {
    properties: { defaultRowHeight: 20 },
    pageSetup: { fitToPage: true, fitToWidth: 1 },
  });

  sheet.columns = HEADERS.map((header) => ({
    width: COLUMN_WIDTHS[header] ?? 12,
  }));

  const headerRow = sheet.getRow(1);
  HEADERS.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF343A40' } };
    cell.border = thinBorder();
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    if (i + 1 === EMPLOYEE_ID_COL) {
      styleEmployeeIdCell(cell, true);
      cell.note = templateOnly
        ? 'اتركه فارغاً للموظفين الجدد'
        : 'لا تعدّل — معرّف المستخدم للتحديث عند الاستيراد';
    } else {
      cell.protection = { locked: false };
    }
  });
  headerRow.height = 28;

  employees.forEach((emp, idx) => {
    const values = employeeRowValues(emp);
    if (values.length !== COL_COUNT) {
      throw new Error(`Employee export column mismatch: ${values.length} values, ${COL_COUNT} headers`);
    }

    const row = sheet.addRow(values);
    row.height = 22;
    for (let i = 1; i <= COL_COUNT; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder();
      const header = HEADERS[i - 1];
      const isArabic = RTL_HEADER_SET.has(header);
      cell.alignment = {
        vertical: 'middle',
        horizontal: isArabic ? 'right' : 'center',
        readingOrder: isArabic ? 'rtl' : undefined,
      };
      if (i === EMPLOYEE_ID_COL) {
        styleEmployeeIdCell(cell, false);
      } else {
        cell.protection = { locked: false };
        if (idx % 2 === 1) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        }
      }
    }
  });

  // Empty fill rows for template onboarding (and for extending exports).
  const blankStart = employees.length + 2;
  for (let r = blankStart; r <= EXPORT_TEMPLATE_ROWS; r++) {
    const row = sheet.getRow(r);
    row.height = 22;
    for (let i = 1; i <= COL_COUNT; i++) {
      const cell = row.getCell(i);
      cell.border = thinBorder();
      cell.protection = { locked: false };
      if (i === EMPLOYEE_ID_COL) styleEmployeeIdCell(cell, false);
    }
  }

  sheet.getColumn(EMPLOYEE_ID_COL).hidden = true;
  // Force text so Excel does not mangle 14-digit national IDs / phones as numbers.
  sheet.getColumn(NATIONAL_ID_COL).numFmt = '@';
  sheet.getColumn(HEADERS.indexOf('تأكيد الرقم') + 1).numFmt = '@';
  sheet.getColumn(HEADERS.indexOf('الهاتف') + 1).numFmt = '@';
  sheet.getColumn(HEADERS.indexOf('Code') + 1).numFmt = '@';

  const lastRow = Math.max(1, employees.length + 1);
  const templateRow = Math.max(lastRow, EXPORT_TEMPLATE_ROWS);
  const lookupLists = buildLookupSheet(workbook, locations, departments, jobTitles, insuranceCompanies);
  applyDropdownValidations(sheet, templateRow, lookupLists);
  applyNationalIdFormulas(sheet, Math.max(lastRow, 2));

  const lastCol = columnLetter(COL_COUNT);
  sheet.pageSetup.printArea = `A1:${lastCol}${templateRow}`;
  sheet.views = [{
    state: 'frozen',
    ySplit: 1,
    activeCell: 'A2',
    showGridLines: true,
    rightToLeft: true,
  }];

  // Drop phantom columns that cause infinite horizontal scroll in Excel.
  if (sheet.columnCount > COL_COUNT) {
    sheet.spliceColumns(COL_COUNT + 1, sheet.columnCount - COL_COUNT);
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: templateRow, column: COL_COUNT },
  };

  await protectEmployeeSheet(sheet, templateRow);

  return workbookToBase64(workbook);
}

export const EMPLOYEE_EXCEL_HEADERS = HEADERS;

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Avoid scientific notation for long IDs/phones stored as Excel numbers.
    if (Math.abs(value) >= 1e10 && Number.isInteger(value)) return String(Math.trunc(value));
    return String(value);
  }
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String((value as { text?: string }).text ?? '').trim();
  }
  if (typeof value === 'object' && value !== null && 'result' in value) {
    return cellText((value as { result?: ExcelJS.CellValue }).result);
  }
  if (typeof value === 'object' && value !== null && 'sharedFormula' in value) {
    const shared = value as { result?: ExcelJS.CellValue };
    if ('result' in shared) return cellText(shared.result);
    return '';
  }
  return String(value).trim();
}

function parseHeaderMap(sheet: ExcelJS.Worksheet): Map<string, number> {
  const headerRow = sheet.getRow(1);
  const map = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    const label = cellText(cell.value);
    if (label) map.set(normalizeHeader(label), col);
  });
  return map;
}

function colForHeader(headerMap: Map<string, number>, header: (typeof HEADERS)[number]): number | undefined {
  for (const alias of HEADER_ALIASES[header] ?? [header]) {
    const col = headerMap.get(normalizeHeader(alias));
    if (col) return col;
  }
  return undefined;
}

function readRow(sheet: ExcelJS.Worksheet, rowNum: number, headerMap: Map<string, number>): Record<string, string> {
  const row = sheet.getRow(rowNum);
  const data: Record<string, string> = {};
  for (const header of HEADERS) {
    const col = colForHeader(headerMap, header);
    if (col) data[header] = cellText(row.getCell(col).value);
  }
  return data;
}

function userIdFromRow(row: Record<string, string>): string {
  return row['User ID']?.trim() || row['Employee ID']?.trim() || '';
}

function rowIsEmpty(row: Record<string, string>): boolean {
  return !userIdFromRow(row)
    && !row.Code?.trim()
    && !row['Name-Arabic']?.trim();
}

function cellHasValue(value: string | undefined | null): boolean {
  return Boolean(value && String(value).trim());
}

/** Accept ISO dates or Excel serial numbers; reject nonsense years like 46241. */
function normalizeImportDateCell(raw: string | undefined | null): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 20000 && asNum < 80000) {
    const utc = new Date(Date.UTC(1899, 11, 30) + Math.round(asNum) * 86400000);
    if (!Number.isNaN(utc.getTime())) return utc.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    if (y >= 1900 && y <= 2100) return d.toISOString().slice(0, 10);
  }
  return null;
}

function resolveInsuranceCompanyId(
  raw: string,
  companyByName: Map<string, string>,
): string | null | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  const id = companyByName.get(v.toLowerCase());
  return id ?? null;
}

function buildEmployeeDataFromRow(
  row: Record<string, string>,
  deptByName: Map<string, string>,
  locByName: Map<string, string>,
  companyByName: Map<string, string>,
): { data: Record<string, unknown>; warnings: string[] } {
  const data: Record<string, unknown> = {};
  const warnings: string[] = [];
  /** Only non-empty Excel cells — empty cells must NOT clear existing DB values. */
  const custom: Record<string, unknown> = {};

  const displayName = row['Name-Arabic']?.trim();
  if (displayName) {
    data.name = displayName;
    data.displayName = displayName;
  }

  const code = row.Code?.trim();
  if (code) {
    data.code = code;
    data.identificationId = code;
    data.barcode = code;
  }

  const jobTitle = row['Job Title']?.trim();
  if (jobTitle) data.jobTitle = jobTitle;

  const deptName = row.Department?.trim().toLowerCase();
  if (deptName && deptByName.has(deptName)) data.departmentId = deptByName.get(deptName);

  const locName = row.Location?.trim().toLowerCase();
  if (locName && locByName.has(locName)) {
    data.locationId = locByName.get(locName);
    data.location = row.Location.trim();
  }

  const phone = row['الهاتف']?.trim();
  if (phone) data.mobilePhone = phone;

  const salaryRaw = row['Basic Salary']?.trim() || row['الأجر الأساسي']?.trim();
  if (salaryRaw) data.basicSalary = Number(salaryRaw) || 0;

  const nationalIdRaw = row['تأكيد الرقم']?.trim() || row['الرقم القومي']?.trim();
  let nationalIdApplied = false;
  if (nationalIdRaw) {
    const parsed = parseEgyptianNationalId(nationalIdRaw);
    if (parsed.valid && parsed.nationalId) {
      custom.nationalIdConfirm = parsed.nationalId;
      nationalIdApplied = true;
    } else {
      warnings.push(
        `الرقم القومي «${nationalIdRaw}» غير صالح — تم تجاهله وإنشاء/تحديث الموظف بدونه`
        + (parsed.error ? ` (${parsed.error})` : ''),
      );
    }
  }

  const hiringDate = normalizeImportDateCell(row['Hiring Date']);
  if (hiringDate) custom.hiringDate = hiringDate;

  const birthday = normalizeImportDateCell(row['تاريخ الميلاد']);
  if (birthday && !nationalIdApplied) custom.birthday = birthday;

  if (cellHasValue(row['أصل المؤهل'])) {
    custom.qualificationDocStatus = parseDocStatusCell(row['أصل المؤهل']);
  }
  if (cellHasValue(row['أصل التجنيد'])) {
    custom.militaryDocStatus = parseDocStatusCell(row['أصل التجنيد']);
  }
  if (cellHasValue(row['أصل الميلاد'])) {
    custom.birthCertificateDocStatus = parseDocStatusCell(row['أصل الميلاد']);
  }
  if (cellHasValue(row['فيش جنائي'])) custom.criminalRecord = parseBoolCell(row['فيش جنائي']);
  if (cellHasValue(row['كعب عمل'])) custom.workStub = parseBoolCell(row['كعب عمل']);
  if (cellHasValue(row['صورة البطاقة'])) custom.idCardPhoto = parseBoolCell(row['صورة البطاقة']);
  if (cellHasValue(row['الصور الشخصية'])) custom.personalPhoto = parseBoolCell(row['الصور الشخصية']);
  if (cellHasValue(row['برنت تأميني'])) custom.insurancePrint = parseBoolCell(row['برنت تأميني']);
  if (cellHasValue(row['مستوى المؤهل'])) {
    custom.skillLevel = parseEnumByLabel(row['مستوى المؤهل'], SKILL_LEVELS);
  }
  if (cellHasValue(row['تاريخ صدور'])) {
    const issue = normalizeImportDateCell(row['تاريخ صدور']);
    if (issue) custom.healthCertificateIssueDate = issue;
  }
  if (cellHasValue(row['تاريخ انتهاء'])) {
    const exp = normalizeImportDateCell(row['تاريخ انتهاء']);
    if (exp) custom.healthCertificateExpiryDate = exp;
  }
  if (cellHasValue(row['الرقم التأميني'])) custom.insuranceNumber = row['الرقم التأميني'];
  if (cellHasValue(row['الأجر التأميني'])) custom.insuranceSalary = row['الأجر التأميني'];
  if (cellHasValue(row['الأجر التأميني الطبي'])) {
    const rounded = roundInsuranceSalary1(row['الأجر التأميني الطبي']);
    if (rounded != null) custom.medicalInsuranceSalary = rounded;
  }
  if (cellHasValue(row['الموقف التأميني'])) {
    const companyId = resolveInsuranceCompanyId(row['الموقف التأميني'], companyByName);
    if (companyId) custom.insuranceCompanyId = companyId;
    else warnings.push('شركة التأمين الاجتماعي «' + row['الموقف التأميني'] + '» غير مسجلة');
  }
  const medCoCell = row['موقف التأمين الطبي']?.trim() || row['موقف التأمين']?.trim() || '';
  if (medCoCell) {
    const companyId = resolveInsuranceCompanyId(medCoCell, companyByName);
    if (companyId) custom.medicalInsuranceCompanyId = companyId;
    else warnings.push('شركة التأمين الطبي «' + medCoCell + '» غير مسجلة');
  }
  if (cellHasValue(row['Mobile Line'])) custom.mobileLine = parseBoolCell(row['Mobile Line']);

  const fawryVal = row.Fawry?.trim() ?? '';
  if (fawryVal) {
    const fawryIsPhone = !['نعم', 'لا', 'yes', 'no'].includes(fawryVal.toLowerCase());
    custom.fawryAccount = fawryIsPhone ? true : parseBoolCell(fawryVal);
    if (fawryIsPhone) custom.fawryPhone = fawryVal;
  }

  if (cellHasValue(row['Misr ACCOUNT'])) custom.misrAccount = parseBoolCell(row['Misr ACCOUNT']);
  if (cellHasValue(row['رصيد الإجازات'])) custom.leaveStartingBalance = row['رصيد الإجازات'];
  if (cellHasValue(row['الأيام المستحقة'])) custom.usedLeaveDays = row['الأيام المستحقة'];
  if (cellHasValue(row['الرصيد المتبقي'])) custom.remainingLeaveBalance = row['الرصيد المتبقي'];

  if (Object.keys(custom).length > 0) {
    Object.assign(data, parseEmployeeCustomUpdate(custom));
  }

  if (cellHasValue(row['تاريخ صدور']) || cellHasValue(row['تاريخ انتهاء'])) {
    if (custom.healthCertificateIssueDate || custom.healthCertificateExpiryDate) {
      data.healthCertificate = true;
    }
  }

  return { data, warnings };
}

async function findEmployeeForRow(
  row: Record<string, string>,
  byId: Map<string, { id: string }>,
  byUserId: Map<string, { id: string }>,
  byCode: Map<string, { id: string }>,
): Promise<{ id: string } | null> {
  const rowUserId = userIdFromRow(row);
  if (rowUserId && byUserId.has(rowUserId)) return byUserId.get(rowUserId)!;
  if (rowUserId && byId.has(rowUserId)) return byId.get(rowUserId)!;

  const code = row.Code?.trim().toLowerCase();
  if (code && byCode.has(code)) return byCode.get(code)!;

  const nationalIdRaw = row['تأكيد الرقم']?.trim() || row['الرقم القومي']?.trim();
  if (nationalIdRaw) {
    const parsed = parseEgyptianNationalId(nationalIdRaw);
    if (parsed.valid && parsed.nationalId) {
      const found = await prisma.employeeProfile.findFirst({
        where: { nationalIdConfirm: parsed.nationalId },
        select: { id: true },
      });
      if (found) return found;
    }
  }

  return null;
}

async function codeTakenByOther(code: string, employeeId: string): Promise<boolean> {
  const normalized = code.trim();
  if (!normalized) return false;
  const other = await prisma.employeeProfile.findFirst({
    where: {
      id: { not: employeeId },
      OR: [
        { code: { equals: normalized, mode: 'insensitive' } },
        { identificationId: { equals: normalized, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  return Boolean(other);
}

function normStr(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function normDate(v: Date | null | undefined): string {
  if (!v) return '';
  return v.toISOString().slice(0, 10);
}

function normNum(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function normBool(v: unknown): boolean {
  return v === true;
}

function existingFieldValue(
  emp: Prisma.EmployeeProfileGetPayload<object>,
  key: string,
): unknown {
  if (key === 'hasFawryAccount') return (emp as { hasFawryAccount?: boolean }).hasFawryAccount;
  if (key === 'fawryAccount') return (emp as { fawryAccount?: string | null }).fawryAccount;
  return (emp as Record<string, unknown>)[key];
}

function valuesEqual(key: string, existing: unknown, incoming: unknown): boolean {
  if (key.endsWith('Date') || key === 'birthday' || key === 'hiringDate') {
    const ex = existing instanceof Date ? normDate(existing) : normStr(existing);
    const inc = incoming instanceof Date ? normDate(incoming) : normStr(incoming);
    return ex === inc;
  }
  if (
    key.includes('Salary')
    || key.includes('Days')
    || key.includes('Balance')
    || key === 'basicSalary'
  ) {
    return normNum(existing) === normNum(incoming);
  }
  if (
    typeof existing === 'boolean'
    || typeof incoming === 'boolean'
    || key === 'active'
    || key.startsWith('qualification')
    || key.includes('Record')
    || key.includes('Certificate')
    || key.includes('Photo')
    || key.includes('Print')
    || key.includes('Stub')
    || key.includes('Doc')
    || key.includes('Account')
    || key === 'mobileLine'
    || key === 'healthCertificate'
    || key === 'misrAccount'
    || key === 'hasFawryAccount'
  ) {
    return normBool(existing) === normBool(incoming);
  }
  return normStr(existing) === normStr(incoming);
}

function computeImportPatch(
  existing: Prisma.EmployeeProfileGetPayload<object>,
  incoming: Record<string, unknown>,
): { patch: Record<string, unknown>; changed: boolean; biotimeDirty: boolean } {
  const patch: Record<string, unknown> = {};
  let changed = false;
  let biotimeDirty = false;

  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'biotimeSynced') continue;
    const current = existingFieldValue(existing, key);
    if (valuesEqual(key, current, value)) continue;
    patch[key] = value;
    changed = true;
    if (BIOTIME_PUSH_PROFILE_FIELDS.has(key)) biotimeDirty = true;
  }

  if (biotimeDirty && existing.biotimeSynced) {
    patch.biotimeSynced = false;
  }

  return { patch, changed, biotimeDirty };
}

export async function importEmployeesXlsx(base64: string) {
  const buf = Buffer.from(base64, 'base64');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets.find((ws) => ws.name === 'Employees') ?? workbook.worksheets[0];
  if (!sheet) throw new Error('ملف Excel فارغ');

  const headerMap = parseHeaderMap(sheet);
  const codeCol = colForHeader(headerMap, 'Code');
  const nameCol = colForHeader(headerMap, 'Name-Arabic');
  if (!codeCol && !nameCol && !colForHeader(headerMap, 'User ID')) {
    throw new Error('ملف Excel غير معروف — استخدم ملف التصدير من النظام');
  }

  const [employees, departments, locations, insuranceCompanies] = await Promise.all([
    prisma.employeeProfile.findMany(),
    prisma.department.findMany({ select: { id: true, name: true } }),
    prisma.location.findMany({ select: { id: true, name: true } }),
    prisma.insuranceCompany.findMany({ where: { active: true }, select: { id: true, name: true } }),
  ]);

  const byId = new Map(employees.map((e) => [e.id, e]));
  const byUserId = new Map<string, { id: string }>();
  for (const e of employees) {
    if (e.userId?.trim()) byUserId.set(e.userId.trim(), e);
  }
  const byCode = new Map<string, { id: string }>();
  for (const e of employees) {
    if (e.code?.trim()) byCode.set(e.code.trim().toLowerCase(), e);
    if (e.identificationId?.trim()) byCode.set(e.identificationId.trim().toLowerCase(), e);
  }

  const deptByName = new Map(departments.map((d) => [d.name.trim().toLowerCase(), d.id]));
  const locByName = new Map(locations.map((l) => [l.name.trim().toLowerCase(), l.id]));
  const companyByName = new Map(insuranceCompanies.map((c) => [c.name.trim().toLowerCase(), c.id]));

  const errors: string[] = [];
  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();
  let updated = 0;
  let created = 0;
  let skipped = 0;
  let unchanged = 0;
  const changeRows: Array<{
    entityId: string;
    entityLabel: string;
    field: string;
    before: unknown;
    after: unknown;
  }> = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = readRow(sheet, r, headerMap);
    if (rowIsEmpty(row)) {
      skipped++;
      continue;
    }

    const rowCode = row.Code?.trim().toLowerCase();
    const rowId = userIdFromRow(row);

    if (rowId) {
      if (seenIds.has(rowId)) {
        errors.push(`صف ${r}: تكرار User ID ${rowId}`);
        continue;
      }
      seenIds.add(rowId);
    }
    if (rowCode) {
      if (seenCodes.has(rowCode)) {
        errors.push(`صف ${r}: تكرار الكود ${row.Code?.trim()}`);
        continue;
      }
      seenCodes.add(rowCode);
    }

    try {
      const { data, warnings: rowWarnings } = buildEmployeeDataFromRow(row, deptByName, locByName, companyByName);
      const match = await findEmployeeForRow(row, byId, byUserId, byCode);
      const rowLabel = row.Code?.trim() || row['Name-Arabic']?.trim() || String(r);
      for (const w of rowWarnings) {
        errors.push(`صف ${r} (${rowLabel}): ${w}`);
      }

      if (match) {
        const existingFull = byId.get(match.id);
        if (!existingFull) {
          errors.push(`صف ${r}: الموظف غير موجود`);
          continue;
        }
        const newCode = typeof data.code === 'string' ? data.code : '';
        if (newCode && await codeTakenByOther(newCode, match.id)) {
          errors.push(`صف ${r}: الكود ${newCode} مستخدم لموظف آخر`);
          continue;
        }
        const { patch, changed } = computeImportPatch(existingFull, data);
        if (!changed) {
          unchanged++;
          continue;
        }
        if (changeRows.length < 3000) {
          const label = existingFull.name || existingFull.code || match.id;
          for (const [field, after] of Object.entries(patch)) {
            changeRows.push({
              entityId: match.id,
              entityLabel: String(label),
              field,
              before: existingFieldValue(existingFull, field) ?? null,
              after: after ?? null,
            });
          }
        }
        const updatedEmp = await prisma.employeeProfile.update({ where: { id: match.id }, data: patch });
        byId.set(updatedEmp.id, updatedEmp);
        if (updatedEmp.code?.trim()) byCode.set(updatedEmp.code.trim().toLowerCase(), updatedEmp);
        if (updatedEmp.identificationId?.trim()) {
          byCode.set(updatedEmp.identificationId.trim().toLowerCase(), updatedEmp);
        }
        updated++;
        continue;
      }

      const createName = (data.name as string | undefined)?.trim()
        || row['Name-Arabic']?.trim();
      const createCode = (data.code as string | undefined)?.trim() || row.Code?.trim();

      if (!createName || createName.length < 2) {
        errors.push(`صف ${r}: الاسم مطلوب لإنشاء موظف جديد`);
        continue;
      }
      if (!createCode) {
        errors.push(`صف ${r}: الكود مطلوب لإنشاء موظف جديد`);
        continue;
      }

      const duplicate = await prisma.employeeProfile.findFirst({
        where: {
          OR: [
            { code: { equals: createCode, mode: 'insensitive' } },
            { identificationId: { equals: createCode, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      if (duplicate) {
        errors.push(`صف ${r}: الكود ${createCode} موجود بالفعل — استخدم User ID للتحديث`);
        continue;
      }

      const createdEmp = await prisma.employeeProfile.create({
        data: {
          ...(data as Prisma.EmployeeProfileCreateInput),
          name: createName,
          displayName: String(data.displayName || createName),
          code: createCode,
          identificationId: createCode,
          barcode: String(data.barcode || createCode),
          active: data.active !== undefined ? Boolean(data.active) : true,
          biotimeSynced: false,
        },
      });
      byId.set(createdEmp.id, createdEmp);
      byCode.set(createCode.toLowerCase(), createdEmp);
      created++;
    } catch (e) {
      errors.push(`صف ${r}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const unchangedNote = unchanged > 0 ? ` — بدون تغيير ${unchanged}` : '';
  const skippedNote = skipped > 0 ? ` — تخطي ${skipped} صف فارغ` : '';
  const warnNote = errors.length > 0 ? ` — تنبيهات ${errors.length}` : '';
  return {
    message: `تم تحديث ${updated} وإنشاء ${created} موظف${unchangedNote}${skippedNote}${warnNote}`,
    updated,
    created,
    skipped,
    unchanged,
    errors,
    changes: changeRows,
  };
}
