import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../prisma/client';
import { NotFoundError } from '../utils/errors';
import { requireCompanyId } from '../tenant/context';

export const DOCUMENT_STATUSES = ['none', 'copy', 'original'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const EMPLOYEE_DOCUMENT_TYPES = [
  'id_card',
  'qualification',
  'military',
  'birth_certificate',
  'criminal_record',
  'personal_photo',
  'insurance_print',
] as const;
export type EmployeeDocumentType = (typeof EMPLOYEE_DOCUMENT_TYPES)[number];

function uploadRoot(): string {
  return path.join(process.cwd(), 'uploads', requireCompanyId(), 'employee-documents');
}

const DOC_URL_FIELD: Record<EmployeeDocumentType, string> = {
  id_card: 'idCardPhotoUrl',
  qualification: 'qualificationDocUrl',
  military: 'militaryDocUrl',
  birth_certificate: 'birthCertificateDocUrl',
  criminal_record: 'criminalRecordDocUrl',
  personal_photo: 'personalPhotoDocUrl',
  insurance_print: 'insurancePrintUrl',
};

const DOC_BOOL_FIELD: Partial<Record<EmployeeDocumentType, string>> = {
  id_card: 'idCardPhoto',
  criminal_record: 'criminalRecord',
  personal_photo: 'personalPhoto',
  insurance_print: 'insurancePrint',
};

function stripBase64Payload(input: string): string {
  const comma = input.indexOf(',');
  return comma >= 0 ? input.slice(comma + 1) : input;
}

function extFromMime(mimeType?: string): string {
  const m = (mimeType ?? '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  return 'jpg';
}

export function normalizeDocumentStatus(value: unknown): DocumentStatus {
  const v = String(value ?? 'none').trim().toLowerCase();
  if (v === 'copy' || v === 'original') return v;
  return 'none';
}

export function syncLegacyDocBooleans(status: DocumentStatus) {
  return {
    qualificationOriginal: status === 'original',
    birthCertificateOriginal: status === 'original',
    militaryServiceDoc: status === 'original',
  };
}

export function parseEmployeeDocumentType(value: unknown): EmployeeDocumentType | null {
  const v = String(value ?? '').trim().toLowerCase();
  return (EMPLOYEE_DOCUMENT_TYPES as readonly string[]).includes(v) ? (v as EmployeeDocumentType) : null;
}

function docFilename(docType: EmployeeDocumentType, ext: string): string {
  return `${docType}.${ext}`;
}

export async function saveEmployeeDocument(
  employeeId: string,
  docType: EmployeeDocumentType,
  base64: string,
  mimeType?: string,
): Promise<{ relativePath: string; documentType: EmployeeDocumentType }> {
  const emp = await prisma.employeeProfile.findUnique({ where: { id: employeeId } });
  if (!emp) throw new NotFoundError('Employee not found');

  const dir = path.join(uploadRoot(), employeeId);
  await fs.mkdir(dir, { recursive: true });
  const ext = extFromMime(mimeType);
  const filename = docFilename(docType, ext);
  const fullPath = path.join(dir, filename);
  const buf = Buffer.from(stripBase64Payload(base64), 'base64');
  if (!buf.length) throw new Error('ملف فارغ');

  await fs.writeFile(fullPath, buf);
  const relativePath = `${employeeId}/${filename}`;
  const urlField = DOC_URL_FIELD[docType];
  const boolField = DOC_BOOL_FIELD[docType];
  await prisma.employeeProfile.update({
    where: { id: employeeId },
    data: {
      [urlField]: relativePath,
      ...(boolField ? { [boolField]: true } : {}),
    },
  });
  return { relativePath, documentType: docType };
}

export async function readEmployeeDocument(
  employeeId: string,
  docType: EmployeeDocumentType,
): Promise<{ base64: string; mimeType: string; filename: string } | null> {
  const emp = await prisma.employeeProfile.findUnique({ where: { id: employeeId } });
  if (!emp) return null;
  const urlField = DOC_URL_FIELD[docType] as keyof typeof emp;
  const relativePath = emp[urlField] as string | null | undefined;
  if (!relativePath) return null;

  const fullPath = path.join(uploadRoot(), relativePath);
  try {
    const buf = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const mimeType =
      ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return {
      base64: buf.toString('base64'),
      mimeType,
      filename: path.basename(fullPath),
    };
  } catch {
    return null;
  }
}

export async function saveInsurancePrint(
  employeeId: string,
  base64: string,
  mimeType?: string,
): Promise<{ relativePath: string }> {
  const result = await saveEmployeeDocument(employeeId, 'insurance_print', base64, mimeType);
  return { relativePath: result.relativePath };
}

export async function readInsurancePrint(employeeId: string): Promise<{
  base64: string;
  mimeType: string;
  filename: string;
} | null> {
  return readEmployeeDocument(employeeId, 'insurance_print');
}

export function employeeDocumentUrls(employee: {
  idCardPhotoUrl?: string | null;
  qualificationDocUrl?: string | null;
  militaryDocUrl?: string | null;
  birthCertificateDocUrl?: string | null;
  criminalRecordDocUrl?: string | null;
  personalPhotoDocUrl?: string | null;
  insurancePrintUrl?: string | null;
}) {
  return {
    idCardPhotoUrl: employee.idCardPhotoUrl ?? '',
    qualificationDocUrl: employee.qualificationDocUrl ?? '',
    militaryDocUrl: employee.militaryDocUrl ?? '',
    birthCertificateDocUrl: employee.birthCertificateDocUrl ?? '',
    criminalRecordDocUrl: employee.criminalRecordDocUrl ?? '',
    personalPhotoDocUrl: employee.personalPhotoDocUrl ?? '',
    insurancePrintUrl: employee.insurancePrintUrl ?? '',
  };
}
