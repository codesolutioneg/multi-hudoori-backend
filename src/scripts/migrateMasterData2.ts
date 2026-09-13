/**
 * Smart migration of Master Data Excel onto Hudoori employees (prod-safe).
 *
 * Steps:
 *  1) Sync departments + employees from BioTime
 *  2) Ensure locations / departments / insurance companies from Excel
 *  3) Match by employee code and overwrite HR fields from Excel
 *  4) Create employees that exist only in Excel
 *
 * Does NOT wipe existing employees (unlike replaceLocalEmployeesFromMasterData).
 *
 * Usage:
 *   npx ts-node --transpile-only src/scripts/migrateMasterData2.ts
 *   npx ts-node --transpile-only src/scripts/migrateMasterData2.ts --file "Master Data 2 (2).xlsx"
 *   npx ts-node --transpile-only src/scripts/migrateMasterData2.ts --file "..." --skip-biotime-sync
 */
import 'dotenv/config';
import path from 'path';
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { syncDepartments, syncEmployees } from '../services/biotime/sync.service';
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
const SKIP_BIOTIME_SYNC = process.argv.includes('--skip-biotime-sync');

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
  // Excel may store codes as numbers (10) — keep as plain string without decimals
  if (/^\d+(\.0+)?$/.test(s)) return String(parseInt(s, 10));
  return s;
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

  const idx = (name: string) => headers.findIndex((h) => h === name);

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
        // Keep national ID as digit string (Excel may store as number)
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
      mobileLine: flagD(get(iMobile)),
      hasFawry: flagD(get(iFawry)),
    });
  });
  return rows;
}

async function ensureLocation(name: string, cache: Map<string, string>): Promise<string> {
  const key = name.trim();
  if (cache.has(key)) return cache.get(key)!;
  // Exact name match first (no case-fold merge across different spellings)
  let loc = await prisma.location.findFirst({ where: { name: key } });
  if (!loc) {
    // Also try case-insensitive only for exact same letters ignoring case
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
    dept = await prisma.department.create({
      data: { name: key, code, active: true },
    });
    console.log(`  + department: ${key} (${code})`);
  }
  cache.set(key, dept.id);
  return dept.id;
}

async function ensureInsuranceCompany(name: string, cache: Map<string, string>): Promise<string> {
  // Exact name match — no Hub/HUB normalize per user request
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

async function main() {
  console.log('=== Master Data 2 migration (smart upsert by code) ===\n');
  console.log(`Excel: ${EXCEL_PATH}`);
  console.log(`Database: ${process.env.DATABASE_URL?.replace(/:[^:@/]+@/, ':***@') ?? '(unset)'}`);

  if (SKIP_BIOTIME_SYNC) {
    console.log('\n[1/4] Skipping BioTime sync (--skip-biotime-sync)');
  } else {
    console.log('\n[1/4] Syncing BioTime departments + employees…');
    const deptSynced = await syncDepartments();
    console.log(`  departments synced: ${deptSynced}`);
    const empSynced = await syncEmployees();
    console.log(`  employees synced: ${empSynced}`);
  }

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

  console.log('\n[4/4] Applying employee updates by code…');
  const allEmps = await prisma.employeeProfile.findMany({
    select: { id: true, code: true, identificationId: true, mapping: { select: { biotimeEmpCode: true } } },
  });
  const byCode = new Map<string, string>();
  for (const e of allEmps) {
    for (const c of [e.code, e.identificationId, e.mapping?.biotimeEmpCode]) {
      const k = normalizeCode(c);
      if (k) byCode.set(k, e.id);
    }
  }

  let updated = 0;
  let created = 0;
  let skippedNoCode = 0;
  let errors = 0;

  for (const row of excelRows) {
    const code = row.code ? normalizeCode(row.code) : '';
    if (!code) {
      skippedNoCode++;
      continue;
    }

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

      const data = {
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
        // Clear statuses — company is stored on the FK fields
        insuranceStatus: null as string | null,
        medicalInsuranceStatus: null as string | null,
      };

      const existingId = byCode.get(code);
      if (existingId) {
        await prisma.employeeProfile.update({ where: { id: existingId }, data });
        updated++;
      } else {
        const createdEmp = await prisma.employeeProfile.create({
          data: {
            ...data,
            active: true,
            biotimeSynced: false,
          },
        });
        byCode.set(code, createdEmp.id);
        created++;
      }
    } catch (err) {
      errors++;
      console.error(`  ! code=${code}:`, err instanceof Error ? err.message : err);
    }
  }

  const [empCount, locCount, deptCount, insCount] = await Promise.all([
    prisma.employeeProfile.count(),
    prisma.location.count(),
    prisma.department.count(),
    prisma.insuranceCompany.count(),
  ]);

  console.log('\n=== Done ===');
  console.log(JSON.stringify({
    excelRows: excelRows.length,
    updated,
    created,
    skippedNoCode,
    errors,
    totals: { employees: empCount, locations: locCount, departments: deptCount, insuranceCompanies: insCount },
    insuranceCompanies: [...insCache.keys()],
    locations: [...locCache.keys()],
  }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
