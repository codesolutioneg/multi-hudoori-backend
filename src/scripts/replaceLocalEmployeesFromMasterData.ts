/**
 * Replace LOCAL employees from Master Data 2 Excel.
 *
 * - Does NOT call BioTime (no sync / push / delete on BioTime server)
 * - Deletes all local EmployeeProfile rows (+ related HR data)
 * - Keeps dashboard/admin Users listed below (and any platform admin / HR roles)
 * - Re-imports employees from the Excel file
 *
 * Usage:
 *   npx ts-node --transpile-only src/scripts/replaceLocalEmployeesFromMasterData.ts --yes
 *   npx ts-node --transpile-only src/scripts/replaceLocalEmployeesFromMasterData.ts --yes --file "Master Data 2 (2).xlsx"
 */
import 'dotenv/config';
import path from 'path';
import ExcelJS from 'exceljs';
import { UserRole } from '@prisma/client';
import { prisma } from '../prisma/client';
import {
  generateDepartmentCode,
  generateInsuranceCompanyCode,
  generateLocationCode,
} from '../services/settingsCode.service';

function resolveExcelPath(): string {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const fileArg = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
  const candidate = fileArg?.trim() || 'Master Data 2 (2).xlsx';
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(__dirname, '../../', candidate);
}

const EXCEL_PATH = resolveExcelPath();

/** Admin-panel logins — never delete these Users. Roles below are also kept. */
const KEEP_USER_LOGINS = new Set(
  [
    'demo@hudoori.com',
    'm@vicanz.com',
    'm@vicansa.com',
    'eng.mostafa.elgabry@gmail.com',
    'michael.charif@vicanzgroup.com',
    'michael.charlie@vicanzagroup.com',
    'rabab.hourani@vicanzgroup.com',
    'rabab.houran@vicanzagroup.com',
    'ahmed.essam@vicanzgroup.com',
    'ahmed.essam@vicanzagroup.com',
    'atf54399@gmail.com',
    'atf343069@gmail.com',
    'bioadmin@admin.bio',
    'Zalat@steak-house.org',
    't@t.com',
  ].map((s) => s.toLowerCase()),
);

const KEEP_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.HR_MANAGER,
  UserRole.HR_SUPERVISOR,
  UserRole.BRANCH_MANAGER,
  UserRole.DEVICE_MANAGER,
];

type ExcelRow = {
  location?: string;
  code?: string;
  name?: string;
  department?: string;
  jobTitle?: string;
  hiringDate?: Date | null;
  nationalId?: string;
  phone?: string;
  insuranceCompany?: string;
  insuranceSalary?: number | null;
  medicalInsuranceCompany?: string;
  medicalInsuranceSalary?: number | null;
  basicSalary?: number | null;
  mobileLine?: boolean;
  hasFawry?: boolean;
};

function cellVal(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'object' && v !== null) {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if ('result' in o) return o.result ?? null;
    if ('text' in o && typeof o.text === 'string') return o.text;
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join('');
  }
  return v;
}

function str(v: unknown): string {
  const x = cellVal(v);
  if (x == null) return '';
  return String(x).trim();
}

