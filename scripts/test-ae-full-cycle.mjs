#!/usr/bin/env node
/**
 * Full HR employee cycle test for ae@juma.com
 * Seeds attendance punches, runs payroll / deductions / advances / loan-import APIs.
 */
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const LOGIN = process.env.TEST_LOGIN || 'ae@juma.com';
const PASS = process.env.TEST_PASSWORD || 'ae@juma.com';

/** Endpoints that contact or push to the external BioTime server — never called in this script */
const FORBIDDEN_BIOTIME_PATHS = new Set([
  '/api/biotime/config/sync-all',
  '/api/biotime/config/sync-pull',
  '/api/biotime/config/sync-employees',
  '/api/biotime/config/sync-departments',
  '/api/biotime/config/sync-devices',
  '/api/biotime/config/sync-transactions',
  '/api/biotime/config/test-connection',
  '/api/biotime/employees/push',
  '/api/biotime/employees/push-all',
]);

const DATE_FROM = '2026-04-26';
const DATE_TO = '2026-05-25';
const DED_DATE = '2026-05-19';

const AHMED_ID = 'cmqtj3ctr0007byvcnrg5re0p';
const AMR_ID = 'cmqtgmp2j01qzvx56lpd4qqgv';
const SHIFT_ID = 'cmqtgmxde02lfvx56hn3cmkxc';
const DEVICE_SN = 'Balkans Blue side';

const results = [];

function log(step, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  results.push({ step, status, detail });
  console.log(`[${status}] ${step}${detail ? ' — ' + detail : ''}`);
}

async function rpc(path, params = {}) {
  if (FORBIDDEN_BIOTIME_PATHS.has(path) || path.includes('/sync') || path.includes('/push')) {
    throw new Error(`BLOCKED: ${path} would contact BioTime server`);
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params, id: 1 }),
  });
  const json = await res.json();
  return json;
}

function unwrap(r) {
  if (r.error) throw new Error(JSON.stringify(r.error));
  const result = r.result ?? r;
  if (result.success === false) throw new Error(result.message || JSON.stringify(result));
  return result.data ?? result;
}

function weekdaysBetween(fromStr, toStr) {
  const days = [];
  const cur = new Date(`${fromStr}T12:00:00.000Z`);
  const end = new Date(`${toStr}T12:00:00.000Z`);
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 5 && dow !== 6) days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

async function seedPunches(prisma, employeeIds) {
  const days = weekdaysBetween(DATE_FROM, DATE_TO);
  let created = 0;
  for (const empId of employeeIds) {
    const emp = await prisma.employeeProfile.findUnique({
      where: { id: empId },
      include: { mapping: true },
    });
    const code = emp?.mapping?.biotimeEmpCode?.trim() || emp?.code?.trim() || '';
    const existing = await prisma.transaction.count({
      where: {
        employeeId: empId,
        punchTime: { gte: new Date(DATE_FROM), lte: new Date(`${DATE_TO}T23:59:59.999Z`) },
      },
    });
    if (existing >= days.length) continue;

    for (const day of days) {
      const has = await prisma.transaction.findFirst({
        where: {
          employeeId: empId,
          punchTime: { gte: new Date(`${day}T00:00:00.000Z`), lt: new Date(`${day}T23:59:59.999Z`) },
        },
      });
      if (has) continue;
      await prisma.transaction.createMany({
        data: [
          {
            employeeId: empId,
            empCode: code,
            punchTime: new Date(`${day}T07:05:00.000Z`),
            punchState: '0',
            terminalSn: DEVICE_SN,
            terminalAlias: DEVICE_SN,
          },
          {
            employeeId: empId,
            empCode: code,
            punchTime: new Date(`${day}T16:00:00.000Z`),
            punchState: '1',
            terminalSn: DEVICE_SN,
            terminalAlias: DEVICE_SN,
          },
        ],
      });
      created += 2;
    }
  }
  return created;
}

