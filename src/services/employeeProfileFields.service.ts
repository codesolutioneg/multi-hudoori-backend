import type { EmployeeProfile } from '@prisma/client';
import { parseEgyptianNationalId } from '../utils/egyptianNationalId';
import { validateEgyptianIban } from '../utils/iban';
import { AppError } from '../utils/errors';
import { normalizeDocumentStatus, syncLegacyDocBooleans } from './employeeDocuments.service';

export const SKILL_LEVELS = [
  { value: 'beginner', label: 'مبتدئ' },
  { value: 'intermediate', label: 'متوسط' },
  { value: 'advanced', label: 'متقدم' },
  { value: 'expert', label: 'خبير' },
] as const;

export const INSURANCE_STATUSES = [
  { value: 'active', label: 'مؤمن عليه' },
  { value: 'inactive', label: 'غير مؤمن عليه' },
  { value: 'suspended', label: 'موقوف' },
  { value: 'retired', label: 'معاش' },
] as const;

export const MEDICAL_INSURANCE_STATUSES = [
  { value: 'active', label: 'فعال' },
  { value: 'inactive', label: 'غير فعال' },
  { value: 'pending', label: 'قيد الانتظار' },
] as const;

export const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  none: 'لا يوجد',
  copy: 'صورة',
  original: 'أصل',
};

function parseOptionalDate(value: unknown): Date | null {
  if (value == null || value === '' || value === false) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseOptionalFloat(value: unknown, fallback = 0): number {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function parseOptionalInt(value: unknown, fallback = 0): number {
  if (value == null || value === '') return fallback;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? fallback : n;
}

function parseOptionalBool(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const s = String(value ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'نعم'].includes(s);
}

function addOneYear(date: Date): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + 1);
  return d;
}

export function employeeAgeFromBirthday(birthday: Date | null | undefined): number {
  if (!birthday) return 0;
  const today = new Date();
  let age = today.getFullYear() - birthday.getFullYear();
  const monthDiff = today.getMonth() - birthday.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthday.getDate())) {
    age -= 1;
  }
  return Math.max(0, age);
}

export function employeeCustomFieldsJson(employee: EmployeeProfile) {
  return {
    hiringDate: employee.hiringDate?.toISOString().slice(0, 10) ?? '',
    nationalIdConfirm: employee.nationalIdConfirm ?? '',
    isForeigner: employee.isForeigner === true,
    birthday: employee.birthday?.toISOString().slice(0, 10) ?? '',
    employeeAge: employeeAgeFromBirthday(employee.birthday),
    address: employee.address ?? '',
    idCardPhoto: employee.idCardPhoto,
    qualificationOriginal: employee.qualificationOriginal,
    qualificationDocStatus: employee.qualificationDocStatus ?? 'none',
    militaryServiceDoc: employee.militaryServiceDoc,
    militaryDocStatus: employee.militaryDocStatus ?? 'none',
    criminalRecord: employee.criminalRecord,
    birthCertificateOriginal: employee.birthCertificateOriginal,
    birthCertificateDocStatus: employee.birthCertificateDocStatus ?? 'none',
    workStub: employee.workStub,
    personalPhoto: employee.personalPhoto,
    personalPhotoCount: employee.personalPhotoCount ?? 0,
    insurancePrint: employee.insurancePrint,
    insurancePrintUrl: employee.insurancePrintUrl ?? '',
    idCardPhotoUrl: employee.idCardPhotoUrl ?? '',
    qualificationDocUrl: employee.qualificationDocUrl ?? '',
    militaryDocUrl: employee.militaryDocUrl ?? '',
    birthCertificateDocUrl: employee.birthCertificateDocUrl ?? '',
    criminalRecordDocUrl: employee.criminalRecordDocUrl ?? '',
    personalPhotoDocUrl: employee.personalPhotoDocUrl ?? '',
    hasSkillLevel: employee.hasSkillLevel,
    skillLevel: employee.skillLevel ?? '',
    healthCertificate: employee.healthCertificate,
    healthCertificateIssueDate: employee.healthCertificateIssueDate?.toISOString().slice(0, 10) ?? '',
    healthCertificateExpiryDate: employee.healthCertificateExpiryDate?.toISOString().slice(0, 10) ?? '',
    insuranceNumber: employee.insuranceNumber ?? '',
    insuranceStatus: employee.insuranceStatus ?? '',
    insuranceCompanyId: employee.insuranceCompanyId ?? false,
    insuranceSalary: employee.insuranceSalary,
    medicalInsuranceStatus: employee.medicalInsuranceStatus ?? '',
    medicalInsuranceCompanyId: employee.medicalInsuranceCompanyId ?? false,
    medicalInsuranceSalary: employee.medicalInsuranceSalary,
    mobileLine: employee.mobileLine,
    fawryAccount: employee.hasFawryAccount,
    fawryPhone: employee.fawryAccount ?? '',
    misrAccount: employee.misrAccount,
    bankIban: employee.bankIban ?? '',
    mobileLinePhone: employee.mobileLinePhone ?? '',
    laptopProvided: employee.laptopProvided,
    mobileProvided: employee.mobileProvided,
    leaveStartingBalance: employee.leaveStartingBalance,
    usedLeaveDays: employee.usedLeaveDays,
    remainingLeaveBalance: employee.remainingLeaveBalance,
  };
}