function num(v: unknown): number | null {
  const x = cellVal(v);
  if (x == null || x === '') return null;
  const n = typeof x === 'number' ? x : Number(String(x).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function flagD(v: unknown): boolean {
  return str(v).toUpperCase() === 'D';
}

function parseDate(v: unknown): Date | null {
  const x = cellVal(v);
  if (x == null || x === '') return null;
  if (x instanceof Date && !Number.isNaN(x.getTime())) return x;
  const d = new Date(String(x));
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeCode(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  if (/^\d+(\.0+)?$/.test(s)) return String(parseInt(s, 10));
  return s;
}

function shouldKeepUser(login: string, role: UserRole): boolean {
  if (KEEP_USER_LOGINS.has(login.toLowerCase())) return true;
  if (KEEP_ROLES.includes(role)) return true;
  return false;
}

async function readExcel(): Promise<ExcelRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_PATH);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Excel has no sheets');

  const headers: string[] = [];
  ws.getRow(1).eachCell((c, i) => {
    headers[i - 1] = str(c.value);
  });

  const idx = (name: string) =>
    headers.findIndex((h) => h === name || h.toLowerCase() === name.toLowerCase());

  const iLoc = idx('Location');
  const iCode = idx('code');
  const iName = idx('Name-Arabic');
  const iDept = idx('Department');
  const iJob = idx('Job Title');
  const iHire = idx('Hiring Date');
  const iNid = idx('الرقم القومى');
  const iPhone = idx('الهاتف');
  const iIns = idx('الموقف التاميني');
  const iInsSal = idx('الاجر التاميني');
  const iMed = idx('موقف التامين الطبي');
  const iMedSal = idx('الاجر التاميني الطبي');
  const iBasic = idx('Basic Salary');
  const iMobile = idx('Mobile Line');
  const iFawry = idx('Fawry');

  const rows: ExcelRow[] = [];
  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    const get = (i: number) => (i >= 0 ? row.getCell(i + 1).value : null);
    const code = normalizeCode(get(iCode));
    const name = str(get(iName));
    if (!code && !name) return;
    rows.push({
      location: str(get(iLoc)) || undefined,
      code: code || undefined,
      name: name || undefined,
      department: str(get(iDept)) || undefined,
      jobTitle: str(get(iJob)) || undefined,
      hiringDate: parseDate(get(iHire)),
      nationalId: (() => {
        const n = cellVal(get(iNid));
        if (n == null || n === '') return undefined;
        return String(n).replace(/\.0$/, '').trim() || undefined;
      })(),
      phone: (() => {
        const p = cellVal(get(iPhone));
        if (p == null || p === '') return undefined;
        return String(p).replace(/\.0$/, '').trim() || undefined;
      })(),
      insuranceCompany: str(get(iIns)) || undefined,
      insuranceSalary: num(get(iInsSal)),
      medicalInsuranceCompany: str(get(iMed)) || undefined,
      medicalInsuranceSalary: num(get(iMedSal)),
      basicSalary: num(get(iBasic)),
      mobileLine: iMobile >= 0 ? flagD(get(iMobile)) : false,
      hasFawry: flagD(get(iFawry)),
    });
  });
  return rows;
}

async function ensureLocation(name: string, cache: Map<string, string>): Promise<string> {
  const key = name.trim();
  if (cache.has(key)) return cache.get(key)!;
  let loc = await prisma.location.findFirst({ where: { name: key } });
  if (!loc) {
    loc = await prisma.location.findFirst({
      where: { name: { equals: key, mode: 'insensitive' } },
    });
  }
  if (!loc) {
    const code = await generateLocationCode();
    loc = await prisma.location.create({ data: { name: key, code, active: true } });
    console.log(`  + location: ${key} (${code})`);
  }
  cache.set(key, loc.id);
  return loc.id;
}

async function ensureDepartment(name: string, cache: Map<string, string>): Promise<string> {
  const key = name.trim();
  if (cache.has(key)) return cache.get(key)!;
  let dept = await prisma.department.findFirst({
    where: { name: { equals: key, mode: 'insensitive' } },
  });
  if (!dept) {
    const code = await generateDepartmentCode();
    dept = await prisma.department.create({ data: { name: key, code, active: true } });
    console.log(`  + department: ${key} (${code})`);
  }
  cache.set(key, dept.id);
  return dept.id;
}

async function ensureInsuranceCompany(name: string, cache: Map<string, string>): Promise<string> {
  const key = name.trim();
  if (cache.has(key)) return cache.get(key)!;
  let company = await prisma.insuranceCompany.findFirst({ where: { name: key } });
  if (!company) {
    const code = await generateInsuranceCompanyCode();
    company = await prisma.insuranceCompany.create({
      data: { name: key, code, active: true },
    });
    console.log(`  + insurance company: ${key} (${code})`);
  }
  cache.set(key, company.id);
  return company.id;
}

async function wipeLabel(label: string, fn: () => Promise<unknown>) {
  process.stdout.write(`  - ${label}… `);
  const result = await fn();
  const count =
    typeof result === 'object' && result && 'count' in result
      ? (result as { count: number }).count
      : '?';
  console.log(`ok (${count})`);
}

