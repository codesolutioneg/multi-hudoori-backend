import { describe, it, expect, beforeEach } from 'vitest';
import { RequestState, UserRole } from '@prisma/client';
import { prismaBase } from '../../src/prisma/client';
import { expectFail, expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createUser,
  ensureBioTimeConfig,
  ensureDefaultCompany,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';

/**
 * Coverage for previously under-tested biotime REST routes (CRUD / list / smoke).
 * Skips BioTime/Odoo outbound sync and heavy xlsx import flows.
 */
describe('rest routes coverage (remaining)', () => {
  let hr: SeededUser;
  let companyId: string;
  let locationId: string;

  beforeEach(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    companyId = await ensureDefaultCompany();
    const loc = await createLocation({ name: 'Main', code: 'MAIN' });
    locationId = loc.id;
    hr = await createUser({
      login: 'hr@co.test',
      role: UserRole.HR_MANAGER,
      companyId,
    });
  });

  describe('master data CRUD', () => {
    it('archive-reasons create/list/update/delete', async () => {
      const created = expectOk(
        await rpc('/api/biotime/archive-reasons/create', { name: 'استقالة', sequence: 1 }, hr.token),
      );
      const id = (created.reason as { id: string }).id;

      const list = expectOk(await rpc('/api/biotime/archive-reasons/list', { activeOnly: false }, hr.token));
      expect((list.reasons as unknown[]).length).toBeGreaterThanOrEqual(1);

      expectOk(
        await rpc('/api/biotime/archive-reasons/update', { id, name: 'إنهاء خدمة' }, hr.token),
      );
      expectOk(await rpc('/api/biotime/archive-reasons/delete', { id }, hr.token));
      expectFail(
        await rpc('/api/biotime/archive-reasons/create', { name: '' }, hr.token),
        'VALIDATION',
      );
    });

    it('custody-types create/list/update/delete', async () => {
      const created = expectOk(
        await rpc(
          '/api/biotime/custody-types/create',
          { name: 'زي', code: 'UNI' },
          hr.token,
        ),
      );
      const id = (created.type as { id: string }).id;
      expectOk(await rpc('/api/biotime/custody-types/list', {}, hr.token));
      expectOk(
        await rpc('/api/biotime/custody-types/update', { id, name: 'زي رسمي' }, hr.token),
      );
      expectOk(await rpc('/api/biotime/custody-types/delete', { id }, hr.token));
    });

    it('insurance-companies create/list/update/delete', async () => {
      const created = expectOk(
        await rpc(
          '/api/biotime/insurance-companies/create',
          { name: 'مصر للتأمين', code: 'MISR' },
          hr.token,
        ),
      );
      const id = (created.company as { id: string }).id;
      expectOk(await rpc('/api/biotime/insurance-companies/list', {}, hr.token));
      expectOk(
        await rpc('/api/biotime/insurance-companies/update', { id, name: 'مصر' }, hr.token),
      );
      expectOk(await rpc('/api/biotime/insurance-companies/delete', { id }, hr.token));
    });

    it('job-titles create/list/update/sync/delete', async () => {
      await prismaBase.employeeProfile.create({
        data: {
          companyId,
          name: 'Waiter Emp',
          code: 'W1',
          locationId,
          jobTitle: 'ويتر',
        },
      });

      const created = expectOk(
        await rpc('/api/biotime/job-titles/create', { name: 'كاشير', code: 'CASH' }, hr.token),
      );
      const id = (created.title as { id: string }).id;
      expectOk(await rpc('/api/biotime/job-titles/list', {}, hr.token));
      expectOk(await rpc('/api/biotime/job-titles/update', { id, name: 'كاشير رئيسي' }, hr.token));
      const synced = expectOk(
        await rpc('/api/biotime/job-titles/sync-from-employees', {}, hr.token),
      );
      expect(typeof synced.created).toBe('number');
      expectOk(await rpc('/api/biotime/job-titles/delete', { id }, hr.token));
    });

    it('departments create/list/update/delete', async () => {
      const created = expectOk(
        await rpc('/api/biotime/departments/create', { name: 'المطبخ', code: 'KIT' }, hr.token),
      );
      const id = (created.department as { id: string }).id;
      expectOk(await rpc('/api/biotime/departments/list', {}, hr.token));
      expectOk(
        await rpc('/api/biotime/departments/update', { id, name: 'مطبخ ساخن' }, hr.token),
      );
      expectOk(await rpc('/api/biotime/departments/delete', { id }, hr.token));
    });

    it('locations create/list/update', async () => {
      const created = expectOk(
        await rpc(
          '/api/biotime/locations/create',
          { name: 'فرع 2', code: 'BR2', sequence: 20 },
          hr.token,
        ),
      );
      const id = (created.location as { id: string }).id;
      const list = expectOk(await rpc('/api/biotime/locations/list', {}, hr.token));
      expect((list.locations as unknown[]).length).toBeGreaterThanOrEqual(2);
      expectOk(
        await rpc('/api/biotime/locations/update', { id, name: 'فرع اثنان' }, hr.token),
      );
    });
  });

  describe('shifts + assignments', () => {
    it('shifts create/get/list/update/delete', async () => {
      const created = expectOk(
        await rpc(
          '/api/biotime/shifts/create',
          {
            name: 'صباحي',
            code: 'AM1',
            startTime: '08:00',
            endTime: '16:00',
            gracePeriodIn: 10,
            gracePeriodOut: 10,
          },
          hr.token,
        ),
      );
      const id = (created.shift as { id: string }).id;
      expectOk(await rpc('/api/biotime/shifts/get', { id }, hr.token));
      expectOk(await rpc('/api/biotime/shifts/list', {}, hr.token));
      expectOk(
        await rpc('/api/biotime/shifts/update', { id, name: 'صباحي معدل' }, hr.token),
      );
      expectOk(await rpc('/api/biotime/shifts/delete', { id }, hr.token));
    });

    it('shift-assignments create/get/list/update/delete', async () => {
      const emp = await prismaBase.employeeProfile.create({
        data: { companyId, name: 'Assign Me', code: 'A100', locationId },
      });
      const shift = expectOk(
        await rpc(
          '/api/biotime/shifts/create',
          {
            name: 'مسائي',
            code: 'PM1',
            startTime: '16:00',
            endTime: '00:00',
            isOvernight: true,
          },
          hr.token,
        ),
      );
      const shiftId = (shift.shift as { id: string }).id;

      const created = expectOk(
        await rpc(
          '/api/biotime/shift-assignments/create',
          {
            employeeId: emp.id,
            shiftId,
            assignmentType: 'permanent',
            dateFrom: '2026-09-01',
          },
          hr.token,
        ),
      );
      const id = (created.assignment as { id: string }).id;
      expectOk(await rpc('/api/biotime/shift-assignments/get', { id }, hr.token));
      expectOk(await rpc('/api/biotime/shift-assignments/list', {}, hr.token));
      expectOk(
        await rpc(
          '/api/biotime/shift-assignments/update',
          { id, notes: 'updated' },
          hr.token,
        ),
      );
      expectOk(await rpc('/api/biotime/shift-assignments/delete', { id }, hr.token));
    });
  });

  describe('devices + jobs + odoo read', () => {
    it('devices list + update location link', async () => {
      const device = await prismaBase.device.create({
        data: {
          companyId,
          name: 'Terminal 1',
          serialNumber: 'SN-1',
          active: true,
        },
      });
      const list = expectOk(await rpc('/api/biotime/devices/list', {}, hr.token));
      expect((list.devices as unknown[]).length).toBe(1);
      expectOk(
        await rpc(
          '/api/biotime/devices/update',
          { id: device.id, locationId },
          hr.token,
        ),
      );
      const linked = await prismaBase.device.findUnique({ where: { id: device.id } });
      expect(linked?.locationId).toBe(locationId);
    });

    it('jobs/status and odoo config/get + push-status smoke', async () => {
      const job = await prismaBase.syncJob.create({
        data: {
          companyId,
          jobType: 'attendance_generate',
          status: 'done',
          message: 'ok',
          progress: 100,
        },
      });
      expectOk(await rpc('/api/biotime/jobs/status', { jobId: job.id }, hr.token));
      expectFail(await rpc('/api/biotime/jobs/status', { jobId: 'missing' }, hr.token), 'NOT_FOUND');
      expectOk(await rpc('/api/biotime/odoo/config/get', {}, hr.token));
      expectOk(await rpc('/api/biotime/odoo/push-status', {}, hr.token));
    });
  });

  describe('dashboard / absences / attendance / leave-summary', () => {
    it('notifications read-all, absences list/read, attendance list', async () => {
      expectOk(await rpc('/api/biotime/dashboard/notifications', {}, hr.token));
      expectOk(await rpc('/api/biotime/dashboard/notifications/read-all', {}, hr.token));
      expectOk(await rpc('/api/biotime/absences/list', {}, hr.token));
      expectOk(await rpc('/api/biotime/absences/read', {}, hr.token));
      expectOk(
        await rpc(
          '/api/biotime/attendance/list',
          { dateFrom: '2026-09-01', dateTo: '2026-09-07' },
          hr.token,
        ),
      );
    });

    it('employees/leave-summary returns data for employee', async () => {
      const emp = await prismaBase.employeeProfile.create({
        data: { companyId, name: 'Leave Emp', code: 'L1', locationId },
      });
      const data = expectOk(
        await rpc('/api/biotime/employees/leave-summary', { employeeId: emp.id }, hr.token),
      );
      expect(data).toHaveProperty('leaveSummary');
    });
  });

  describe('overtime list/approve/reject', () => {
    it('lists, approves, and rejects overtime rows', async () => {
      const emp = await prismaBase.employeeProfile.create({
        data: { companyId, name: 'OT Emp', code: 'OT1', locationId },
      });
      const approveRow = await prismaBase.overtimeAnalysis.create({
        data: {
          companyId,
          employeeId: emp.id,
          date: new Date('2026-09-01'),
          overtimeHours: 2,
          state: RequestState.pending,
        },
      });
      const rejectRow = await prismaBase.overtimeAnalysis.create({
        data: {
          companyId,
          employeeId: emp.id,
          date: new Date('2026-09-02'),
          overtimeHours: 1,
          state: RequestState.pending,
        },
      });

      const list = expectOk(await rpc('/api/biotime/overtime/list', {}, hr.token));
      expect((list.items as unknown[]).length).toBeGreaterThanOrEqual(2);

      expectOk(await rpc('/api/biotime/overtime/approve', { id: approveRow.id }, hr.token));
      expectOk(
        await rpc(
          '/api/biotime/overtime/reject',
          { id: rejectRow.id, reason: 'غير مستحق' },
          hr.token,
        ),
      );
    });
  });

  describe('requests shift-change', () => {
    it('blocks employee create (READ_ONLY); HR can reject/approve seeded requests', async () => {
      const empUser = await createUser({
        login: 'emp@co.test',
        role: UserRole.EMPLOYEE,
        companyId,
        locationId,
        withEmployeeProfile: true,
        employee: { code: 'E90', name: 'Emp Ninety', locationId },
      });

      const shiftA = expectOk(
        await rpc(
          '/api/biotime/shifts/create',
          { name: 'A', code: 'SA', startTime: '08:00', endTime: '16:00' },
          hr.token,
        ),
      );
      const shiftB = expectOk(
        await rpc(
          '/api/biotime/shifts/create',
          { name: 'B', code: 'SB', startTime: '16:00', endTime: '00:00', isOvernight: true },
          hr.token,
        ),
      );
      const aId = (shiftA.shift as { id: string }).id;
      const bId = (shiftB.shift as { id: string }).id;

      expectFail(
        await rpc(
          '/api/biotime/requests/shift-change/create',
          {
            newShiftId: bId,
            currentShiftId: aId,
            dateFrom: '2026-09-10',
            dateTo: '2026-09-12',
            reason: 'تبادل',
          },
          empUser.token,
        ),
        'READ_ONLY',
      );

      const rejectReq = await prismaBase.shiftChangeRequest.create({
        data: {
          companyId,
          employeeId: empUser.employeeId!,
          currentShiftId: aId,
          newShiftId: bId,
          dateFrom: new Date('2026-09-10'),
          dateTo: new Date('2026-09-12'),
          reason: 'تبادل',
          state: RequestState.pending,
        },
      });
      expectOk(
        await rpc(
          '/api/biotime/requests/shift-change/reject',
          { id: rejectReq.id, reason: 'مرفوض' },
          hr.token,
        ),
      );

      const approveReq = await prismaBase.shiftChangeRequest.create({
        data: {
          companyId,
          employeeId: empUser.employeeId!,
          newShiftId: aId,
          dateFrom: new Date('2026-09-20'),
          dateTo: new Date('2026-09-21'),
          reason: 'طلب ثان',
          state: RequestState.pending,
        },
      });
      expectOk(
        await rpc('/api/biotime/requests/shift-change/approve', { id: approveReq.id }, hr.token),
      );
      expectOk(await rpc('/api/biotime/requests/pending', {}, hr.token));
    });
  });

  describe('hr reports smoke (remaining)', () => {
    it('employee-emails, employee-movements, health-certificates export', async () => {
      await prismaBase.employeeProfile.create({
        data: { companyId, name: 'Report Emp', code: 'R1', locationId },
      });
      expectOk(await rpc('/api/biotime/reports/employee-emails', {}, hr.token));
      expectOk(await rpc('/api/biotime/reports/employee-emails/export-xlsx', {}, hr.token));
      expectOk(
        await rpc(
          '/api/biotime/reports/employee-movements',
          { dateFrom: '2026-01-01', dateTo: '2026-12-31' },
          hr.token,
        ),
      );
      expectOk(
        await rpc(
          '/api/biotime/reports/employee-movements/export-xlsx',
          { dateFrom: '2026-01-01', dateTo: '2026-12-31' },
          hr.token,
        ),
      );
      expectOk(await rpc('/api/biotime/reports/health-certificates', {}, hr.token));
      expectOk(
        await rpc('/api/biotime/reports/health-certificates/export-xlsx', {}, hr.token),
      );
      expectOk(
        await rpc(
          '/api/biotime/reports/no-punches/export-xlsx',
          { dateFrom: '2026-09-01', dateTo: '2026-09-07', locationId },
          hr.token,
        ),
      );
      expectOk(
        await rpc(
          '/api/biotime/reports/punch-summary/export-xlsx',
          { dateFrom: '2026-09-01', dateTo: '2026-09-07', locationId },
          hr.token,
        ),
      );
      expectOk(
        await rpc(
          '/api/biotime/reports/location-mismatch/export-xlsx',
          { dateFrom: '2026-09-01', dateTo: '2026-09-07', locationId },
          hr.token,
        ),
      );
    });
  });

  describe('WORK_STATE flow smoke (tenant-safe writes)', () => {
    it('creates job level, shift grid, payroll, and hiring appointment', async () => {
      const emp = await prismaBase.employeeProfile.create({
        data: {
          companyId,
          name: 'Flow Emp',
          code: 'FLOW1',
          locationId,
          basicSalary: 4000,
        },
      });

      const level = expectOk(
        await rpc(
          '/api/biotime/job-levels/create',
          { name: 'طاقم', code: 'staff' },
          hr.token,
        ),
      );
      const levels = (level.levels as Array<{ name: string }>) ?? [];
      expect(levels.some((l) => l.name === 'طاقم')).toBe(true);

      const grid = expectOk(
        await rpc(
          '/api/biotime/shift-grid/create',
          {
            name: 'Week A',
            locationId,
            dateFrom: '2026-09-01',
            dateTo: '2026-09-07',
            selectionMethod: 'location',
            employeeIds: [emp.id],
          },
          hr.token,
        ),
      );
      const gridId = (grid.grid as { id: string }).id;

      const payroll = expectOk(
        await rpc(
          '/api/biotime/payroll/create',
          {
            name: 'Sep cycle',
            dateFrom: '2026-08-26',
            dateTo: '2026-09-25',
            shiftGridId: gridId,
          },
          hr.token,
        ),
      );
      expect((payroll.payroll as { id: string }).id).toBeTruthy();

      const calc = expectOk(
        await rpc(
          '/api/biotime/payroll/calculate',
          { id: (payroll.payroll as { id: string }).id },
          hr.token,
        ),
      );
      expect(calc.payroll || calc).toBeTruthy();

      const hiring = expectOk(
        await rpc(
          '/api/biotime/hiring-appointments/create',
          {
            employeeName: 'New Hire',
            fingerprintCode: 'NH100',
            jobTitle: 'Waiter',
            locationId,
            mobilePhone: '01000000001',
            appointmentDate: '2026-09-20',
            firstWorkingDay: '2026-09-21',
            skipNationalId: true,
          },
          hr.token,
        ),
      );
      expect((hiring.appointment as { id?: string }).id).toBeTruthy();

      // Short advance may be NOT_ELIGIBLE without punches — still must not 500.
      const adv = await rpc(
        '/api/biotime/advances/short/create',
        { employeeId: emp.id, amount: 100, reason: 'test' },
        hr.token,
      );
      expect(adv.status).toBe(200);
      expect(adv.body.result?.error_code === 'SERVER_ERROR').toBe(false);
    });

    it('keeps companies isolated on shift-grid and payroll lists', async () => {
      const other = await prismaBase.company.create({
        data: { code: 'otherflow', name: 'Other Flow', active: true },
      });
      const otherLoc = await prismaBase.location.create({
        data: { companyId: other.id, name: 'Other Loc', code: 'OL1' },
      });
      await prismaBase.shiftGrid.create({
        data: {
          companyId: other.id,
          name: 'Secret Grid',
          dateFrom: new Date('2026-09-01'),
          dateTo: new Date('2026-09-07'),
          locationId: otherLoc.id,
          gridLocation: 'Other Loc',
          selectionMethod: 'location',
        },
      });
      await prismaBase.payroll.create({
        data: {
          companyId: other.id,
          name: 'Secret Pay',
          dateFrom: new Date('2026-08-26'),
          dateTo: new Date('2026-09-25'),
        },
      });

      const grids = expectOk(await rpc('/api/biotime/shift-grid/list', {}, hr.token));
      const payrolls = expectOk(await rpc('/api/biotime/payroll/list', {}, hr.token));
      const gridNames = ((grids.grids as Array<{ name?: string }>) ?? []).map((g) => g.name);
      const payNames = ((payrolls.payrolls as Array<{ name?: string }>) ?? []).map((p) => p.name);
      expect(gridNames).not.toContain('Secret Grid');
      expect(payNames).not.toContain('Secret Pay');
    });
  });
});