export function parseEmployeeCustomUpdate(
  params: Record<string, unknown>,
  options?: { existingIsForeigner?: boolean },
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if ('hiringDate' in params) data.hiringDate = parseOptionalDate(params.hiringDate);
  if ('isForeigner' in params) {
    data.isForeigner = parseOptionalBool(params.isForeigner);
  }
  const isForeigner =
    'isForeigner' in data
      ? Boolean(data.isForeigner)
      : Boolean(options?.existingIsForeigner);

  if ('nationalIdConfirm' in params) {
    const nid = String(params.nationalIdConfirm ?? '').trim();
    if (!nid) {
      data.nationalIdConfirm = null;
      if (!isForeigner) data.birthday = null;
    } else if (isForeigner) {
      // Passport / foreign ID — store as-is, no Egyptian format check.
      data.nationalIdConfirm = nid;
    } else {
      const parsed = parseEgyptianNationalId(nid);
      if (!parsed.valid) {
        throw new AppError(parsed.error ?? 'الرقم القومي غير صالح', 400, 'VALIDATION');
      }
      data.nationalIdConfirm = parsed.nationalId;
      data.birthday = parsed.birthDate;
    }
  }
  if ('birthday' in params && !('nationalIdConfirm' in params)) {
    data.birthday = parseOptionalDate(params.birthday);
  }
  if ('address' in params) {
    const addr = String(params.address ?? '').trim();
    data.address = addr || null;
  }

  const boolFields: Array<[keyof EmployeeProfile, string]> = [
    ['criminalRecord', 'criminalRecord'],
    ['workStub', 'workStub'],
    ['idCardPhoto', 'idCardPhoto'],
    ['personalPhoto', 'personalPhoto'],
    ['healthCertificate', 'healthCertificate'],
    ['mobileLine', 'mobileLine'],
    ['misrAccount', 'misrAccount'],
    ['laptopProvided', 'laptopProvided'],
    ['mobileProvided', 'mobileProvided'],
    ['hasSkillLevel', 'hasSkillLevel'],
  ];
  for (const [dbKey, paramKey] of boolFields) {
    if (paramKey in params) data[dbKey] = parseOptionalBool(params[paramKey]);
  }

  if ('qualificationDocStatus' in params) {
    const status = normalizeDocumentStatus(params.qualificationDocStatus);
    data.qualificationDocStatus = status;
    Object.assign(data, { qualificationOriginal: syncLegacyDocBooleans(status).qualificationOriginal });
  } else if ('qualificationOriginal' in params) {
    data.qualificationOriginal = parseOptionalBool(params.qualificationOriginal);
    data.qualificationDocStatus = data.qualificationOriginal ? 'original' : 'none';
  }

  if ('militaryDocStatus' in params) {
    const status = normalizeDocumentStatus(params.militaryDocStatus);
    data.militaryDocStatus = status;
    data.militaryServiceDoc = syncLegacyDocBooleans(status).militaryServiceDoc;
  } else if ('militaryServiceDoc' in params) {
    data.militaryServiceDoc = parseOptionalBool(params.militaryServiceDoc);
    data.militaryDocStatus = data.militaryServiceDoc ? 'original' : 'none';
  }

  if ('birthCertificateDocStatus' in params) {
    const status = normalizeDocumentStatus(params.birthCertificateDocStatus);
    data.birthCertificateDocStatus = status;
    data.birthCertificateOriginal = syncLegacyDocBooleans(status).birthCertificateOriginal;
  } else if ('birthCertificateOriginal' in params) {
    data.birthCertificateOriginal = parseOptionalBool(params.birthCertificateOriginal);
    data.birthCertificateDocStatus = data.birthCertificateOriginal ? 'original' : 'none';
  }

  if ('personalPhotoCount' in params) {
    data.personalPhotoCount = Math.max(0, parseOptionalInt(params.personalPhotoCount));
  }

  if ('fawryAccount' in params) data.hasFawryAccount = parseOptionalBool(params.fawryAccount);
  if ('hasFawryAccount' in params) data.hasFawryAccount = parseOptionalBool(params.hasFawryAccount);
  if ('fawryPhone' in params) data.fawryAccount = String(params.fawryPhone ?? '');

  if ('bankIban' in params) {
    const ibanCheck = validateEgyptianIban(params.bankIban, false);
    if (!ibanCheck.valid) {
      throw new AppError(ibanCheck.error ?? 'رقم IBAN غير صالح', 400, 'VALIDATION');
    }
    data.bankIban = ibanCheck.normalized;
  }

  if ('mobileLinePhone' in params) {
    const phone = String(params.mobileLinePhone ?? '').replace(/\s/g, '');
    if (phone && !/^01[0125]\d{8}$/.test(phone)) {
      throw new AppError('رقم الخط غير صالح (مثال: 01012345678)', 400, 'VALIDATION');
    }
    data.mobileLinePhone = phone || null;
  }

  if ('skillLevel' in params) {
    const v = String(params.skillLevel ?? '');
    data.skillLevel = v || null;
  }

  if ('insuranceNumber' in params) data.insuranceNumber = String(params.insuranceNumber ?? '');
  if ('insuranceStatus' in params) {
    const v = String(params.insuranceStatus ?? '');
    data.insuranceStatus = v || null;
  }
  if ('insuranceCompanyId' in params) {
    const v = params.insuranceCompanyId;
    data.insuranceCompanyId = v && v !== false ? String(v) : null;
  }
  if ('medicalInsuranceStatus' in params) {
    const v = String(params.medicalInsuranceStatus ?? '');
    data.medicalInsuranceStatus = v || null;
  }
  if ('medicalInsuranceCompanyId' in params) {
    const v = params.medicalInsuranceCompanyId;
    data.medicalInsuranceCompanyId = v && v !== false ? String(v) : null;
  }
  if ('insuranceSalary' in params) data.insuranceSalary = parseOptionalFloat(params.insuranceSalary);
  if ('medicalInsuranceSalary' in params) {
    data.medicalInsuranceSalary = parseOptionalFloat(params.medicalInsuranceSalary);
  }
  if ('leaveStartingBalance' in params) {
    data.leaveStartingBalance = parseOptionalFloat(params.leaveStartingBalance);
  }
  if ('usedLeaveDays' in params) data.usedLeaveDays = parseOptionalFloat(params.usedLeaveDays);
  if ('remainingLeaveBalance' in params) {
    data.remainingLeaveBalance = parseOptionalFloat(params.remainingLeaveBalance);
  }

  if ('healthCertificateIssueDate' in params) {
    const issue = parseOptionalDate(params.healthCertificateIssueDate);
    data.healthCertificateIssueDate = issue;
    if (issue && !('healthCertificateExpiryDate' in params)) {
      data.healthCertificateExpiryDate = addOneYear(issue);
    }
  }
  if ('healthCertificateExpiryDate' in params) {
    data.healthCertificateExpiryDate = parseOptionalDate(params.healthCertificateExpiryDate);
  }

  return data;
}
