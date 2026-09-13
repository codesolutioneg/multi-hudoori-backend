import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { UserRole } from '@prisma/client';
import { expectOk, rpc } from '../helpers/api';
import { createShift, createUser, ensureBioTimeConfig, resetDatabase, type SeededUser } from '../helpers/db';
import { prisma } from '../../src/prisma/client';

const VALID_NID = '29001010101015';

async function loadSheets(base64: string): Promise<Map<string, string[][]>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(base64, 'base64') as unknown as ArrayBuffer);
  const sheets = new Map<string, string[][]>();
  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(String(cell.value ?? '')));
      rows.push(cells);
    });
    sheets.set(sheet.name, rows);
  });
  return sheets;
}

function flatten(rows: string[][]): string {
  return rows.map((r) => r.join('|')).join('\n');
}

describe('HR compliance reports', () => {
  let hr: SeededUser;

  beforeAll(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    hr = await createUser({ role: UserRole.HR_MANAGER, login: 'reports.hr@test.bio' });
  });

  describe('no-punch report', () => {
    beforeEach(async () => {
      await prisma.transaction.deleteMany();
      await prisma.shiftGridLine.deleteMany();
      await prisma.shiftGrid.deleteMany();
      await prisma.employeeProfile.deleteMany();
    });

    it('lists an employee with data but no punches, and excludes one who punched', async () => {
      const silent = await prisma.employeeProfile.create({
        data: { name: 'Never Punched', code: 'NP001', nationalIdConfirm: VALID_NID },
      });
      const active = await prisma.employeeProfile.create({
        data: { name: 'Did Punch', code: 'NP002', nationalIdConfirm: VALID_NID },
      });
      await prisma.transaction.create({
        data: {
          employeeId: active.id,
          empCode: 'NP002',
          biotimeTransactionId: 700001,
          punchTime: new Date('2026-06-03T05:00:00.000Z'),
          punchState: '0',
        },
      });

      const data = expectOk(
        await rpc(
          '/api/biotime/reports/no-punches',
          { dateFrom: '2026-06-01', dateTo: '2026-06-07' },
          hr.token,
        ),
      );
      const rows = data.rows as { employeeId: string; isBareCode: boolean }[];
      expect(rows.map((r) => r.employeeId)).toEqual([silent.id]);
      expect(rows[0].isBareCode).toBe(true);
    });

    it('matches punches that carry only a code and no employee link', async () => {
      await prisma.employeeProfile.create({
        data: { name: 'Code Only Punch', code: 'NP003', nationalIdConfirm: VALID_NID },
      });
      await prisma.transaction.create({
        data: {
          empCode: 'NP003',
          biotimeTransactionId: 700002,
          punchTime: new Date('2026-06-03T05:00:00.000Z'),
          punchState: '0',
        },
      });

      const data = expectOk(
        await rpc(
          '/api/biotime/reports/no-punches',
          { dateFrom: '2026-06-01', dateTo: '2026-06-07' },
          hr.token,
        ),
      );
      expect(data.count).toBe(0);
    });

    it('ignores punches outside the requested period', async () => {
      const emp = await prisma.employeeProfile.create({
        data: { name: 'Punched In May', code: 'NP004', nationalIdConfirm: VALID_NID },
      });
      await prisma.transaction.create({
        data: {
          employeeId: emp.id,
          empCode: 'NP004',
          biotimeTransactionId: 700003,
          punchTime: new Date('2026-05-03T05:00:00.000Z'),
          punchState: '0',
        },
      });

      const data = expectOk(
        await rpc(
          '/api/biotime/reports/no-punches',
          { dateFrom: '2026-06-01', dateTo: '2026-06-07' },
          hr.token,
        ),
      );
      expect(data.count).toBe(1);
    });

    it('can exclude bare codes that never had a schedule', async () => {
      const shift = await createShift();
      const scheduled = await prisma.employeeProfile.create({
        data: { name: 'Scheduled Silent', code: 'NP005', nationalIdConfirm: VALID_NID },
      });
      await prisma.employeeProfile.create({
        data: { name: 'Bare Code', code: 'NP006', nationalIdConfirm: VALID_NID },
      });
      const grid = await prisma.shiftGrid.create({
        data: { name: 'g', dateFrom: new Date('2026-06-01'), dateTo: new Date('2026-06-07') },
      });
      await prisma.shiftGridLine.create({
        data: {
          gridId: grid.id,
          employeeId: scheduled.id,
          date: new Date('2026-06-01T00:00:00.000Z'),
          shiftId: shift.id,
        },
      });

      const withBare = expectOk(
        await rpc(
          '/api/biotime/reports/no-punches',
          { dateFrom: '2026-06-01', dateTo: '2026-06-07' },
          hr.token,
        ),
      );
      expect(withBare.count).toBe(2);

      const withoutBare = expectOk(
        await rpc(
          '/api/biotime/reports/no-punches',
          { dateFrom: '2026-06-01', dateTo: '2026-06-07', includeNeverScheduled: false },
          hr.token,
        ),
      );
      const rows = withoutBare.rows as { employeeId: string }[];
      expect(rows.map((r) => r.employeeId)).toEqual([scheduled.id]);
    });

    it('excludes archived employees unless asked for', async () => {
      await prisma.employeeProfile.create({
        data: {
          name: 'Archived Silent',
          code: 'NP007',
          nationalIdConfirm: VALID_NID,
          archivedAt: new Date('2026-05-01'),
        },
      });

      const normal = expectOk(
        await rpc(
          '/api/biotime/reports/no-punches',
          { dateFrom: '2026-06-01', dateTo: '2026-06-07' },
          hr.token,
        ),
      );
      expect(normal.count).toBe(0);

      const including = expectOk(
        await rpc(
          '/api/biotime/reports/no-punches',
          { dateFrom: '2026-06-01', dateTo: '2026-06-07', includeArchived: true },
          hr.token,
        ),
      );
      expect(including.count).toBe(1);
    });

    it('rejects a missing period', async () => {
      const res = await rpc('/api/biotime/reports/no-punches', {}, hr.token);
      expect(res.body.result?.success).toBe(false);
    });
  });

  describe('national ID gate', () => {
    beforeEach(async () => {
      await prisma.employeeProfile.deleteMany();
      await prisma.employeeProfile.create({
        data: { name: 'With NID', code: 'G001', nationalIdConfirm: VALID_NID },
      });
      await prisma.employeeProfile.create({ data: { name: 'No NID', code: 'G002' } });
      // An empty string must be treated as absent, not as a value.
      await prisma.employeeProfile.create({
        data: { name: 'Blank NID', code: 'G003', nationalIdConfirm: '' },
      });
    });

    it('includes everyone when the gate is off', async () => {
      const data = expectOk(await rpc('/api/biotime/reports/fawry', {}, hr.token));
      expect(data.count).toBe(3);
    });

    it('drops missing and blank national IDs when the gate is on', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/fawry', { requireNationalId: true }, hr.token),
      );
      const rows = data.rows as { name: string }[];
      expect(rows.map((r) => r.name)).toEqual(['With NID']);
    });
  });

  describe('fawry report', () => {
    beforeEach(async () => {
      await prisma.employeeProfile.deleteMany();
      await prisma.employeeProfile.createMany({
        data: [
          { name: 'Has Card', code: 'F001', hasFawryAccount: true, fawryAccount: '01000000001' },
          {
            name: 'Flag No Number',
            code: 'F002',
            hasFawryAccount: true,
            fawryAccount: '',
            workPhone: '01000000002',
          },
          { name: 'Number No Flag', code: 'F003', hasFawryAccount: false, fawryAccount: '01000000003' },
          { name: 'Nothing', code: 'F004', hasFawryAccount: false },
        ],
      });
    });

    it('classifies a ticked flag with no number as a data error', async () => {
      const data = expectOk(await rpc('/api/biotime/reports/fawry', {}, hr.token));
      const byName = new Map(
        (data.rows as { name: string; status: string }[]).map((r) => [r.name, r.status]),
      );
      expect(byName.get('Has Card')).toBe('complete');
      expect(byName.get('Flag No Number')).toBe('missing_number');
      expect(byName.get('Number No Flag')).toBe('number_without_flag');
      expect(byName.get('Nothing')).toBe('none');
    });

    it('filters to data errors only', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/fawry', { filter: 'data_errors' }, hr.token),
      );
      const names = (data.rows as { name: string }[]).map((r) => r.name).sort();
      expect(names).toEqual(['Flag No Number', 'Number No Flag']);
    });

    it('counts a flag without a number as not covered', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/fawry', { filter: 'without_card' }, hr.token),
      );
      const names = (data.rows as { name: string }[]).map((r) => r.name).sort();
      expect(names).toEqual(['Flag No Number', 'Nothing']);
    });

    it('exports a workbook showing the number beside the flag', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/fawry/export-xlsx', {}, hr.token),
      );
      const sheets = await loadSheets(String(data.file));
      const text = flatten(sheets.get('كروت فوري')!);
      expect(text).toContain('01000000001');
      expect(text).toContain('العلامة موضوعة والرقم فارغ');
    });

    it('falls back to the work phone so the number column is never blank', async () => {
      const data = expectOk(await rpc('/api/biotime/reports/fawry', {}, hr.token));
      const byName = new Map(
        (
          data.rows as {
            name: string;
            fawryNumber: string;
            numberSource: string;
            numberSourceLabel: string;
          }[]
        ).map((r) => [r.name, r]),
      );

      // Stored Fawry number wins.
      expect(byName.get('Has Card')).toMatchObject({
        fawryNumber: '01000000001',
        numberSource: 'fawry',
        numberSourceLabel: 'رقم فوري مسجّل',
      });
      // No stored number: show the work phone, and say where it came from.
      expect(byName.get('Flag No Number')).toMatchObject({
        fawryNumber: '01000000002',
        numberSource: 'work_phone',
        numberSourceLabel: 'تليفون العمل',
      });
      // Nothing at all is still reported as nothing, not as a blank cell.
      expect(byName.get('Nothing')).toMatchObject({
        fawryNumber: '',
        numberSource: 'none',
        numberSourceLabel: 'لا يوجد رقم',
      });
    });

    it('falls back to the BioTime mapping mobile as a last resort', async () => {
      const emp = await prisma.employeeProfile.create({
        data: { name: 'Mapping Only', code: 'F006', hasFawryAccount: true, fawryAccount: '' },
      });
      await prisma.employeeMapping.create({
        data: { employeeId: emp.id, biotimeEmpCode: 'F006', mobile: '01300000006' },
      });
      const data = expectOk(await rpc('/api/biotime/reports/fawry', {}, hr.token));
      const row = (data.rows as { name: string; fawryNumber: string; numberSource: string }[]).find(
        (r) => r.name === 'Mapping Only',
      );
      expect(row).toMatchObject({ fawryNumber: '01300000006', numberSource: 'biotime_mobile' });
    });

    it('falls back to the mobile phone when there is no work phone', async () => {
      await prisma.employeeProfile.create({
        data: {
          name: 'Mobile Only',
          code: 'F005',
          hasFawryAccount: true,
          fawryAccount: '',
          mobilePhone: '01200000005',
        },
      });
      const data = expectOk(await rpc('/api/biotime/reports/fawry', {}, hr.token));
      const row = (data.rows as { name: string; fawryNumber: string; numberSource: string }[]).find(
        (r) => r.name === 'Mobile Only',
      );
      expect(row).toMatchObject({ fawryNumber: '01200000005', numberSource: 'mobile_phone' });
    });

    it('keeps flagging a missing stored number even though a phone is shown', async () => {
      // The fallback must not quietly turn bad data into "covered".
      const data = expectOk(
        await rpc('/api/biotime/reports/fawry', { filter: 'data_errors' }, hr.token),
      );
      const names = (data.rows as { name: string }[]).map((r) => r.name).sort();
      expect(names).toEqual(['Flag No Number', 'Number No Flag']);

      const without = expectOk(
        await rpc('/api/biotime/reports/fawry', { filter: 'without_card' }, hr.token),
      );
      expect((without.rows as { name: string }[]).map((r) => r.name).sort()).toEqual([
        'Flag No Number',
        'Nothing',
      ]);
    });

    it('writes the number source column into the workbook', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/fawry/export-xlsx', {}, hr.token),
      );
      const sheets = await loadSheets(String(data.file));
      const rows = sheets.get('كروت فوري')!;
      const header = rows.find((r) => r.includes('رقم فوري'))!;
      const sourceCol = header.indexOf('مصدر الرقم');
      expect(sourceCol).toBe(header.indexOf('رقم فوري') + 1);

      const body = rows.slice(rows.indexOf(header) + 1);
      const fallback = body.find((r) => r.includes('Flag No Number'))!;
      expect(fallback[header.indexOf('رقم فوري')]).toBe('01000000002');
      expect(fallback[sourceCol]).toBe('تليفون العمل');
      expect(fallback).toHaveLength(header.length);
    });
  });

  describe('insurance report', () => {
    beforeEach(async () => {
      await prisma.employeeProfile.deleteMany();
      await prisma.insuranceCompany.deleteMany();
      const social = await prisma.insuranceCompany.create({
        data: { name: 'التأمينات الاجتماعية', code: 'INS-S' },
      });
      const medical = await prisma.insuranceCompany.create({
        data: { name: 'ميدي كير', code: 'INS-M' },
      });
      await prisma.employeeProfile.create({
        data: {
          name: 'Fully Insured',
          code: 'I001',
          insuranceCompanyId: social.id,
          insuranceSalary: 4500,
          insuranceNumber: 'S-1',
          medicalInsuranceCompanyId: medical.id,
          medicalInsuranceSalary: 800,
        },
      });
      await prisma.employeeProfile.create({ data: { name: 'Uninsured', code: 'I002' } });
    });

    it('separates social and medical into their own sheets', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/insurance/export-xlsx', { kind: 'both' }, hr.token),
      );
      const sheets = await loadSheets(String(data.file));
      expect([...sheets.keys()]).toEqual(['التأمين الاجتماعي', 'التأمين الطبي']);
    });

    it('writes only the requested kind', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/insurance/export-xlsx', { kind: 'medical' }, hr.token),
      );
      const sheets = await loadSheets(String(data.file));
      expect([...sheets.keys()]).toEqual(['التأمين الطبي']);
    });

    it('reports the company and the insured salary, which the employees export omitted', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/insurance', { kind: 'social' }, hr.token),
      );
      const rows = data.social as { name: string; companyName: string; insuredSalary: number }[];
      const insured = rows.find((r) => r.name === 'Fully Insured')!;
      expect(insured.companyName).toBe('التأمينات الاجتماعية');
      expect(insured.insuredSalary).toBe(4500);
    });

    it('filters to uninsured only', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/reports/insurance',
          { kind: 'social', filter: 'not_insured' },
          hr.token,
        ),
      );
      const rows = data.social as { name: string }[];
      expect(rows.map((r) => r.name)).toEqual(['Uninsured']);
    });
  });

  describe('documents report', () => {
    beforeEach(async () => {
      await prisma.employeeProfile.deleteMany();
      await prisma.employeeProfile.create({
        data: {
          name: 'Complete Papers',
          code: 'D001',
          qualificationDocStatus: 'original',
          birthCertificateDocStatus: 'original',
          militaryDocStatus: 'original',
          criminalRecord: true,
          idCardPhoto: true,
          personalPhoto: true,
          insurancePrint: true,
          workStub: true,
          healthCertificate: true,
        },
      });
      await prisma.employeeProfile.create({
        data: {
          name: 'Missing Criminal Record',
          code: 'D002',
          qualificationDocStatus: 'original',
          birthCertificateDocStatus: 'original',
          militaryDocStatus: 'original',
          criminalRecord: false,
          idCardPhoto: true,
          personalPhoto: true,
          insurancePrint: true,
          workStub: true,
          healthCertificate: true,
        },
      });
      await prisma.employeeProfile.create({
        data: { name: 'Copy Only Qualification', code: 'D003', qualificationDocStatus: 'copy' },
      });
    });

    it('judges completeness against only the selected documents', async () => {
      const onlyCriminal = expectOk(
        await rpc(
          '/api/biotime/reports/documents',
          { requiredDocuments: ['criminal_record'], filter: 'incomplete' },
          hr.token,
        ),
      );
      const names = (onlyCriminal.rows as { name: string }[]).map((r) => r.name).sort();
      expect(names).toEqual(['Copy Only Qualification', 'Missing Criminal Record']);

      const onlyQualification = expectOk(
        await rpc(
          '/api/biotime/reports/documents',
          { requiredDocuments: ['qualification'], filter: 'incomplete' },
          hr.token,
        ),
      );
      // Both papered employees hold the qualification, so only nobody is missing it.
      expect((onlyQualification.rows as unknown[]).length).toBe(0);
    });

    it('treats a copy as missing when copies are not accepted', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/reports/documents',
          { requiredDocuments: ['qualification'], filter: 'incomplete', acceptCopies: false },
          hr.token,
        ),
      );
      const names = (data.rows as { name: string }[]).map((r) => r.name);
      expect(names).toEqual(['Copy Only Qualification']);
    });

    it('requires every document when nothing is selected', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/documents', { filter: 'incomplete' }, hr.token),
      );
      const names = (data.rows as { name: string }[]).map((r) => r.name).sort();
      expect(names).toEqual(['Copy Only Qualification', 'Missing Criminal Record']);
    });

    it('names the missing documents and only columns the selected ones', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/reports/documents/export-xlsx',
          { requiredDocuments: ['criminal_record', 'health_certificate'], filter: 'incomplete' },
          hr.token,
        ),
      );
      const sheets = await loadSheets(String(data.file));
      const rows = sheets.get('نواقص الأوراق')!;
      const text = flatten(rows);
      expect(text).toContain('الفيش الجنائي');
      // Not selected, so it must not appear as a column.
      expect(text).not.toContain('المؤهل');
    });
  });

  describe('health certificate report', () => {
    beforeEach(async () => {
      await prisma.employeeProfile.deleteMany();
      const today = new Date();
      const inDays = (n: number) =>
        new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + n));
      await prisma.employeeProfile.create({
        data: {
          name: 'Expired Cert',
          code: 'H001',
          healthCertificate: true,
          healthCertificateExpiryDate: inDays(-5),
        },
      });
      await prisma.employeeProfile.create({
        data: {
          name: 'Expiring Soon',
          code: 'H002',
          healthCertificate: true,
          healthCertificateExpiryDate: inDays(10),
        },
      });
      await prisma.employeeProfile.create({
        data: {
          name: 'Valid Cert',
          code: 'H003',
          healthCertificate: true,
          healthCertificateExpiryDate: inDays(200),
        },
      });
      await prisma.employeeProfile.create({ data: { name: 'No Cert', code: 'H004' } });
    });

    it('separates expired from expiring within the window', async () => {
      const expired = expectOk(
        await rpc('/api/biotime/reports/health-certificates', { mode: 'expired' }, hr.token),
      );
      expect((expired.rows as { name: string }[]).map((r) => r.name)).toEqual(['Expired Cert']);

      const expiring = expectOk(
        await rpc('/api/biotime/reports/health-certificates', { mode: 'expiring' }, hr.token),
      );
      expect((expiring.rows as { name: string }[]).map((r) => r.name)).toEqual(['Expiring Soon']);
    });

    it('honours a narrower warning window', async () => {
      const data = expectOk(
        await rpc(
          '/api/biotime/reports/health-certificates',
          { mode: 'expiring', warningDays: 5 },
          hr.token,
        ),
      );
      // 10 days out is no longer "soon" with a 5-day window.
      expect(data.count).toBe(0);
    });

    it('lists employees with no certificate as their own mode', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/health-certificates', { mode: 'missing' }, hr.token),
      );
      expect((data.rows as { name: string }[]).map((r) => r.name)).toEqual(['No Cert']);
    });

    it('defaults to expired plus expiring', async () => {
      const data = expectOk(
        await rpc('/api/biotime/reports/health-certificates', {}, hr.token),
      );
      const names = (data.rows as { name: string }[]).map((r) => r.name).sort();
      expect(names).toEqual(['Expired Cert', 'Expiring Soon']);
    });
  });
});