/** Local-only wipe of employee-related data. Never calls BioTime. */
async function purgeLocalEmployees(keepUserIds: string[]) {
  console.log('\n[1/4] Purging LOCAL employees (BioTime untouched)…');

  await wipeLabel('advanceLongPayment', () => prisma.advanceLongPayment.deleteMany());
  await wipeLabel('advanceLoanImportLine', () => prisma.advanceLoanImportLine.deleteMany());
  await wipeLabel('advanceLoanImport', () => prisma.advanceLoanImport.deleteMany());
  await wipeLabel('payrollLine', () => prisma.payrollLine.deleteMany());
  await wipeLabel('deduction', () => prisma.deduction.deleteMany());
  await wipeLabel('advanceShort', () => prisma.advanceShort.deleteMany());
  await wipeLabel('advanceLong', () => prisma.advanceLong.deleteMany());
  await wipeLabel('payroll', () => prisma.payroll.deleteMany());

  await wipeLabel('leaveRequest', () => prisma.leaveRequest.deleteMany());
  await wipeLabel('loanRequest', () => prisma.loanRequest.deleteMany());
  await wipeLabel('shiftChangeRequest', () => prisma.shiftChangeRequest.deleteMany());
  await wipeLabel('salaryRequest', () => prisma.salaryRequest.deleteMany());
  await wipeLabel('certificateRequest', () => prisma.certificateRequest.deleteMany());
  await wipeLabel('attendanceEditRequest', () => prisma.attendanceEditRequest.deleteMany());
  await wipeLabel('overtimeAnalysis', () => prisma.overtimeAnalysis.deleteMany());
  await wipeLabel('hiringAppointment', () => prisma.hiringAppointment.deleteMany());

  await wipeLabel('attendance', () => prisma.attendance.deleteMany());
  await wipeLabel('transaction', () => prisma.transaction.deleteMany());

  await wipeLabel('shiftGridLine', () => prisma.shiftGridLine.deleteMany());
  await wipeLabel('shiftAssignment', () => prisma.shiftAssignment.deleteMany());
  // Clear employeeIds arrays on grids without deleting the grids themselves
  const grids = await prisma.shiftGrid.findMany({ select: { id: true } });
  for (const g of grids) {
    await prisma.shiftGrid.update({ where: { id: g.id }, data: { employeeIds: [] } });
  }
  console.log(`  - shiftGrid employeeIds cleared (${grids.length})`);

  await wipeLabel('employeeCustody', () => prisma.employeeCustody.deleteMany());
  await wipeLabel('employeeMapping', () => prisma.employeeMapping.deleteMany());
  await wipeLabel('odooSyncMap employees', () =>
    prisma.odooSyncMap.deleteMany({
      where: { entityType: { in: ['employee', 'employee_profile'] } },
    }),
  );
  // Detach kept admin users from their employee profiles before wipe
  await wipeLabel('unlink kept-user employee profiles', () =>
    prisma.employeeProfile.updateMany({
      where: { userId: { in: keepUserIds } },
      data: { userId: null },
    }),
  );
  await wipeLabel('employeeProfile', () => prisma.employeeProfile.deleteMany());

  // Unlink / remove only non-kept users (employee portal accounts, etc.)
  await wipeLabel('apiToken (non-kept)', () =>
    prisma.apiToken.deleteMany({ where: { userId: { notIn: keepUserIds } } }),
  );
  await wipeLabel('users (non-kept)', () =>
    prisma.user.deleteMany({ where: { id: { notIn: keepUserIds } } }),
  );
}

