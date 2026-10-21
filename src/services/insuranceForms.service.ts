/**
 * Insurance forms س1 / س6 — establishments, employee lookup, save & PDF.
 */
import { InsuranceFormType, Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { insuranceWageFromShare } from '../utils/insuranceWage';
import { renderInsuranceFormPdf } from './insuranceFormPdf.service';

export type InsuranceFormPayload = Record<string, unknown>;

function str(v: unknown): string {
  return String(v ?? '').trim();
}

export function normalizeFormType(raw: unknown): InsuranceFormType {
  const t = str(raw).toUpperCase().replace('س', 'S');
  if (t === 'S1' || t === '1') return InsuranceFormType.S1;
  if (t === 'S6' || t === '6') return InsuranceFormType.S6;
  throw new AppError('نوع الاستمارة يجب أن يكون س1 أو س6', 400, 'VALIDATION');
}

export async function listEstablishments(activeOnly = false) {
  return prisma.insuranceEstablishment.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
  });
}

export async function upsertEstablishment(input: {
  id?: string;
  name: string;
  insuranceNumber?: string | null;
  office?: string | null;
  address?: string | null;
  buildingNumber?: string | null;
  street?: string | null;
  village?: string | null;
  district?: string | null;
  governorate?: string | null;
  establishmentType?: string | null;
  phone?: string | null;
  active?: boolean;
  sequence?: number;
}) {
  const name = str(input.name);
  if (!name) throw new AppError('اسم المنشأة مطلوب', 400, 'VALIDATION');
  const data = {
    name,
    insuranceNumber: str(input.insuranceNumber) || null,
    office: str(input.office) || null,
    address: str(input.address) || null,
    buildingNumber: str(input.buildingNumber) || null,
    street: str(input.street) || null,
    village: str(input.village) || null,
    district: str(input.district) || null,
    governorate: str(input.governorate) || null,
    establishmentType: str(input.establishmentType) || null,
    phone: str(input.phone) || null,
    active: input.active !== false,
    sequence: Number.isFinite(Number(input.sequence)) ? Number(input.sequence) : 10,
  };
  if (input.id) {
    return prisma.insuranceEstablishment.update({ where: { id: input.id }, data });
  }
  return prisma.insuranceEstablishment.create({ data });
}

export async function deleteEstablishment(id: string) {
  await prisma.insuranceEstablishment.delete({ where: { id } });
}

/** Lookup by insurance number or national ID (exact, company-scoped via prisma). */
export async function lookupEmployeeForInsuranceForm(query: string) {
  const q = str(query);
  if (!q) throw new AppError('أدخل الرقم التأميني أو الرقم القومي', 400, 'VALIDATION');

  const employee = await prisma.employeeProfile.findFirst({
    where: {
      OR: [
        { insuranceNumber: { equals: q, mode: 'insensitive' } },
        { nationalIdConfirm: { equals: q, mode: 'insensitive' } },
        { identificationId: { equals: q, mode: 'insensitive' } },
        { code: { equals: q, mode: 'insensitive' } },
      ],
    },
    include: {
      workLocation: { select: { id: true, name: true, actualName: true } },
      department: { select: { id: true, name: true, nameEn: true } },
    },
  });
  if (!employee) {
    throw new AppError('لم يتم العثور على موظف بهذه البيانات', 404, 'NOT_FOUND');
  }

  const address = str(employee.address);
  return {
    employeeId: employee.id,
    employeeName: employee.name,
    employeeCode: employee.code,
    insuranceNumber: employee.insuranceNumber,
    nationalId: employee.nationalIdConfirm || employee.identificationId,
    nationality: employee.isForeigner ? '' : 'مصري',
    qualification: '',
    jobTitle: employee.jobTitle,
    subscriptionStartDate: employee.hiringDate
      ? employee.hiringDate.toISOString().slice(0, 10)
      : '',
    subscriptionWage: insuranceWageFromShare(employee.employeeInsuranceShare),
    totalWage: employee.basicSalary || 0,
    phone: employee.mobilePhone || employee.workPhone || '',
    address,
    buildingNumber: '',
    street: address,
    village: '',
    district: '',
    governorate: '',
    locationId: employee.locationId,
    locationName:
      employee.workLocation?.actualName || employee.workLocation?.name || '',
    departmentName: employee.department?.name || employee.department?.nameEn || '',
    active: employee.active,
    departureDate: employee.departureDate
      ? employee.departureDate.toISOString().slice(0, 10)
      : '',
  };
}

