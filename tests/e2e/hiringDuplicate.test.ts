import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { HiringAppointmentStatus, UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import { createLocation, createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';

const NID = '29001011234571';
const NID_OTHER = '29001011234582';
const NID_NEW = '29001011234593';

describe('hiring appointment duplicate guards', () => {
  let hr: SeededUser;
  let locationId: string;
  let employeeId: string;

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    const loc = await createLocation({ name: 'Cairo', code: 'CAI' });
    locationId = loc.id;
    hr = await createUser({ login: 'hr-dup@test.local', role: UserRole.HR_MANAGER });
    const profile = await prisma.employeeProfile.create({
      data: {
        name: 'Old Employee',
        displayName: 'Old Employee',
        code: '7259',
        identificationId: '7259',
        jobTitle: 'Waiter',
        mobilePhone: '01000000000',
        nationalIdConfirm: NID,
        locationId,
        location: 'Cairo',
        basicSalary: 3000,
      },
    });
    employeeId = profile.id;
  });

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      appointmentDate: '2026-08-19',
      employeeName: 'New Hire',
      mobilePhone: '01111111111',
      nationalId: NID_OTHER,
      jobTitle: 'Cashier',
      fingerprintCode: '7259',
      firstWorkingDay: '2026-08-20',
      locationId,
      ...overrides,
    };
  }

  it('returns EXISTING_EMPLOYEE when fingerprint code exists on an employee', async () => {
    const res = await rpc('/api/biotime/hiring-appointments/create', payload(), hr.token);
    expectFail(res, 'EXISTING_EMPLOYEE');
    const existing = res.body.result?.data?.existingEmployee as Record<string, unknown>;
    expect(existing.id).toBe(employeeId);
    expect(existing.code).toBe('7259');
    expect(existing.matchBy).toBe('code');
    expect(await prisma.hiringAppointment.count()).toBe(0);
  });

  it('returns EXISTING_APPOINTMENT when fingerprint code exists on any appointment', async () => {
    await prisma.hiringAppointment.create({
      data: {
        appointmentDate: new Date('2026-08-01'),
        employeeName: 'Prior Appointment',
        mobilePhone: '01022222222',
        nationalId: NID_NEW,
        jobTitle: 'Runner',
        locationId,
        fingerprintCode: '99001',
        firstWorkingDay: new Date('2026-08-02'),
        createdByUserId: hr.userId,
        status: HiringAppointmentStatus.pending,
      },
    });

    const res = await rpc(
      '/api/biotime/hiring-appointments/create',
      payload({ fingerprintCode: '99001', nationalId: NID_OTHER }),
      hr.token,
    );
    expectFail(res, 'EXISTING_APPOINTMENT');
    const existing = res.body.result?.data?.existingAppointment as Record<string, unknown>;
    expect(existing.fingerprintCode).toBe('99001');
    expect(existing.employeeName).toBe('Prior Appointment');
    expect(await prisma.hiringAppointment.count()).toBe(1);
  });

  it('creates when code and national id are unused', async () => {
    const data = expectOk(
      await rpc(
        '/api/biotime/hiring-appointments/create',
        payload({ fingerprintCode: '88001', nationalId: NID_NEW }),
        hr.token,
      ),
    );
    const appointment = data.appointment as Record<string, unknown>;
    expect(appointment.fingerprintCode).toBe('88001');
    expect(appointment.employeeProfileId).toBeFalsy();
  });
});