async function main() {
  if (!process.argv.includes('--yes') && !process.argv.includes('-y')) {
    console.error('Refusing to run without --yes (deletes all local employees).');
    console.error('Usage: npx ts-node --transpile-only src/scripts/replaceLocalEmployeesFromMasterData.ts --yes');
    process.exit(1);
  }

  console.log('=== Replace LOCAL employees from Master Data 2 ===');
  console.log(`Excel: ${EXCEL_PATH}`);
  console.log('BioTime: NOT touched (no sync / push / delete)\n');

  const allUsers = await prisma.user.findMany({
    select: { id: true, login: true, name: true, role: true },
  });
  const keepUsers = allUsers.filter((u) => shouldKeepUser(u.login, u.role));
  const keepUserIds = keepUsers.map((u) => u.id);

  console.log('Keeping users:');
  for (const u of keepUsers) {
    console.log(`  ✓ ${u.login} (${u.name}) [${u.role}]`);
  }
  const dropped = allUsers.filter((u) => !keepUserIds.includes(u.id));
  if (dropped.length) {
    console.log('Will delete non-kept users:');
    for (const u of dropped) console.log(`  ✗ ${u.login} (${u.name}) [${u.role}]`);
  }

  const beforeEmp = await prisma.employeeProfile.count();
  console.log(`\nEmployees before purge: ${beforeEmp}`);

  await purgeLocalEmployees(keepUserIds);

  console.log('\n[2/4] Reading Excel…');
  const excelRows = await readExcel();
  console.log(`  excel rows: ${excelRows.length}`);

  const locationNames = new Set(
    excelRows.map((r) => r.location?.trim()).filter((x): x is string => !!x),
  );
  const departmentNames = new Set(
    excelRows.map((r) => r.department?.trim()).filter((x): x is string => !!x),
  );
  const insuranceNames = new Set<string>();
  for (const r of excelRows) {
    if (r.insuranceCompany) insuranceNames.add(r.insuranceCompany.trim());
    if (r.medicalInsuranceCompany) insuranceNames.add(r.medicalInsuranceCompany.trim());
  }

  console.log('\n[3/4] Ensuring locations / departments / insurance companies…');
  const locCache = new Map<string, string>();
  const deptCache = new Map<string, string>();
  const insCache = new Map<string, string>();

  for (const name of [...locationNames].sort()) await ensureLocation(name, locCache);
  for (const name of [...departmentNames].sort()) await ensureDepartment(name, deptCache);
  for (const name of [...insuranceNames].sort()) await ensureInsuranceCompany(name, insCache);

  console.log(`  locations ready: ${locCache.size}`);
  console.log(`  departments ready: ${deptCache.size}`);
  console.log(`  insurance companies ready: ${insCache.size}`);

  console.log('\n[4/4] Creating employees from Excel (local only)…');
  let created = 0;
  let skippedNoCode = 0;
  let errors = 0;
  const seenCodes = new Set<string>();

  for (const row of excelRows) {
    const code = row.code ? normalizeCode(row.code) : '';
    if (!code) {
      skippedNoCode++;
      continue;
    }
    if (seenCodes.has(code)) {
      console.warn(`  ! duplicate code in Excel skipped: ${code}`);
      continue;
    }
    seenCodes.add(code);

    try {
      const locationId = row.location ? await ensureLocation(row.location, locCache) : null;
      const departmentId = row.department
        ? await ensureDepartment(row.department, deptCache)
        : null;
      const insuranceCompanyId = row.insuranceCompany
        ? await ensureInsuranceCompany(row.insuranceCompany, insCache)
        : null;
      const medicalInsuranceCompanyId = row.medicalInsuranceCompany
        ? await ensureInsuranceCompany(row.medicalInsuranceCompany, insCache)
        : null;

      await prisma.employeeProfile.create({
        data: {
          name: row.name || code,
          displayName: row.name || code,
          code,
          identificationId: code,
          barcode: code,
          jobTitle: row.jobTitle ?? null,
          hiringDate: row.hiringDate,
          nationalIdConfirm: row.nationalId ?? null,
          mobilePhone: row.phone ?? null,
          locationId,
          location: row.location ?? null,
          departmentId,
          basicSalary: row.basicSalary ?? 0,
          insuranceCompanyId,
          insuranceSalary: row.insuranceSalary ?? 0,
          medicalInsuranceCompanyId,
          medicalInsuranceSalary: row.medicalInsuranceSalary ?? 0,
          mobileLine: row.mobileLine ?? false,
          hasFawryAccount: row.hasFawry ?? false,
          insuranceStatus: null,
          medicalInsuranceStatus: null,
          active: true,
          // Explicit: local Excel import — not pushed/synced to BioTime by this script
          biotimeSynced: false,
        },
      });
      created++;
    } catch (err) {
      errors++;
      console.error(`  ! code=${code}:`, err instanceof Error ? err.message : err);
    }
  }

  const [empCount, userCount, locCount, deptCount, insCount, kept] = await Promise.all([
    prisma.employeeProfile.count(),
    prisma.user.count(),
    prisma.location.count(),
    prisma.department.count(),
    prisma.insuranceCompany.count(),
    prisma.user.findMany({
      where: { id: { in: keepUserIds } },
      select: { login: true, name: true, role: true },
      orderBy: { login: 'asc' },
    }),
  ]);

  console.log('\n=== Done (BioTime untouched) ===');
  console.log(
    JSON.stringify(
      {
        excelRows: excelRows.length,
        created,
        skippedNoCode,
        errors,
        totals: {
          employees: empCount,
          users: userCount,
          locations: locCount,
          departments: deptCount,
          insuranceCompanies: insCount,
        },
        keptUsers: kept,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