function mapForm(row: {
  id: string;
  formType: InsuranceFormType;
  employeeId: string | null;
  employeeName: string;
  employeeCode: string | null;
  insuranceNumber: string | null;
  nationalId: string | null;
  establishmentId: string | null;
  payload: Prisma.JsonValue;
  createdByUserId: string;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  establishment?: { id: string; name: string } | null;
}) {
  return {
    id: row.id,
    formType: row.formType,
    formTypeLabel: row.formType === InsuranceFormType.S1 ? 'س1' : 'س6',
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    employeeCode: row.employeeCode,
    insuranceNumber: row.insuranceNumber,
    nationalId: row.nationalId,
    establishmentId: row.establishmentId,
    establishmentName: row.establishment?.name ?? null,
    payload: (row.payload ?? {}) as InsuranceFormPayload,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listInsuranceForms(params: {
  formType?: InsuranceFormType;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const search = str(params.search);
  const where: Prisma.InsuranceFormWhereInput = {
    ...(params.formType ? { formType: params.formType } : {}),
    ...(search
      ? {
          OR: [
            { employeeName: { contains: search, mode: 'insensitive' } },
            { employeeCode: { contains: search, mode: 'insensitive' } },
            { insuranceNumber: { contains: search, mode: 'insensitive' } },
            { nationalId: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.insuranceForm.findMany({
      where,
      include: { establishment: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.insuranceForm.count({ where }),
  ]);
  return { items: items.map(mapForm), total, limit, offset };
}

export async function getInsuranceForm(id: string) {
  const row = await prisma.insuranceForm.findUnique({
    where: { id },
    include: { establishment: { select: { id: true, name: true } } },
  });
  if (!row) throw new AppError('الاستمارة غير موجودة', 404, 'NOT_FOUND');
  return mapForm(row);
}

export async function saveInsuranceForm(input: {
  id?: string;
  formType: unknown;
  employeeId?: string | null;
  establishmentId?: string | null;
  payload: InsuranceFormPayload;
  createdByUserId: string;
  createdByName?: string | null;
}) {
  const formType = normalizeFormType(input.formType);
  const payload = { ...(input.payload ?? {}) };
  const employeeName =
    str(payload.employeeName) || str(payload.name) || 'بدون اسم';
  const employeeCode = str(payload.employeeCode) || str(payload.code) || null;
  const insuranceNumber = str(payload.insuranceNumber) || null;
  const nationalId = str(payload.nationalId) || null;
  const establishmentId = str(input.establishmentId) || null;

  if (establishmentId) {
    const est = await prisma.insuranceEstablishment.findUnique({
      where: { id: establishmentId },
    });
    if (!est) throw new AppError('المنشأة غير موجودة', 404, 'NOT_FOUND');
    // Fill missing establishment fields from settings when empty in payload.
    const fill = (key: string, value: string | null | undefined) => {
      if (!str(payload[key]) && value) payload[key] = value;
    };
    fill('establishmentName', est.name);
    fill('establishmentInsuranceNumber', est.insuranceNumber);
    fill('office', est.office);
    fill('establishmentAddress', est.address);
    fill('buildingNumber', est.buildingNumber);
    fill('street', est.street);
    fill('village', est.village);
    fill('district', est.district);
    fill('governorate', est.governorate);
    fill('establishmentType', est.establishmentType);
    fill('establishmentPhone', est.phone);
  }

  // S6 end reason stays empty by default unless user fills it.
  if (formType === InsuranceFormType.S6 && payload.endReason === undefined) {
    payload.endReason = '';
  }

  const data = {
    formType,
    employeeId: str(input.employeeId) || null,
    employeeName,
    employeeCode,
    insuranceNumber,
    nationalId,
    establishmentId,
    payload: payload as Prisma.InputJsonValue,
    createdByName: str(input.createdByName) || null,
  };

  if (input.id) {
    const updated = await prisma.insuranceForm.update({
      where: { id: input.id },
      data,
      include: { establishment: { select: { id: true, name: true } } },
    });
    return mapForm(updated);
  }

  if (!str(input.createdByUserId)) {
    throw new AppError('المستخدم غير معروف', 401, 'UNAUTHORIZED');
  }

  const created = await prisma.insuranceForm.create({
    data: {
      ...data,
      createdByUserId: input.createdByUserId,
    },
    include: { establishment: { select: { id: true, name: true } } },
  });
  return mapForm(created);
}

export async function generateInsuranceFormPdfBase64(id: string) {
  const form = await getInsuranceForm(id);
  // HTML print layout (Nova-style) — Excel/LibreOffice path retired.
  const pdf = await renderInsuranceFormPdf({
    formType: form.formType,
    payload: form.payload,
    meta: {
      employeeName: form.employeeName,
      createdAt: form.createdAt,
      createdByName: form.createdByName,
    },
  });
  return {
    ...form,
    filename: pdf.filename,
    mimeType: 'application/pdf',
    base64: pdf.base64,
  };
}
