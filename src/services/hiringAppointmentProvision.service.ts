import { HiringAppointmentStatus, type HiringAppointment, type Location } from '@prisma/client';
import { prisma } from '../prisma/client';
import { applyEmployeeLocation } from './location.service';
import { isValidEmployeeCode } from './employeeCode.service';
import { pushEmployeeToBioTime } from './biotime/employeePush.service';
import { parseEgyptianNationalId } from '../utils/egyptianNationalId';
import { AppError } from '../utils/errors';

export type HiringProvisionResult = {
  employeeId: string;
  userId: string | null;
  login: string | null;
  created: boolean;
  biotimePushed: boolean;
  biotimePushError?: string;
};

type AppointmentRow = HiringAppointment & { location?: Location | null };

function genderFromNationalId(nationalId: string): string | null {
  if (nationalId.length !== 14) return null;
  const digit = Number(nationalId[12]);
  if (Number.isNaN(digit)) return null;
  return digit % 2 === 1 ? 'male' : 'female';
}

function provisionFromProfile(opts: {
  employeeId: string;
  userId?: string | null;
  login?: string | null;
  created: boolean;
  biotimePushed?: boolean;
  biotimePushError?: string;
}): HiringProvisionResult {
  return {
    employeeId: opts.employeeId,
    userId: opts.userId ?? null,
    login: opts.login ?? null,
    created: opts.created,
    biotimePushed: opts.biotimePushed ?? false,
    biotimePushError: opts.biotimePushError,
  };
}

async function pushProfileToBioTime(employeeId: string, alreadySynced: boolean) {
  if (alreadySynced) {
    return { biotimePushed: true as const };
  }
  try {
    await pushEmployeeToBioTime(employeeId);
    return { biotimePushed: true as const };
  } catch (err) {
    return {
      biotimePushed: false as const,
      biotimePushError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function linkAppointmentProfile(appointmentId: string, employeeProfileId: string) {
  await prisma.hiringAppointment.update({
    where: { id: appointmentId },
    data: { employeeProfileId },
  });
}

export async function provisionEmployeeFromHiringAppointment(
  appointment: AppointmentRow,
): Promise<HiringProvisionResult | null> {
  if (appointment.status !== HiringAppointmentStatus.approved) {
    return null;
  }

  if (appointment.employeeProfileId) {
    const linked = await prisma.employeeProfile.findUnique({
      where: { id: appointment.employeeProfileId },
      include: { user: true },
    });
    if (linked) {
      return provisionFromProfile({
        employeeId: linked.id,
        userId: linked.user?.id ?? null,
        login: linked.user?.login ?? null,
        created: false,
        biotimePushed: linked.biotimeSynced,
      });
    }
  }

  const nationalId = appointment.nationalId.trim();
  const code = appointment.fingerprintCode.trim();
  if (!code || !isValidEmployeeCode(code)) {
    throw new AppError('كود البصمة غير صالح لإنشاء الموظف', 400, 'VALIDATION');
  }

  if (nationalId) {
    const existingByNid = await prisma.employeeProfile.findFirst({
      where: { nationalIdConfirm: nationalId },
      include: { user: true },
    });
    if (existingByNid) {
      const profileLinkedElsewhere = await prisma.hiringAppointment.findFirst({
        where: {
          employeeProfileId: existingByNid.id,
          id: { not: appointment.id },
        },
        select: { id: true },
      });
      if (!profileLinkedElsewhere && appointment.employeeProfileId !== existingByNid.id) {
        await linkAppointmentProfile(appointment.id, existingByNid.id);
      }
      return provisionFromProfile({
        employeeId: existingByNid.id,
        userId: existingByNid.user?.id ?? null,
        login: existingByNid.user?.login ?? null,
        created: false,
        biotimePushed: existingByNid.biotimeSynced,
      });
    }
  }

  const duplicateCode = await prisma.employeeProfile.findFirst({
    where: {
      OR: [
        { code: { equals: code, mode: 'insensitive' } },
        { identificationId: { equals: code, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  if (duplicateCode) {
    throw new AppError(`كود البصمة ${code} مستخدم بالفعل`, 409, 'DUPLICATE');
  }

  const parsedNid = nationalId
    ? parseEgyptianNationalId(nationalId)
    : { valid: false as const, birthDate: null as Date | null };
  const locData = await applyEmployeeLocation(appointment.locationId);
  const gender = nationalId ? genderFromNationalId(nationalId) : null;

  const employee = await prisma.$transaction(async (tx) => {
    const createdEmployee = await tx.employeeProfile.create({
      data: {
        name: appointment.employeeName.trim(),
        displayName: appointment.employeeName.trim(),
        code,
        identificationId: code,
        barcode: code,
        mobilePhone: appointment.mobilePhone.trim() || null,
        jobTitle: appointment.jobTitle.trim() || null,
        nationalIdConfirm: nationalId || null,
        birthday: parsedNid.birthDate ?? null,
        gender,
        locationId: locData.locationId,
        location: locData.location || null,
        hiringDate: appointment.firstWorkingDay,
        active: true,
        biotimeSynced: false,
      },
    });

    await tx.hiringAppointment.update({
      where: { id: appointment.id },
      data: { employeeProfileId: createdEmployee.id },
    });

    return createdEmployee;
  });

  const push = await pushProfileToBioTime(employee.id, false);
  return provisionFromProfile({
    employeeId: employee.id,
    created: true,
    ...push,
  });
}

export function hiringProvisionJson(result: HiringProvisionResult | null) {
  if (!result) return null;
  return {
    employeeId: result.employeeId,
    userId: result.userId,
    login: result.login,
    created: result.created,
    biotimePushed: result.biotimePushed,
    biotimePushError: result.biotimePushError ?? null,
  };
}
