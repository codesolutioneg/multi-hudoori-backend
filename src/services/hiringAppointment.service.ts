import { HiringAppointmentStatus, Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';
import { generateHiringAppointmentPdf, readHiringAppointmentPdf } from './hiringAppointmentPdf.service';
import { provisionEmployeeFromHiringAppointment, type HiringProvisionResult } from './hiringAppointmentProvision.service';
import { parseEgyptianNationalId } from '../utils/egyptianNationalId';
import { assertEnglishCode } from '../utils/englishText';

export type CreateHiringAppointmentInput = {
  appointmentDate: Date;
  employeeName: string;
  mobilePhone: string;
  nationalId: string;
  jobTitle: string;
  locationId?: string | null;
  fingerprintCode: string;
  firstWorkingDay: Date;
  createdByUserId: string;
  /** When true, national ID may be empty and is stored blank. */
  skipNationalId?: boolean;
};

export type ExistingHiringEmployeeJson = {
  id: string;
  name: string;
  code: string;
  jobTitle: string;
  locationName: string;
  nationalIdConfirm: string;
  archived: boolean;
  matchBy: 'code' | 'nationalId';
};

export type ExistingHiringAppointmentJson = {
  id: string;
  employeeName: string;
  fingerprintCode: string;
  jobTitle: string;
  locationName: string;
  status: string;
  appointmentDate: string;
  firstWorkingDay: string;
  nationalId: string;
};

export type CreateHiringAppointmentResult =
  | {
      kind: 'created';
      appointment: Prisma.HiringAppointmentGetPayload<{ include: { location: true; createdBy: true } }>;
    }
  | { kind: 'existing'; employee: ExistingHiringEmployeeJson }
  | { kind: 'existing_appointment'; appointment: ExistingHiringAppointmentJson };

function existingHiringEmployeeJson(
  employee: {
    id: string;
    name: string;
    displayName: string | null;
    code: string | null;
    identificationId: string | null;
    jobTitle: string | null;
    nationalIdConfirm: string | null;
    archivedAt: Date | null;
    location: string | null;
    workLocation?: { name: string } | null;
  },
  matchBy: 'code' | 'nationalId',
): ExistingHiringEmployeeJson {
  return {
    id: employee.id,
    name: (employee.displayName || employee.name || '').trim(),
    code: (employee.code || employee.identificationId || '').trim(),
    jobTitle: employee.jobTitle ?? '',
    locationName: employee.workLocation?.name ?? employee.location ?? '',
    nationalIdConfirm: employee.nationalIdConfirm ?? '',
    archived: employee.archivedAt != null,
    matchBy,
  };
}

async function findExistingAppointmentForHiring(fingerprintCode: string) {
  const code = fingerprintCode.trim();
  if (!code) return null;
  return prisma.hiringAppointment.findFirst({
    where: { fingerprintCode: { equals: code, mode: 'insensitive' } },
    include: { location: true },
    orderBy: { createdAt: 'desc' },
  });
}

function existingHiringAppointmentJson(
  row: Prisma.HiringAppointmentGetPayload<{ include: { location: true } }>,
): ExistingHiringAppointmentJson {
  return {
    id: row.id,
    employeeName: row.employeeName,
    fingerprintCode: row.fingerprintCode,
    jobTitle: row.jobTitle,
    locationName: row.location?.name ?? '',
    status: row.status,
    appointmentDate: formatDateOnlyUtc(row.appointmentDate),
    firstWorkingDay: formatDateOnlyUtc(row.firstWorkingDay),
    nationalId: row.nationalId,
  };
}

async function findExistingEmployeeForHiring(opts: {
  fingerprintCode: string;
  nationalId: string;
}) {
  const code = opts.fingerprintCode.trim();
  const nationalId = opts.nationalId.trim();

  const byCode = code
    ? await prisma.employeeProfile.findFirst({
        where: {
          OR: [
            { code: { equals: code, mode: 'insensitive' } },
            { identificationId: { equals: code, mode: 'insensitive' } },
          ],
        },
        include: { workLocation: true },
      })
    : null;
  if (byCode) return { employee: byCode, matchBy: 'code' as const };

  if (!nationalId) return null;
  const byNid = await prisma.employeeProfile.findFirst({
    where: { nationalIdConfirm: nationalId },
    include: { workLocation: true },
  });
  if (byNid) return { employee: byNid, matchBy: 'nationalId' as const };
  return null;
}

/** Parse YYYY-MM-DD (or Date) as UTC midnight — avoids Berlin/Cairo day-shift on @db.Date. */
export function parseDateOnly(value: unknown, field: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const raw = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new AppError(`${field} غير صالح`, 400, 'VALIDATION');
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function formatDateOnlyUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function hiringAppointmentJson(
  row: Prisma.HiringAppointmentGetPayload<{ include: { location: true; createdBy: true } }>,
) {
  return {
    id: row.id,
    appointmentDate: formatDateOnlyUtc(row.appointmentDate),
    employeeName: row.employeeName,
    mobilePhone: row.mobilePhone,
    nationalId: row.nationalId,
    jobTitle: row.jobTitle,
    locationId: row.locationId,
    locationName: row.location?.name ?? '',
    fingerprintCode: row.fingerprintCode,
    firstWorkingDay: formatDateOnlyUtc(row.firstWorkingDay),
    status: row.status,
    statusNote: row.statusNote,
    pdfPath: row.pdfPath,
    hasPdf: Boolean(row.pdfPath),
    createdByUserId: row.createdByUserId,
    createdByName: row.createdBy?.name ?? '',
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByName: row.approvedByName,
    hrSeen: row.hrSeenAt != null,
    externalRef: row.externalRef,
    employeeProfileId: row.employeeProfileId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createHiringAppointment(
  input: CreateHiringAppointmentInput,
): Promise<CreateHiringAppointmentResult> {
  const name = input.employeeName.trim();
  if (name.length < 2) throw new AppError('اسم الموظف مطلوب', 400, 'VALIDATION');
  const jobTitle = input.jobTitle.trim();
  if (!jobTitle) throw new AppError('الوظيفة مطلوبة', 400, 'VALIDATION');

  const skipNationalId = input.skipNationalId === true;
  const nationalIdRaw = input.nationalId.trim();
  let nationalIdToStore = '';
  if (skipNationalId) {
    nationalIdToStore = '';
  } else {
    const parsed = parseEgyptianNationalId(nationalIdRaw);
    if (!parsed.valid) {
      throw new AppError(parsed.error ?? 'رقم البطاقة غير صالح', 400, 'VALIDATION');
    }
    nationalIdToStore = parsed.nationalId;
  }

  const fingerprintCode = assertEnglishCode(input.fingerprintCode);

  let locationId: string | null = input.locationId ? String(input.locationId) : null;
  if (locationId) {
    const loc = await prisma.location.findUnique({ where: { id: locationId } });
    if (!loc) throw new AppError('الفرع غير موجود', 400, 'VALIDATION');
  }

  const existingAppointment = await findExistingAppointmentForHiring(fingerprintCode);
  if (existingAppointment) {
    return {
      kind: 'existing_appointment',
      appointment: existingHiringAppointmentJson(existingAppointment),
    };
  }

  const existingMatch = await findExistingEmployeeForHiring({
    fingerprintCode,
    nationalId: nationalIdToStore,
  });
  if (existingMatch) {
    return {
      kind: 'existing',
      employee: existingHiringEmployeeJson(existingMatch.employee, existingMatch.matchBy),
    };
  }

  let row = await prisma.hiringAppointment.create({
    data: {
      appointmentDate: input.appointmentDate,
      employeeName: name,
      mobilePhone: input.mobilePhone.trim(),
      nationalId: nationalIdToStore,
      jobTitle,
      locationId,
      fingerprintCode,
      firstWorkingDay: input.firstWorkingDay,
      createdByUserId: input.createdByUserId,
      status: HiringAppointmentStatus.pending,
      hrSeenAt: new Date(),
      employeeProfileId: null,
    },
    include: { location: true, createdBy: true },
  });

  const pdf = await generateHiringAppointmentPdf(row);
  row = await prisma.hiringAppointment.update({
    where: { id: row.id },
    data: { pdfPath: pdf.relativePath },
    include: { location: true, createdBy: true },
  });

  return { kind: 'created', appointment: row };
}

export async function listHiringAppointments(options: {
  locationId?: string | null;
  limit?: number;
  offset?: number;
}) {
  const where: Prisma.HiringAppointmentWhereInput = {};
  if (options.locationId) where.locationId = options.locationId;

  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  const [total, items] = await Promise.all([
    prisma.hiringAppointment.count({ where }),
    prisma.hiringAppointment.findMany({
      where,
      include: { location: true, createdBy: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
  ]);

  return { total, items, limit, offset };
}

export async function countPendingHiringAppointments(locationId?: string | null): Promise<number> {
  return prisma.hiringAppointment.count({
    where: {
      status: HiringAppointmentStatus.pending,
      ...(locationId ? { locationId } : {}),
    },
  });
}

export async function countUnreadHiringUpdates(locationId?: string | null): Promise<number> {
  return prisma.hiringAppointment.count({
    where: {
      status: { in: [HiringAppointmentStatus.approved, HiringAppointmentStatus.rejected, HiringAppointmentStatus.cancelled] },
      hrSeenAt: null,
      ...(locationId ? { locationId } : {}),
    },
  });
}

export async function markHiringAppointmentsSeen(locationId?: string | null) {
  await prisma.hiringAppointment.updateMany({
    where: {
      status: { in: [HiringAppointmentStatus.approved, HiringAppointmentStatus.rejected, HiringAppointmentStatus.cancelled] },
      hrSeenAt: null,
      ...(locationId ? { locationId } : {}),
    },
    data: { hrSeenAt: new Date() },
  });
}

export async function getHiringAppointmentPdfBase64(id: string) {
  const row = await prisma.hiringAppointment.findUnique({ where: { id } });
  if (!row?.pdfPath) throw new NotFoundError('PDF not found');
  const buf = await readHiringAppointmentPdf(row.pdfPath);
  if (!buf) throw new NotFoundError('PDF file missing');
  return {
    base64: buf.toString('base64'),
    mimeType: 'application/pdf',
    filename: `hiring-${id}.pdf`,
  };
}

async function regenerateHiringAppointmentPdf(
  row: Prisma.HiringAppointmentGetPayload<{ include: { location: true; createdBy: true } }>,
) {
  const pdf = await generateHiringAppointmentPdf(row);
  return prisma.hiringAppointment.update({
    where: { id: row.id },
    data: { pdfPath: pdf.relativePath },
    include: { location: true, createdBy: true },
  });
}

function parseHiringStatus(value: unknown): HiringAppointmentStatus | null {
  const s = String(value ?? '').toLowerCase();
  if (s === 'approved' || s === 'approve') return HiringAppointmentStatus.approved;
  if (s === 'rejected' || s === 'reject') return HiringAppointmentStatus.rejected;
  if (s === 'cancelled' || s === 'cancel') return HiringAppointmentStatus.cancelled;
  if (s === 'pending') return HiringAppointmentStatus.pending;
  return null;
}

export async function applyHiringAppointmentWebhook(input: {
  appointmentId: string;
  approved?: boolean;
  status?: HiringAppointmentStatus;
  approvedByName?: string;
  externalRef?: string;
  firstWorkingDay?: Date;
  appointmentDate?: Date;
}): Promise<{
  appointment: Prisma.HiringAppointmentGetPayload<{ include: { location: true; createdBy: true } }>;
  provision: HiringProvisionResult | null;
}> {
  const existing = await prisma.hiringAppointment.findUnique({
    where: { id: input.appointmentId },
    include: { location: true, createdBy: true },
  });
  if (!existing) throw new NotFoundError('Appointment not found');

  const nextStatus = input.status
    ?? (input.approved === true
      ? HiringAppointmentStatus.approved
      : input.approved === false
        ? HiringAppointmentStatus.rejected
        : undefined);

  const data: Prisma.HiringAppointmentUpdateInput = {};

  if (nextStatus && nextStatus !== existing.status) {
    if (existing.status !== HiringAppointmentStatus.pending) {
      throw new AppError('لا يمكن تغيير الحالة بعد البت في الطلب', 400, 'VALIDATION');
    }
    data.status = nextStatus;
    data.approvedAt = new Date();
    data.approvedByName = input.approvedByName?.trim() || null;
    data.hrSeenAt = null;
  } else if (input.approvedByName?.trim()) {
    data.approvedByName = input.approvedByName.trim();
  }

  if (input.externalRef?.trim()) {
    data.externalRef = input.externalRef.trim();
  }

  let pdfNeedsRegen = false;
  if (input.firstWorkingDay) {
    data.firstWorkingDay = input.firstWorkingDay;
    pdfNeedsRegen = true;
  }
  if (input.appointmentDate) {
    data.appointmentDate = input.appointmentDate;
    pdfNeedsRegen = true;
  }

  if (Object.keys(data).length === 0) {
    const provision = await provisionEmployeeFromHiringAppointment(existing);
    return { appointment: existing, provision };
  }

  let row = await prisma.hiringAppointment.update({
    where: { id: input.appointmentId },
    data,
    include: { location: true, createdBy: true },
  });

  if (pdfNeedsRegen) {
    row = await regenerateHiringAppointmentPdf(row);
  }

  const provision = await provisionEmployeeFromHiringAppointment(row);
  return { appointment: row, provision };
}

export type UpdateHiringAppointmentInput = {
  id: string;
  appointmentDate?: Date;
  employeeName?: string;
  mobilePhone?: string;
  nationalId?: string;
  jobTitle?: string;
  locationId?: string | null;
  fingerprintCode?: string;
  firstWorkingDay?: Date;
  status?: HiringAppointmentStatus;
  statusNote?: string;
  approvedByName?: string;
  locationScopeId?: string | null;
};

export async function updateHiringAppointment(input: UpdateHiringAppointmentInput) {
  const existing = await prisma.hiringAppointment.findUnique({
    where: { id: input.id },
    include: { location: true, createdBy: true },
  });
  if (!existing) throw new NotFoundError('Appointment not found');

  if (input.locationScopeId && existing.locationId !== input.locationScopeId) {
    throw new AppError('غير مسموح بتعديل هذا التعيين', 403, 'FORBIDDEN');
  }

  const data: Prisma.HiringAppointmentUpdateInput = {};
  let pdfNeedsRegen = false;

  if (input.appointmentDate) {
    data.appointmentDate = input.appointmentDate;
    pdfNeedsRegen = true;
  }
  if (input.firstWorkingDay) {
    data.firstWorkingDay = input.firstWorkingDay;
    pdfNeedsRegen = true;
  }
  if (input.employeeName !== undefined) {
    const name = input.employeeName.trim();
    if (name.length < 2) throw new AppError('اسم الموظف مطلوب', 400, 'VALIDATION');
    data.employeeName = name;
    pdfNeedsRegen = true;
  }
  if (input.mobilePhone !== undefined) {
    const phone = input.mobilePhone.trim();
    if (phone.length < 8) throw new AppError('رقم الهاتف مطلوب', 400, 'VALIDATION');
    data.mobilePhone = phone;
    pdfNeedsRegen = true;
  }
  if (input.nationalId !== undefined) {
    const parsed = parseEgyptianNationalId(input.nationalId.trim());
    if (!parsed.valid) {
      throw new AppError(parsed.error ?? 'رقم البطاقة غير صالح', 400, 'VALIDATION');
    }
    data.nationalId = parsed.nationalId;
    pdfNeedsRegen = true;
  }
  if (input.jobTitle !== undefined) {
    const job = input.jobTitle.trim();
    if (!job) throw new AppError('الوظيفة مطلوبة', 400, 'VALIDATION');
    data.jobTitle = job;
    pdfNeedsRegen = true;
  }
  if (input.fingerprintCode !== undefined) {
    data.fingerprintCode = assertEnglishCode(input.fingerprintCode);
    pdfNeedsRegen = true;
  }
  if (input.locationId !== undefined) {
    if (input.locationScopeId && input.locationId !== existing.locationId) {
      throw new AppError('لا يمكن تغيير الفرع', 403, 'FORBIDDEN');
    }
    const locationId = input.locationId ? String(input.locationId) : null;
    if (locationId) {
      const loc = await prisma.location.findUnique({ where: { id: locationId } });
      if (!loc) throw new AppError('الفرع غير موجود', 400, 'VALIDATION');
      data.location = { connect: { id: locationId } };
    } else {
      data.location = { disconnect: true };
    }
    pdfNeedsRegen = true;
  }
  if (input.status !== undefined && input.status !== existing.status) {
    const resending =
      input.status === HiringAppointmentStatus.pending
      && (existing.status === HiringAppointmentStatus.cancelled
        || existing.status === HiringAppointmentStatus.rejected);

    if (existing.status !== HiringAppointmentStatus.pending && !resending) {
      throw new AppError('لا يمكن تغيير الحالة بعد البت في الطلب', 400, 'VALIDATION');
    }

    if (resending) {
      data.status = HiringAppointmentStatus.pending;
      data.approvedAt = null;
      data.approvedByName = null;
      data.statusNote = null;
      data.hrSeenAt = new Date();
    } else {
      if (input.status === HiringAppointmentStatus.cancelled) {
        const note = input.statusNote?.trim();
        if (!note) throw new AppError('ملاحظة الإلغاء مطلوبة', 400, 'VALIDATION');
        data.statusNote = note;
      }
      data.status = input.status;
      if (
        input.status === HiringAppointmentStatus.approved
        || input.status === HiringAppointmentStatus.rejected
        || input.status === HiringAppointmentStatus.cancelled
      ) {
        data.approvedAt = new Date();
        data.approvedByName = input.approvedByName?.trim() || null;
        data.hrSeenAt = null;
      }
    }
  } else if (input.statusNote !== undefined) {
    data.statusNote = input.statusNote.trim() || null;
  }

  if (Object.keys(data).length === 0) {
    return existing;
  }

  let row = await prisma.hiringAppointment.update({
    where: { id: input.id },
    data,
    include: { location: true, createdBy: true },
  });

  if (pdfNeedsRegen) {
    row = await regenerateHiringAppointmentPdf(row);
  }

  return row;
}

export function parseUpdateHiringAppointmentParams(
  params: Record<string, unknown>,
  locationScopeId?: string | null,
): UpdateHiringAppointmentInput {
  const id = String(params.id ?? params.appointmentId ?? '');
  if (!id) throw new AppError('معرّف التعيين مطلوب', 400, 'VALIDATION');

  const input: UpdateHiringAppointmentInput = { id, locationScopeId };

  if (params.appointmentDate != null || params.date != null) {
    input.appointmentDate = parseDateOnly(params.appointmentDate ?? params.date, 'appointmentDate');
  }
  if (params.firstWorkingDay != null || params.startDate != null) {
    input.firstWorkingDay = parseDateOnly(params.firstWorkingDay ?? params.startDate, 'firstWorkingDay');
  }
  if (params.employeeName != null || params.name != null) {
    input.employeeName = String(params.employeeName ?? params.name);
  }
  if (params.mobilePhone != null || params.phone != null) {
    input.mobilePhone = String(params.mobilePhone ?? params.phone);
  }
  if (params.nationalId != null) {
    input.nationalId = String(params.nationalId);
  }
  if (params.jobTitle != null || params.job != null) {
    input.jobTitle = String(params.jobTitle ?? params.job);
  }
  if (params.fingerprintCode != null || params.code != null) {
    input.fingerprintCode = String(params.fingerprintCode ?? params.code);
  }
  if (params.locationId !== undefined) {
    input.locationId = params.locationId ? String(params.locationId) : null;
  }
  const status = parseHiringStatus(params.status);
  if (status) input.status = status;
  if (params.statusNote != null || params.note != null) {
    input.statusNote = String(params.statusNote ?? params.note);
  }

  return input;
}

export function parseHiringAppointmentWebhookParams(params: Record<string, unknown>) {
  const appointmentId = String(params.appointmentId ?? params.id ?? '');
  if (!appointmentId) throw new AppError('appointmentId مطلوب', 400, 'VALIDATION');

  const status = parseHiringStatus(params.status);
  const approved = params.approved === true || status === HiringAppointmentStatus.approved
    ? true
    : params.approved === false || status === HiringAppointmentStatus.rejected
      ? false
      : undefined;

  const result: Parameters<typeof applyHiringAppointmentWebhook>[0] = {
    appointmentId,
    approved,
    status: status ?? undefined,
    approvedByName: params.approvedByName ? String(params.approvedByName) : undefined,
    externalRef: params.externalRef ? String(params.externalRef) : undefined,
  };

  if (params.firstWorkingDay != null || params.startDate != null) {
    result.firstWorkingDay = parseDateOnly(params.firstWorkingDay ?? params.startDate, 'firstWorkingDay');
  }
  if (params.appointmentDate != null || params.date != null) {
    result.appointmentDate = parseDateOnly(params.appointmentDate ?? params.date, 'appointmentDate');
  }

  return result;
}

export function parseCreateHiringAppointmentParams(
  params: Record<string, unknown>,
  createdByUserId: string,
): CreateHiringAppointmentInput {
  const skipRaw = params.skipNationalId ?? params.skip_national_id;
  const skipNationalId =
    skipRaw === true
    || skipRaw === 'true'
    || skipRaw === 1
    || skipRaw === '1';
  return {
    appointmentDate: parseDateOnly(params.appointmentDate ?? params.date ?? new Date(), 'appointmentDate'),
    employeeName: String(params.employeeName ?? params.name ?? ''),
    mobilePhone: String(params.mobilePhone ?? params.phone ?? ''),
    nationalId: String(params.nationalId ?? params.nationalIdConfirm ?? ''),
    jobTitle: String(params.jobTitle ?? params.job ?? ''),
    locationId: params.locationId ? String(params.locationId) : null,
    fingerprintCode: String(params.fingerprintCode ?? params.code ?? ''),
    firstWorkingDay: parseDateOnly(params.firstWorkingDay ?? params.hiringDate ?? new Date(), 'firstWorkingDay'),
    createdByUserId,
    skipNationalId,
  };
}
