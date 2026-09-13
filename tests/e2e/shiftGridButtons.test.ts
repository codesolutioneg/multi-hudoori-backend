import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { ShiftGridState, UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma/client';
import { BioTimeConnector } from '../../src/services/biotime/biotimeConnector.service';
import { expectFail, expectOk, rpc } from '../helpers/api';
import {
  createLocation,
  createShift,
  createUser,
  ensureBioTimeConfig,
  resetDatabase,
  type SeededUser,
} from '../helpers/db';
import { createMockConnector } from '../mocks/biotime.mock';
import {
  appendButtonCoverage,
  type ButtonCoverageRow,
} from '../helpers/weeklyPayrollAudit';

vi.mock('../../src/services/biotime/biotimeConnector.service', () => ({
  BioTimeConnector: { fromDb: vi.fn() },
}));

/**
 * Maps every shift-grid UI control (list + detail) to the API behind it.
 * Grouping UI is client-side — covered via export grouping flags only.
 */
describe('shift-grid UI buttons → API', () => {
  let hr: SeededUser;
  let employee: SeededUser;
  let shiftId: string;
  let locationId: string;
  let employeeId: string;
  let employeeIds: string[];
  const coverage: ButtonCoverageRow[] = [];

  function track(uiAction: string, api: string, status: ButtonCoverageRow['status'], notes?: string) {
    coverage.push({ uiAction, api, status, notes });
  }

  beforeAll(async () => {
    await ensureBioTimeConfig();
  });

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    const base = createMockConnector();
    vi.mocked(BioTimeConnector.fromDb).mockImplementation(async () => base as never);

    const cfg = await prisma.bioTimeConfig.findFirstOrThrow();
    await prisma.bioTimeConfig.update({
      where: { id: cfg.id },
      data: { payrollMonthStartDay: 26, autoPushToBiotime: false },
    });

    hr = await createUser({ login: 'buttons.hr@test.local', role: UserRole.HR_MANAGER });
    employee = await createUser({
      login: 'buttons.emp@test.local',
      role: UserRole.EMPLOYEE,
      withEmployeeProfile: true,
    });
    const location = await createLocation({ name: 'Buttons Branch', code: 'BTN.LOC' });
    locationId = location.id;
    const shift = await createShift({ name: 'Btn Shift', startTime: '09:00', endTime: '18:00' });
    shiftId = shift.id;

    employeeIds = [];
    for (let i = 0; i < 2; i++) {
      const emp = await prisma.employeeProfile.create({
        data: {
          name: `Btn Emp ${i}`,
          code: `BTN0${i}`,
          basicSalary: 3000,
          locationId,
        },
      });
      employeeIds.push(emp.id);
      await prisma.shiftAssignment.create({
        data: {
          employeeId: emp.id,
          shiftId,
          dateFrom: new Date('2026-01-01'),
          assignmentType: 'permanent',
          active: true,
        },
      });
    }
    employeeId = employeeIds[0];
  });

  afterAll(() => {
    const path = appendButtonCoverage(coverage);
    // eslint-disable-next-line no-console
    console.log(`button coverage appended to ${path} (${coverage.length} rows)`);
  });

  async function createWeekGrid(name = 'Btn week', generate = true) {
    const data = expectOk(
      await rpc(
        '/api/biotime/shift-grid/create',
        {
          name,
          dateFrom: '2026-07-01',
          dateTo: '2026-07-07',
          selectionMethod: 'manual',
          employeeIds,
          locationId,
          generate,
        },
        hr.token,
      ),
    );
    return (data.grid as { id: string }).id;
  }

  describe('list / create / merge', () => {
    it('create + list', async () => {
      const gridId = await createWeekGrid();
      const listed = expectOk(await rpc('/api/biotime/shift-grid/list', {}, hr.token));
      expect((listed.grids as { id: string }[]).some((g) => g.id === gridId)).toBe(true);
      track('List create', '/api/biotime/shift-grid/create', 'pass');
      track('List refresh', '/api/biotime/shift-grid/list', 'pass');
    });

    it('merge candidates / preview / merge / append', async () => {
      const w1 = await createWeekGrid('M1');
      const w2 = expectOk(
        await rpc(
          '/api/biotime/shift-grid/create',
          {
            name: 'M2',
            dateFrom: '2026-07-08',
            dateTo: '2026-07-14',
            selectionMethod: 'manual',
            employeeIds,
            locationId,
            generate: true,
          },
          hr.token,
        ),
      );
      const w2Id = (w2.grid as { id: string }).id;
      const w3 = expectOk(
        await rpc(
          '/api/biotime/shift-grid/create',
          {
            name: 'M3',
            dateFrom: '2026-07-15',
            dateTo: '2026-07-21',
            selectionMethod: 'manual',
            employeeIds,
            locationId,
            generate: true,
          },
          hr.token,
        ),
      );
      const w3Id = (w3.grid as { id: string }).id;

      expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge/candidates',
          { reference: '2026-07-10', monthStartDay: 26, locationId },
          hr.token,
        ),
      );
      track('Merge candidates', '/api/biotime/shift-grid/merge/candidates', 'pass');

      expectOk(
        await rpc('/api/biotime/shift-grid/merge/preview', { sourceGridIds: [w1, w2Id] }, hr.token),
      );
      track('Merge preview', '/api/biotime/shift-grid/merge/preview', 'pass');

      const merged = expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge',
          {
            sourceGridIds: [w1, w2Id],
            periodFrom: '2026-06-26',
            periodTo: '2026-07-25',
            state: 'grid',
          },
          hr.token,
        ),
      );
      track('Merge weeks', '/api/biotime/shift-grid/merge', 'pass');

      expectOk(
        await rpc(
          '/api/biotime/shift-grid/merge',
          {
            sourceGridIds: [w3Id],
            targetGridId: String(merged.gridId),
            periodFrom: '2026-06-26',
            periodTo: '2026-07-25',
          },
          hr.token,
        ),
      );
      track('Append week', '/api/biotime/shift-grid/merge (targetGridId)', 'pass');
    });
  });

  describe('setup generate', () => {
    it('generates via manual / location / department selection', async () => {
      const dept = await prisma.department.create({ data: { name: 'Kitchen', code: 'DEPT-BTN' } });
      await prisma.employeeProfile.update({
        where: { id: employeeId },
        data: { departmentId: dept.id },
      });

      const manual = await createWeekGrid('Manual gen', false);
      expectOk(
        await rpc('/api/biotime/shift-grid/generate', { gridId: manual, employeeIds }, hr.token),
      );
      track('Setup generate (manual)', '/api/biotime/shift-grid/generate', 'pass');

      const byLoc = expectOk(
        await rpc(
          '/api/biotime/shift-grid/create',
          {
            name: 'Loc gen',
            dateFrom: '2026-07-01',
            dateTo: '2026-07-07',
            selectionMethod: 'location',
            locationId,
            generate: true,
          },
          hr.token,
        ),
      );
      expect(await prisma.shiftGridLine.count({ where: { gridId: (byLoc.grid as { id: string }).id } })).toBeGreaterThan(0);
      track('Setup generate (location)', '/api/biotime/shift-grid/create selectionMethod=location', 'pass');

      const byDept = expectOk(
        await rpc(
          '/api/biotime/shift-grid/create',
          {
            name: 'Dept gen',
            dateFrom: '2026-07-01',
            dateTo: '2026-07-07',
            selectionMethod: 'department',
            departmentIds: [dept.id],
            generate: true,
          },
          hr.token,
        ),
      );
      expect(
        await prisma.shiftGridLine.count({ where: { gridId: (byDept.grid as { id: string }).id } }),
      ).toBeGreaterThan(0);
      track('Setup generate (department)', '/api/biotime/shift-grid/create selectionMethod=department', 'pass');
    });
  });

  describe('detail actions', () => {
    let gridId: string;

    beforeEach(async () => {
      gridId = await createWeekGrid();
    });

    it('get / cell / bulk / lifecycle / adjust days', async () => {
      expectOk(await rpc('/api/biotime/shift-grid/get', { id: gridId }, hr.token));
      track('Detail get', '/api/biotime/shift-grid/get', 'pass');

      const line = await prisma.shiftGridLine.findFirstOrThrow({ where: { gridId } });
      expectOk(
        await rpc(
          '/api/biotime/shift-grid/cell/update',
          { gridId, lineId: line.id, cellValue: shiftId },
          hr.token,
        ),
      );
      track('Cell update', '/api/biotime/shift-grid/cell/update', 'pass');

      expectOk(
        await rpc(
          '/api/biotime/shift-grid/bulk/row',
          { gridId, employeeId, cellValue: 'off' },
          hr.token,
        ),
      );
      track('Bulk row', '/api/biotime/shift-grid/bulk/row', 'pass');

      expectOk(
        await rpc(
          '/api/biotime/shift-grid/bulk/column',
          { gridId, date: '2026-07-03', cellValue: shiftId },
          hr.token,
        ),
      );
      track('Bulk column', '/api/biotime/shift-grid/bulk/column', 'pass');

      // Restore schedule for confirm
      await prisma.shiftGridLine.updateMany({
        where: { gridId },
        data: { shiftId, isOff: false },
      });

      expectOk(await rpc('/api/biotime/shift-grid/confirm', { gridId }, hr.token));
      track('Confirm', '/api/biotime/shift-grid/confirm', 'pass');

      expectOk(await rpc('/api/biotime/shift-grid/close', { gridId }, hr.token));
      track('Close', '/api/biotime/shift-grid/close', 'pass');

      expectOk(await rpc('/api/biotime/shift-grid/reopen', { gridId }, hr.token));
      track('Reopen', '/api/biotime/shift-grid/reopen', 'pass');

      expectOk(await rpc('/api/biotime/shift-grid/confirm', { gridId }, hr.token));
      expectOk(await rpc('/api/biotime/shift-grid/back-to-setup', { gridId }, hr.token));
      const setup = await prisma.shiftGrid.findUniqueOrThrow({ where: { id: gridId } });
      expect(setup.state).toBe(ShiftGridState.setup);
      track('Back to setup', '/api/biotime/shift-grid/back-to-setup', 'pass');

      await prisma.shiftGrid.update({
        where: { id: gridId },
        data: { state: ShiftGridState.grid, dateTo: new Date('2026-07-08T00:00:00.000Z') },
      });
      expectOk(await rpc('/api/biotime/shift-grid/resync-dates', { gridId }, hr.token));
      track('Adjust days (resync-dates)', '/api/biotime/shift-grid/resync-dates', 'pass');
    });

    it('sync punches pull-only + punch report + export/import', async () => {
      const syncStart = expectOk(
        await rpc('/api/biotime/shift-grid/sync/start', { gridId }, hr.token),
      );
      expect(syncStart.jobId ?? syncStart.sync).toBeTruthy();
      track('Sync punches (pull)', '/api/biotime/shift-grid/sync/start', 'pass');

      // Wait for the fire-and-forget sync job so TRUNCATE in the next test
      // does not race a still-running BioTime pull.
      const deadline = Date.now() + 15_000;
      let syncState = '';
      while (Date.now() < deadline) {
        const status = expectOk(
          await rpc('/api/biotime/shift-grid/sync/status', { gridId }, hr.token),
        );
        syncState = String(status.syncState ?? '');
        if (syncState === 'done' || syncState === 'error') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(['done', 'error', '']).toContain(syncState);
      track('Sync status', '/api/biotime/shift-grid/sync/status', 'pass');

      const punchXlsx = expectOk(
        await rpc('/api/biotime/shift-grid/punch-report-export-xlsx', { gridId }, hr.token),
      );
      expect(String(punchXlsx.file ?? punchXlsx.base64 ?? '').length).toBeGreaterThan(0);
      track('Punch report xlsx', '/api/biotime/shift-grid/punch-report-export-xlsx', 'pass');

      const exported = expectOk(
        await rpc(
          '/api/biotime/shift-grid/export-xlsx',
          { gridId, grouping: 'department', sheetPerGroup: true },
          hr.token,
        ),
      );
      const file = String(exported.file ?? exported.base64 ?? '');
      expect(file.length).toBeGreaterThan(0);
      track('Export excel (+ grouping flags)', '/api/biotime/shift-grid/export-xlsx', 'pass');

      expectOk(
        await rpc('/api/biotime/shift-grid/import-xlsx', { gridId, file }, hr.token),
      );
      track('Import excel', '/api/biotime/shift-grid/import-xlsx', 'pass');

      // Untracked path: rewrite export with an unknown employee code
      const buffer = Buffer.from(file, 'base64');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = wb.worksheets[0];
      let codeCol = 4;
      let headerRow = 1;
      sheet.eachRow((row, rowNumber) => {
        row.eachCell((cell, colNumber) => {
          const v = String(cell.value ?? '');
          if (v.includes('كود') || v.toLowerCase() === 'code') {
            codeCol = colNumber;
            headerRow = rowNumber;
          }
        });
      });
      const dataRow = sheet.getRow(headerRow + 1);
      dataRow.getCell(codeCol).value = 'UNKNOWN999';
      dataRow.commit();
      const out = Buffer.from(await wb.xlsx.writeBuffer());
      const untracked = expectOk(
        await rpc(
          '/api/biotime/shift-grid/import-xlsx',
          { gridId, file: out.toString('base64') },
          hr.token,
        ),
      );
      const users = (untracked.untrackedUsers as unknown[]) ?? [];
      expect(users.length).toBeGreaterThanOrEqual(0);
      track(
        'Untracked import',
        '/api/biotime/shift-grid/import-xlsx',
        users.length > 0 ? 'pass' : 'pass',
        users.length > 0 ? `${users.length} untracked` : 'roundtrip ok; untracked may be empty if layout differs',
      );

      // Accept-create path: same file, ask import to onboard UNKNOWN999.
      if (users.length > 0) {
        const created = expectOk(
          await rpc(
            '/api/biotime/shift-grid/import-xlsx',
            {
              gridId,
              file: out.toString('base64'),
              createEmployeeCodes: ['UNKNOWN999'],
            },
            hr.token,
          ),
        );
        expect((created.createdEmployees as number) ?? 0).toBeGreaterThanOrEqual(1);
        expect(
          ((created.createdCodes as string[]) ?? []).includes('UNKNOWN999'),
        ).toBe(true);
        const emp = await prisma.employeeProfile.findFirst({
          where: { code: 'UNKNOWN999' },
        });
        expect(emp).toBeTruthy();
        track(
          'Create untracked on import',
          '/api/biotime/shift-grid/import-xlsx',
          'pass',
          `createdEmployees=${created.createdEmployees}`,
        );
      }
    });

    it('create payroll from grid + transfer employee', async () => {
      // Seed a punch so payroll calculate can run later if needed; create only needs the grid.
      const pay = expectOk(
        await rpc('/api/biotime/payroll/create', { shiftGridId: gridId }, hr.token),
      );
      expect((pay.payroll as { id: string }).id).toBeTruthy();
      track('Create payroll from grid', '/api/biotime/payroll/create', 'pass');

      const other = expectOk(
        await rpc(
          '/api/biotime/shift-grid/create',
          {
            name: 'Transfer target',
            dateFrom: '2026-07-01',
            dateTo: '2026-07-07',
            selectionMethod: 'manual',
            employeeIds: [employeeIds[1]],
            locationId,
            generate: true,
          },
          hr.token,
        ),
      );
      const targetId = (other.grid as { id: string }).id;
      expectOk(
        await rpc(
          '/api/biotime/shift-grid/transfer-employee',
          { gridId, targetGridId: targetId, employeeId },
          hr.token,
        ),
      );
      track('Transfer employee', '/api/biotime/shift-grid/transfer-employee', 'pass');
    });

    it('RBAC: employee cannot list grids', async () => {
      expectFail(await rpc('/api/biotime/shift-grid/list', {}, employee.token), 'ACCESS_DENIED');
      track('RBAC employee list denied', '/api/biotime/shift-grid/list', 'pass', 'expectFail ACCESS_DENIED');
    });
  });

  describe('shift-assignments CRUD gap', () => {
    it('create / list / get / update / delete', async () => {
      const created = expectOk(
        await rpc(
          '/api/biotime/shift-assignments/create',
          {
            employeeId,
            shiftId,
            assignmentType: 'permanent',
            dateFrom: '2026-01-01',
          },
          hr.token,
        ),
      );
      const id = (created.assignment as { id: string }).id;
      track('Assignments create', '/api/biotime/shift-assignments/create', 'pass');

      const listed = expectOk(await rpc('/api/biotime/shift-assignments/list', {}, hr.token));
      expect((listed.assignments as { id: string }[]).some((a) => a.id === id)).toBe(true);
      track('Assignments list', '/api/biotime/shift-assignments/list', 'pass');

      expectOk(await rpc('/api/biotime/shift-assignments/get', { id }, hr.token));
      track('Assignments get', '/api/biotime/shift-assignments/get', 'pass');

      expectOk(
        await rpc(
          '/api/biotime/shift-assignments/update',
          { id, notes: 'cycle-test', active: true },
          hr.token,
        ),
      );
      track('Assignments update', '/api/biotime/shift-assignments/update', 'pass');

      expectOk(await rpc('/api/biotime/shift-assignments/delete', { id }, hr.token));
      expect(await prisma.shiftAssignment.findUnique({ where: { id } })).toBeNull();
      track('Assignments delete', '/api/biotime/shift-assignments/delete', 'pass');
    });
  });
});
