/**
 * Seed / upsert new hires from Excel into Hudoori (prod-safe).
 *
 * Columns expected (Sheet1):
 *   code | Name-Arabic | Job Title | Department | Location |
 *   Hiring Date | تاريخ اول ايوم عمل | الرقم القومى | الهاتف
 *
 * - Creates employees that do not exist (by code / identificationId / biotimeEmpCode)
 * - Updates BioTime stubs / existing rows with HR fields from Excel
 * - Prefers «تاريخ اول ايوم عمل» for hiringDate when present
 * - Matches locations / departments case-insensitively (does not invent "strip")
 * - Normalizes Egyptian phones with a leading 0
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.prod npx ts-node -r dotenv/config --transpile-only \
 *     src/scripts/seedNewHiresFromExcel.ts --dry-run
 *   DOTENV_CONFIG_PATH=.env.prod npx ts-node -r dotenv/config --transpile-only \
 *     src/scripts/seedNewHiresFromExcel.ts --apply
 *   ... --file /path/to/new_hire.xlsx
 */
import path from 'path';
import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import {
  generateDepartmentCode,
  generateLocationCode,
} from '../services/settingsCode.service';

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY || process.argv.includes('--dry-run');
const ALLOW_CREATE_LOCATION = process.argv.includes('--create-missing-locations');
const ALLOW_CREATE_DEPARTMENT = process.argv.includes('--create-missing-departments');

function resolveExcelPath(): string {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const fileArg = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
  const candidate = fileArg?.trim() || 'files_to_sync/new_hire.xlsx';
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(__dirname, '../../', candidate);
}

type HireRow = {
  rowNum: number;
  code: string;
  name: string;
  jobTitle: string | null;
  department: string | null;
  location: string | null;
  hiringDate: Date | null;
  firstWorkDate: Date | null;
  nationalId: string | null;
  phone: string | null;
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

function normalizeCode(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  if (/^\d+(\.0+)?$/.test(s)) return String(parseInt(s, 10));
  return s;
}

function parseDate(v: unknown): Date | null {
  const x = cellVal(v);
  if (x == null || x === '') return null;
  if (x instanceof Date && !Number.isNaN(x.getTime())) {
    return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
  }
  const d = new Date(String(x));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function normalizeNationalId(v: unknown): string | null {
  const x = cellVal(v);
  if (x == null || x === '') return null;
  const s = String(x).replace(/\.0$/, '').replace(/\D/g, '').trim();
  return s || null;
}

/** Egyptian mobiles often land in Excel as 10/11 digits without leading 0. */
function normalizePhone(v: unknown): string | null {
  const x = cellVal(v);
  if (x == null || x === '') return null;
  let digits = String(x).replace(/\.0$/, '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('20') && digits.length >= 12) digits = digits.slice(2);
  if (!digits.startsWith('0') && (digits.length === 10 || digits.length === 9)) {
    digits = `0${digits}`;
  }
  return digits;
}

async function readExcel(filePath: string): Promise<HireRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Excel has no sheets');

  const headers: string[] = [];
  ws.getRow(1).eachCell((c, i) => {
    headers[i - 1] = str(c.value);
  });
  const idx = (name: string) => headers.findIndex((h) => h === name);

  const iCode = idx('code');
  const iName = idx('Name-Arabic');
  const iJob = idx('Job Title');
  const iDept = idx('Department');
  const iLoc = idx('Location');
  const iHire = idx('Hiring Date');
  const iFirst = idx('تاريخ اول ايوم عمل');
  const iNid = idx('الرقم القومى');
  const iPhone = idx('الهاتف');

  if (iCode < 0 || iName < 0) {
    throw new Error(`Missing required headers code / Name-Arabic. Found: ${headers.join(', ')}`);
  }

  const rows: HireRow[] = [];
  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    const get = (i: number) => (i >= 0 ? row.getCell(i + 1).value : null);
    const code = normalizeCode(get(iCode));
    const name = str(get(iName));
    if (!code && !name) return;
    rows.push({
      rowNum: rn,
      code,
      name,
      jobTitle: str(get(iJob)) || null,
      department: str(get(iDept)) || null,
      location: str(get(iLoc)) || null,
      hiringDate: parseDate(get(iHire)),
      firstWorkDate: parseDate(get(iFirst)),
      nationalId: normalizeNationalId(get(iNid)),
      phone: normalizePhone(get(iPhone)),
    });
  });
  return rows;
}

async function resolveLocation(
  name: string,
  cache: Map<string, { id: string; name: string }>,
): Promise<{ id: string; name: string } | null> {
  const key = name.trim();
  const cacheKey = key.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  let loc = await prisma.location.findFirst({
    where: { name: { equals: key, mode: 'insensitive' } },
  });
  if (!loc && ALLOW_CREATE_LOCATION) {
    const code = await generateLocationCode();
    loc = await prisma.location.create({ data: { name: key, code, active: true } });
    console.log(`  + location created: ${key} (${code})`);
  }
  if (!loc) return null;
  const resolved = { id: loc.id, name: loc.name };
  cache.set(cacheKey, resolved);
  return resolved;
}