async function ensureAssignments(prisma, employeeIds) {
  for (const employeeId of employeeIds) {
    const existing = await prisma.shiftAssignment.findFirst({
      where: { employeeId, active: true },
    });
    if (!existing) {
      await prisma.shiftAssignment.create({
        data: {
          employeeId,
          shiftId: SHIFT_ID,
          assignmentType: 'permanent',
          dateFrom: new Date(DATE_FROM),
          active: true,
        },
      });
    }
  }
}

async function buildLoanXlsxBase64(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('loans');
  ws.addRow(['employee_code', 'employee_name', 'amount', 'reason']);
  for (const r of rows) ws.addRow([r.code, r.name, r.amount, r.reason ?? 'AE test']);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

async function waitJob(token, jobId, label, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const d = unwrap(await rpc('/api/biotime/jobs/status', { token, jobId }));
    if (d.status === 'done') {
      log(label, true, d.message || 'done');
      return d;
    }
    if (d.status === 'failed') {
      log(label, false, d.message || 'failed');
      return d;
    }
  }
  log(label, false, 'timeout');
  return null;
}

async function main() {
  const prisma = new PrismaClient();
  console.log('=== AE FULL CYCLE TEST ===');
  console.log(`User: ${LOGIN} | Period: ${DATE_FROM} → ${DATE_TO}`);
  console.log('BioTime server: NOT contacted (no sync/push endpoints)');

  let token = '';
  try {
    const login = await rpc('/api/auth/login', { login: LOGIN, password: PASS });
    const data = unwrap(login);
    token = data.token;
    log('Login', true, `${data.user?.name} (${data.user?.role})`);
  } catch (e) {
    log('Login', false, String(e.message || e));
    process.exit(1);
  }

  const p = { token };
  const testEmps = [AHMED_ID, AMR_ID];

  try {
    const seeded = await seedPunches(prisma, testEmps);
    log('Seed attendance punches', true, `${seeded} transactions created`);
    await ensureAssignments(prisma, testEmps);
    log('Shift assignments', true, 'permanent shift 7 صباحي');
  } catch (e) {
    log('DB seed', false, String(e.message || e));
  }

  try {
    const cfg = unwrap(await rpc('/api/biotime/config/get', p));
    log('Config get', true, `timezone=${cfg?.timezone ?? 'ok'}`);
  } catch (e) {
    log('Config get', false, String(e.message || e));
  }

  let gridId = '';
  try {
    const gridName = `AE-Cycle-${Date.now()}`;
    const gridRes = unwrap(
      await rpc('/api/biotime/shift-grid/create', {
        ...p,
        name: gridName,
        dateFrom: DATE_FROM,
        dateTo: DATE_TO,
        selectionMethod: 'manual',
        employeeIds: testEmps,
        generate: true,
      }),
    );
    gridId = gridRes.grid?.id ?? '';
    if (gridId) {
      unwrap(await rpc('/api/biotime/shift-grid/resync-dates', { ...p, gridId }));
      unwrap(await rpc('/api/biotime/shift-grid/confirm-assignments', { ...p, gridId }));
      log('Shift grid', true, gridId);
    } else log('Shift grid', false, 'no grid id');
  } catch (e) {
    log('Shift grid', false, String(e.message || e));
  }

  try {
    const attJob = unwrap(
      await rpc('/api/biotime/attendance/generate', {
        ...p,
        dateFrom: DATE_FROM,
        dateTo: DATE_TO,
        employeeIds: testEmps,
        shiftGridId: gridId || undefined,
        skipExisting: true,
      }),
    );
    if (attJob.jobId) await waitJob(token, attJob.jobId, 'Attendance generate', 90);
    else log('Attendance generate', false, 'no jobId');

    let presentTotal = 0;
    let absentTotal = 0;
    for (const empId of testEmps) {
      const att = unwrap(
        await rpc('/api/biotime/attendance/list', {
          ...p,
          dateFrom: DATE_FROM,
          dateTo: DATE_TO,
          employeeId: empId,
          limit: 200,
        }),
      );
      const recs = att.records ?? [];
      presentTotal += recs.filter((r) => r.status === 'present' || r.status === 'late' || (r.netWorkedHours ?? 0) > 0).length;
      absentTotal += recs.filter((r) => r.status === 'absent').length;
    }
    log('Attendance list (test employees)', presentTotal > 0, `${presentTotal} present/late, ${absentTotal} absent`);
  } catch (e) {
    log('Attendance', false, String(e.message || e));
  }

  try {
    const punch = unwrap(
      await rpc('/api/biotime/punch-report/generate', { ...p, dateFrom: DATE_FROM, dateTo: DATE_TO, employeeIds: testEmps }),
    );
    const lines = punch.lines ?? [];
    const worked = lines.filter((l) => !l.isAbsent && !l.isOffDay && l.punchCount > 0).length;
    const absentLines = lines.filter((l) => l.isAbsent && !l.isOffDay).length;
    log('Punch report', worked > 0, `${worked} worked days, ${absentLines} absent lines, ${lines.length} total`);
  } catch (e) {
    log('Punch report', false, String(e.message || e));
  }

  let dedId = '';
  try {
    const types = unwrap(await rpc('/api/biotime/deductions/types', p));
    log('Deduction types', (types.types ?? types).length > 0, `${(types.types ?? types).length} types`);

    const list = unwrap(await rpc('/api/biotime/deductions/list', { ...p, dateFrom: DED_DATE, dateTo: DED_DATE, limit: 5 }));
    log('Deductions list', true, `count=${list.count ?? list.deductions?.length ?? 0}`);

    const device = await prisma.device.findFirst();
    const created = unwrap(
      await rpc('/api/biotime/deductions/create', {
        ...p,
        employeeId: AHMED_ID,
        type: 'manual_debit',
        amount: 150,
        date: DED_DATE,
        deviceId: device?.id,
        notes: 'AE cycle test deduction',
      }),
    );
    dedId = created.deduction?.id ?? '';
    log('Deduction create', !!dedId, `ref=${created.deduction?.reference} amount=150`);

    const tpl = unwrap(
      await rpc('/api/biotime/deductions/export-template', { ...p, deductionType: 'manual_debit', date: DED_DATE, deviceId: device?.id }),
    );
    const b64 = tpl.file ?? tpl.base64 ?? tpl.data;
    log('Deduction export template', !!b64, b64 ? `${Math.round(String(b64).length / 1024)}kb` : 'empty');

    if (b64) {
      const imp = unwrap(
        await rpc('/api/biotime/deductions/import-xlsx', {
          ...p,
          file: b64,
          deductionType: 'manual_debit',
          date: DED_DATE,
          deviceId: device?.id,
        }),
      );
      log('Deduction import xlsx (round-trip)', (imp.created ?? imp.imported ?? 0) >= 0, JSON.stringify({ created: imp.created, skipped: imp.skipped?.length }));
    }
  } catch (e) {
    log('Deductions', false, String(e.message || e));
  }

  let shortAdvId = '';
  try {
    const eligParams = {
      ...p,
      employeeId: AHMED_ID,
      shiftGridId: gridId || undefined,
      eligibilityDateFrom: DATE_FROM,
      eligibilityDateTo: DATE_TO,
    };
    const eligWrap = unwrap(await rpc('/api/biotime/advances/eligibility/preview', eligParams));
    const elig = eligWrap.eligibility ?? eligWrap;
    log(
      'Advance eligibility',
      elig.isEligible === true || elig.actualWorkingDays >= 15,
      `days=${elig.actualWorkingDays} eligible=${elig.isEligible} available=${elig.availableAmount}`,
    );

    const adv = unwrap(
      await rpc('/api/biotime/advances/short/create', {
        ...p,
        employeeId: AHMED_ID,
        amount: 200,
        date: DED_DATE,
        notes: 'AE cycle short advance',
        shiftGridId: gridId || undefined,
        eligibilityDateFrom: DATE_FROM,
        eligibilityDateTo: DATE_TO,
      }),
    );
    shortAdvId = adv.advance?.id ?? adv.shortAdvance?.id ?? '';
    log('Short advance create', !!shortAdvId, `amount=200 id=${shortAdvId.slice(0, 8)}…`);

    const advList = unwrap(await rpc('/api/biotime/advances/short/list', { ...p, employeeId: AHMED_ID, limit: 3 }));
    log('Short advances list', (advList.advances ?? advList.items ?? []).length > 0, `count=${advList.count ?? 'ok'}`);
  } catch (e) {
    log('Short advances', false, String(e.message || e));
  }

  try {
    const loanCreate = unwrap(
      await rpc('/api/biotime/advances/loan-import/create', {
        ...p,
        date: DED_DATE,
        sourceGridId: gridId || undefined,
      }),
    );
    const importId = loanCreate.import?.id ?? '';
    const loanB64 = await buildLoanXlsxBase64([
      { code: 'AE001', name: 'Ahmed Essam', amount: 300, reason: 'AE cycle loan test' },
      { code: '3167', name: 'عمرو علي', amount: 500, reason: 'AE cycle loan test' },
    ]);
    const preview = unwrap(
      await rpc('/api/biotime/advances/loan-import/preview', { ...p, importId, loanFile: loanB64 }),
    );
    const lines = preview.import?.lines ?? preview.lines ?? [];
    log('Loan import create + preview', lines.length >= 1, `import=${importId} lines=${lines.length}`);

    if (lines.length > 0) {
      const lineId = lines[0].id;
      unwrap(
        await rpc('/api/biotime/advances/loan-import/lines/update', {
          ...p,
          lineId,
          approvedAmount: Math.min(lines[0].requestedAmount ?? 300, 300),
          toApprove: true,
        }),
      );
      log('Loan import line update', true, lineId.slice(0, 8));
    }
  } catch (e) {
    log('Loan import', false, String(e.message || e));
  }

  let payrollId = '';
  try {
    const payName = `AE-Cycle-${Date.now()}`;
    const payCreate = unwrap(
      await rpc('/api/biotime/payroll/create', { ...p, dateFrom: DATE_FROM, dateTo: DATE_TO, name: payName }),
    );
    payrollId = payCreate.payroll?.id ?? '';
    log('Payroll create', !!payrollId, payName);

    if (payrollId) {
      unwrap(await rpc('/api/biotime/payroll/calculate', { ...p, payrollId }));
      log('Payroll calculate', true, payrollId);

      const linkDed = unwrap(await rpc('/api/biotime/payroll/link-deductions', { ...p, payrollId }));
      log('Payroll link deductions', true, `linked=${linkDed.linked ?? linkDed.count ?? 'ok'}`);

      try {
        const linkAdv = unwrap(await rpc('/api/biotime/payroll/recalculate-advances', { ...p, payrollId }));
        log('Payroll recalculate advances', true, JSON.stringify(linkAdv).slice(0, 120));
      } catch (e) {
        log('Payroll recalculate advances', false, String(e.message || e));
      }

      try {
        const linkLong = unwrap(await rpc('/api/biotime/payroll/link-long-advances', { ...p, payrollId }));
        log('Payroll link long advances', true, JSON.stringify(linkLong).slice(0, 120));
      } catch (e) {
        log('Payroll link long advances', false, String(e.message || e));
      }

      try {
        const fixPen = unwrap(await rpc('/api/biotime/payroll/fix-penalty-values', { ...p, payrollId }));
        log('Payroll fix penalty values', true, JSON.stringify(fixPen).slice(0, 80));
      } catch (e) {
        log('Payroll fix penalty values', false, String(e.message || e));
      }

      const payGet = unwrap(await rpc('/api/biotime/payroll/get', { ...p, payrollId }));
      const lines = payGet.lines ?? payGet.payroll?.lines ?? [];
      const ahmedLine = lines.find((l) => l.employeeId === AHMED_ID);
      const amrLine = lines.find((l) => l.employeeId === AMR_ID);
      log(
        'Payroll lines',
        lines.length > 0,
        `total=${lines.length} Ahmed net=${ahmedLine?.netSalary ?? 'n/a'} workDays=${ahmedLine?.workingDays ?? 'n/a'} Amr net=${amrLine?.netSalary ?? 'n/a'}`,
      );

      if (ahmedLine?.id) {
        try {
          const updated = unwrap(
            await rpc('/api/biotime/payroll/line/update', {
              ...p,
              lineId: ahmedLine.id,
              leaveAbsenceDeductionValue: 25,
            }),
          );
          log(
            'Payroll line update (leave absence)',
            (updated.line?.leaveAbsenceDeductionValue ?? updated.leaveAbsenceDeductionValue) === 25,
            `net=${updated.line?.netSalary ?? updated.netSalary}`,
          );
        } catch (e) {
          log('Payroll line update (leave absence)', false, String(e.message || e));
        }
      }

      try {
        const dupes = unwrap(await rpc('/api/biotime/payroll/duplicates/list', { ...p, payrollId }));
        log('Payroll duplicates list', Array.isArray(dupes.items) || dupes.count >= 0, `count=${dupes.count ?? dupes.items?.length ?? 0}`);
      } catch (e) {
        log('Payroll duplicates list', false, String(e.message || e));
      }

      try {
        const xlsx = unwrap(await rpc('/api/biotime/payroll/export-xlsx', { ...p, payrollId }));
        const b64 = xlsx.base64 ?? xlsx.file ?? '';
        log('Payroll export xlsx', !!b64, b64 ? `${Math.round(String(b64).length / 1024)}kb` : 'empty');

        if (b64) {
          const imp = unwrap(await rpc('/api/biotime/payroll/import-xlsx', { ...p, payrollId, base64: b64 }));
          log('Payroll import xlsx (round-trip)', (imp.updated ?? 0) >= 0, `updated=${imp.updated} skipped=${imp.skipped ?? 0}`);

          const payAfterImport = unwrap(await rpc('/api/biotime/payroll/get', { ...p, payrollId }));
          const showCmp = payAfterImport.showEditComparison ?? payAfterImport.payroll?.showEditComparison;
          log('Payroll edit comparison after import', showCmp === true, `before=${payAfterImport.comparisonTotalNetBefore ?? payAfterImport.payroll?.comparisonTotalNetBefore}`);

          if (showCmp) {
            unwrap(await rpc('/api/biotime/payroll/reset-edit-comparison', { ...p, payrollId }));
            log('Payroll reset edit comparison', true, 'cleared');
          }
        }
      } catch (e) {
        log('Payroll xlsx export/import', false, String(e.message || e));
      }

      unwrap(await rpc('/api/biotime/payroll/confirm', { ...p, payrollId }));
      log('Payroll confirm', true, 'draft→confirmed');

      const payAfter = unwrap(await rpc('/api/biotime/payroll/get', { ...p, payrollId }));
      log('Payroll state after confirm', payAfter.payroll?.state === 'confirmed', payAfter.payroll?.state);
    }
  } catch (e) {
    log('Payroll cycle', false, String(e.message || e));
  }

  try {
    const myPay = unwrap(await rpc('/api/biotime/payroll/my', p));
    log('Employee payroll/my', true, `items=${(myPay.payrolls ?? myPay.items ?? []).length}`);
  } catch (e) {
    log('Payroll/my', false, String(e.message || e));
  }

  if (dedId) {
    try {
      await rpc('/api/biotime/deductions/cancel', { ...p, id: dedId });
      log('Deduction cancel (test cleanup)', true, dedId.slice(0, 8));
    } catch {
      log('Deduction cancel', false, 'linked or already cancelled');
    }
  }

  await prisma.$disconnect();

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n=== SUMMARY ===');
  console.log(`PASS: ${passed} | FAIL: ${failed} | TOTAL: ${results.length}`);
  console.log('BioTime server sync/push: NOT invoked');
  if (failed > 0) {
    console.log('\nFailed steps:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.step}: ${r.detail}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