async function resolveDepartment(
  name: string,
  cache: Map<string, string>,
): Promise<string | null> {
  const key = name.trim();
  const cacheKey = key.toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  let dept = await prisma.department.findFirst({
    where: { name: { equals: key, mode: 'insensitive' } },
  });
  if (!dept && ALLOW_CREATE_DEPARTMENT) {
    const code = await generateDepartmentCode();
    dept = await prisma.department.create({ data: { name: key, code, active: true } });
    console.log(`  + department created: ${key} (${code})`);
  }
  if (!dept) return null;
  cache.set(cacheKey, dept.id);
  return dept.id;
}

async function main() {
  const filePath = resolveExcelPath();
  console.log('=== Seed new hires from Excel ===');
  console.log(
    JSON.stringify(
      {
        mode: DRY_RUN ? 'DRY_RUN' : 'APPLY',
        file: filePath,
        database: process.env.DATABASE_URL?.replace(/:\/\/[^@]+@/, '://***@') ?? null,
        allowCreateLocations: ALLOW_CREATE_LOCATION,
        allowCreateDepartments: ALLOW_CREATE_DEPARTMENT,
      },
      null,
      2,
    ),
  );

  const excelRows = await readExcel(filePath);
  console.log(`excel rows: ${excelRows.length}`);

  const allEmps = await prisma.employeeProfile.findMany({
    select: {
      id: true,
      code: true,
      identificationId: true,
      name: true,
      mapping: { select: { biotimeEmpCode: true } },
    },
  });
  const byCode = new Map<string, (typeof allEmps)[number]>();
  for (const e of allEmps) {
    for (const c of [e.code, e.identificationId, e.mapping?.biotimeEmpCode]) {
      const k = normalizeCode(c);
      if (k && !byCode.has(k)) byCode.set(k, e);
    }
  }

  const locCache = new Map<string, { id: string; name: string }>();
  const deptCache = new Map<string, string>();

  const plan: Array<Record<string, unknown>> = [];
  let wouldCreate = 0;
  let wouldUpdate = 0;
  let errors = 0;
  let created = 0;
  let updated = 0;

  for (const row of excelRows) {
    if (!row.code) {
      errors++;
      plan.push({ row: row.rowNum, error: 'missing code', name: row.name });
      continue;
    }
    if (!row.name) {
      errors++;
      plan.push({ row: row.rowNum, code: row.code, error: 'missing name' });
      continue;
    }

    const loc = row.location ? await resolveLocation(row.location, locCache) : null;
    if (row.location && !loc) {
      errors++;
      plan.push({
        row: row.rowNum,
        code: row.code,
        error: `unknown location "${row.location}" (pass --create-missing-locations to create)`,
      });
      continue;
    }

    const departmentId = row.department
      ? await resolveDepartment(row.department, deptCache)
      : null;
    if (row.department && !departmentId) {
      errors++;
      plan.push({
        row: row.rowNum,
        code: row.code,
        error: `unknown department "${row.department}" (pass --create-missing-departments to create)`,
      });
      continue;
    }

    const hiringDate = row.firstWorkDate ?? row.hiringDate;
    const existing = byCode.get(row.code);
    const action = existing ? 'update' : 'create';
    if (action === 'create') wouldCreate++;
    else wouldUpdate++;

    const entry = {
      row: row.rowNum,
      action,
      code: row.code,
      name: row.name,
      jobTitle: row.jobTitle,
      department: row.department,
      location: loc?.name ?? null,
      hiringDate: hiringDate?.toISOString().slice(0, 10) ?? null,
      nationalId: row.nationalId,
      phone: row.phone,
      existingName: existing?.name ?? null,
    };
    plan.push(entry);

    if (DRY_RUN) continue;

    const data = {
      name: row.name,
      displayName: row.name,
      code: row.code,
      identificationId: row.code,
      barcode: row.code,
      jobTitle: row.jobTitle,
      hiringDate,
      nationalIdConfirm: row.nationalId,
      mobilePhone: row.phone,
      workPhone: row.phone,
      locationId: loc?.id ?? null,
      location: loc?.name ?? null,
      departmentId,
      active: true,
    };

    try {
      if (existing) {
        await prisma.employeeProfile.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        const createdEmp = await prisma.employeeProfile.create({
          data: {
            ...data,
            biotimeSynced: false,
            mapping: {
              create: {
                biotimeEmpCode: row.code,
                biotimeEmpId: null,
              },
            },
          },
          include: { mapping: true },
        });
        byCode.set(row.code, {
          id: createdEmp.id,
          code: createdEmp.code,
          identificationId: createdEmp.identificationId,
          name: createdEmp.name,
          mapping: createdEmp.mapping
            ? { biotimeEmpCode: createdEmp.mapping.biotimeEmpCode }
            : null,
        });
        created++;
      }
    } catch (err) {
      errors++;
      console.error(`  ! code=${row.code}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(JSON.stringify({ plan }, null, 2));
  console.log(
    JSON.stringify(
      {
        mode: DRY_RUN ? 'DRY_RUN' : 'APPLY',
        excelRows: excelRows.length,
        wouldCreate,
        wouldUpdate,
        created,
        updated,
        errors,
      },
      null,
      2,
    ),
  );

  if (DRY_RUN) {
    console.log('Dry-run only. Re-run with --apply to write.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
