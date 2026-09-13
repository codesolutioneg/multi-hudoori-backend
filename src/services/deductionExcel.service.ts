import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { DEDUCTION_TYPES } from './serialize.service';
import { nextDeductionReference } from './deductionReference.service';
import { DEDUCTION_TYPE_FIELD } from './payrollDeductions.service';

/** Odoo MULTI_IMPORT_TYPES */
export const MULTI_IMPORT_TYPES = [
  { type: 'personal_checks', label: 'شيكات شخصية' },
  { type: 'manual_debit', label: 'مانيول ديبت' },
  { type: 'health_certificates', label: 'شهادات صحية' },
  { type: 'fraction', label: 'كسر' },
  { type: 'fines', label: 'غرامات' },
  { type: 'documents', label: 'خصم اوراق' },
] as const;

const SINGLE_HEADERS_AR = ['كود الموظف', 'اسم الموظف', 'الوظيفة', 'قيمة الخصم', 'ملاحظات'];
const SINGLE_HEADERS_EN = ['employee_code', 'employee_name', 'employee_position', 'amount', 'note'];

async function workbookToBase64(workbook: ExcelJS.Workbook): Promise<string> {
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

function parseDay(raw?: string | Date): Date {
  if (raw instanceof Date) return new Date(`${raw.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (raw && String(raw).trim()) {
    const d = new Date(String(raw).slice(0, 10));
    if (!Number.isNaN(d.getTime())) return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
  }
  const now = new Date();
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

export async function resolveEmployeesForDevice(deviceId?: string | null) {
  if (!deviceId) {
    return prisma.employeeProfile.findMany({
      where: { active: true },
      include: { department: true, mapping: true },
      orderBy: { name: 'asc' },
    });
  }

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device?.serialNumber) {
    return prisma.employeeProfile.findMany({
      where: { active: true },
      include: { department: true, mapping: true },
      orderBy: { name: 'asc' },
    });
  }

  const transactions = await prisma.transaction.findMany({
    where: { terminalSn: device.serialNumber },
    select: { empCode: true },
    take: 5000,
  });
  const codes = [...new Set(transactions.map((t) => t.empCode).filter(Boolean))] as string[];
  if (!codes.length) return [];

  const mappings = await prisma.employeeMapping.findMany({
    where: { biotimeEmpCode: { in: codes } },
    include: { employee: { include: { department: true, mapping: true } } },
  });
  const fromMapping = mappings.map((m) => m.employee).filter((e) => e?.active);
  const mappedIds = new Set(fromMapping.map((e) => e!.id));

  const byCode = await prisma.employeeProfile.findMany({
    where: { code: { in: codes }, active: true },
    include: { department: true, mapping: true },
  });

  const merged = [...fromMapping.filter(Boolean) as NonNullable<typeof fromMapping[number]>[]];
  for (const e of byCode) {
    if (!mappedIds.has(e.id)) merged.push(e);
  }
  merged.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return merged;
}

export async function resolveEmployeeByCode(code: string) {
  const trimmed = code.trim();
  if (!trimmed) return null;

  const byCode = await prisma.employeeProfile.findFirst({
    where: { code: trimmed },
  });
  if (byCode) return byCode;

  const mapping = await prisma.employeeMapping.findFirst({
    where: { biotimeEmpCode: trimmed },
    include: { employee: true },
  });
  return mapping?.employee ?? null;
}

/** ExcelJS may return `{ formula, result }` — use cached result for import amounts. */
function unwrapExcelCell(v: unknown): unknown {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  if ('result' in o) return unwrapExcelCell(o.result);
  if (Array.isArray(o.richText)) {
    return (o.richText as { text?: string }[]).map((t) => t.text ?? '').join('');
  }
  if (typeof o.text === 'string' && !('formula' in o)) return o.text;
  // Formula without cached result — skip (treat as empty).
  if ('formula' in o) return null;
  return v;
}

/** Parse amount cells including Excel formula results and comma-formatted strings. */
export function parseExcelAmount(v: unknown): number {
  const raw = unwrapExcelCell(v);
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'string') {
    const n = Number(raw.replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Odoo float_round(total/count, 2); last line gets remainder so sum equals total. */
export function equalSplitAmounts(count: number, total: number): number[] {
  if (count <= 0 || !(total > 0)) return [];
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const perPerson = round2(total / count);
  const amounts: number[] = [];
  let remaining = total;
  for (let index = 0; index < count; index++) {
    if (index === count - 1) {
      amounts.push(round2(remaining));
    } else {
      amounts.push(perPerson);
      remaining = round2(remaining - perPerson);
    }
  }
  return amounts;
}

/** Accept legacy `locationId` or `locationIds[]`; require ≥1 unique id. */
export function normalizeDeductionLocationIds(params: {
  locationId?: string | null;
  locationIds?: unknown;
}): string[] {
  const ids: string[] = [];
  if (Array.isArray(params.locationIds)) {
    for (const raw of params.locationIds) {
      const id = String(raw ?? '').trim();
      if (id) ids.push(id);
    }
  }
  const single = String(params.locationId ?? '').trim();
  if (single) ids.push(single);
  return [...new Set(ids)];
}

async function resolveDeductionLocations(locationIds: string[]) {
  if (!locationIds.length) {
    throw new AppError('اختر فرعاً واحداً على الأقل', 400, 'VALIDATION_ERROR');
  }
  const locs = await prisma.location.findMany({
    where: { id: { in: locationIds } },
    select: { id: true, name: true },
  });
  if (locs.length !== locationIds.length) {
    throw new AppError('أحد الفروع غير موجود', 404, 'NOT_FOUND');
  }
  const byId = new Map(locs.map((l) => [l.id, l]));
  const ordered = locationIds.map((id) => byId.get(id)!);
  const scopeLabel =
    ordered.length === 1
      ? ordered[0]!.name
      : `${ordered[0]!.name}+${ordered.length - 1}`;
  return { locs: ordered, scopeLabel };
}

function punchPeriodBounds(
  dateFrom?: string | null,
  dateTo?: string | null,
): { from: Date; to: Date; fromStr: string; toStr: string } | null {
  const fromStr = dateFrom ? String(dateFrom).trim().slice(0, 10) : '';
  const toStr = dateTo ? String(dateTo).trim().slice(0, 10) : '';
  if (!fromStr || !toStr) return null;
  const from = new Date(`${fromStr}T00:00:00.000Z`);
  const to = new Date(`${toStr}T23:59:59.999Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError('تواريخ فترة البصمة غير صالحة', 400, 'VALIDATION_ERROR');
  }
  if (from > to) {
    throw new AppError(
      'تاريخ بداية الفترة يجب أن يكون قبل أو يساوي تاريخ النهاية',
      400,
      'VALIDATION_ERROR',
    );
  }
  return { from, to, fromStr, toStr };
}

function requirePunchPeriod(dateFrom?: string | null, dateTo?: string | null) {
  const bounds = punchPeriodBounds(dateFrom, dateTo);
  if (!bounds) {
    throw new AppError('يرجى تحديد فترة البصمة (من / إلى)', 400, 'VALIDATION_ERROR');
  }
  return bounds;
}

function employeePunchCodes(emp: {
  code?: string | null;
  identificationId?: string | null;
  mapping?: { biotimeEmpCode?: string | null } | null;
}): string[] {
  const codes = new Set<string>();
  for (const c of [emp.code, emp.identificationId, emp.mapping?.biotimeEmpCode]) {
    const t = String(c ?? '').trim();
    if (t) codes.add(t);
  }
  return [...codes];
}

async function employeeIdsWithPunchInPeriod(
  employees: Array<{
    id: string;
    code?: string | null;
    identificationId?: string | null;
    mapping?: { biotimeEmpCode?: string | null } | null;
  }>,
  dateFrom: Date,
  dateTo: Date,
): Promise<Set<string>> {
  const punched = new Set<string>();
  if (!employees.length) return punched;

  const ids = employees.map((e) => e.id);
  const codeToIds = new Map<string, string[]>();
  for (const emp of employees) {
    for (const code of employeePunchCodes(emp)) {
      const list = codeToIds.get(code) ?? [];
      list.push(emp.id);
      codeToIds.set(code, list);
    }
  }

  const byEmp = await prisma.transaction.findMany({
    where: {
      punchTime: { gte: dateFrom, lte: dateTo },
      isDuplicate: false,
      employeeId: { in: ids },
    },
    select: { employeeId: true },
    distinct: ['employeeId'],
  });
  for (const t of byEmp) {
    if (t.employeeId) punched.add(t.employeeId);
  }

  const remainingCodes: string[] = [];
  for (const emp of employees) {
    if (punched.has(emp.id)) continue;
    for (const code of employeePunchCodes(emp)) remainingCodes.push(code);
  }
  const uniqueCodes = [...new Set(remainingCodes)];
  if (!uniqueCodes.length) return punched;

  // Chunk large IN lists
  const chunkSize = 800;
  for (let i = 0; i < uniqueCodes.length; i += chunkSize) {
    const chunk = uniqueCodes.slice(i, i + chunkSize);
    const byCode = await prisma.transaction.findMany({
      where: {
        punchTime: { gte: dateFrom, lte: dateTo },
        isDuplicate: false,
        empCode: { in: chunk },
      },
      select: { empCode: true },
      distinct: ['empCode'],
    });
    for (const t of byCode) {
      const code = String(t.empCode ?? '').trim();
      for (const id of codeToIds.get(code) ?? []) punched.add(id);
    }
  }
  return punched;
}

/** Accept legacy `jobTitle` or `jobTitles[]`; empty = all jobs in scope. */
export function normalizeDeductionJobTitles(params: {
  jobTitle?: string | null;
  jobTitles?: unknown;
}): string[] {
  const titles: string[] = [];
  const push = (raw: unknown) => {
    const t = String(raw ?? '').trim();
    if (t && t !== 'null' && t !== 'undefined') titles.push(t);
  };
  const addMany = (raw: unknown) => {
    if (raw == null) return;
    if (Array.isArray(raw)) {
      raw.forEach(addMany);
      return;
    }
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s) return;
      if (s.startsWith('[')) {
        try {
          addMany(JSON.parse(s));
          return;
        } catch {
          /* fall through */
        }
      }
      s.split(/[,،]/).map((p) => p.trim()).filter(Boolean).forEach(push);
      return;
    }
    if (typeof raw === 'object') {
      Object.values(raw as Record<string, unknown>).forEach(addMany);
    }
  };
  addMany(params.jobTitles);
  push(params.jobTitle);
  return [...new Set(titles)];
}

export async function employeesForDeductionScope(params: {
  /** Legacy single location — normalized with locationIds. */
  locationId?: string | null;
  locationIds?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  jobTitle?: string | null;
  jobTitles?: string[] | null;
  /** Default true to match Odoo (active + archived at location). */
  includeInactive?: boolean;
}) {
  const locationIds = normalizeDeductionLocationIds(params);
  if (!locationIds.length) {
    throw new AppError('اختر فرعاً واحداً على الأقل', 400, 'VALIDATION_ERROR');
  }

  const includeInactive = params.includeInactive !== false;
  const where: {
    locationId: { in: string[] };
    active?: boolean;
    OR: Array<{ code: { not: null } } | { identificationId: { not: null } }>;
  } = {
    locationId: { in: locationIds },
    OR: [{ code: { not: null } }, { identificationId: { not: null } }],
  };
  if (!includeInactive) where.active = true;

  let employees = await prisma.employeeProfile.findMany({
    where,
    include: { department: true, mapping: true },
    orderBy: [{ name: 'asc' }, { code: 'asc' }],
  });

  const jobTitles = normalizeDeductionJobTitles(params);
  if (jobTitles.length) {
    const lowered = new Set(jobTitles.map((t) => t.toLowerCase()));
    employees = employees.filter((e) =>
      lowered.has((e.jobTitle ?? '').trim().toLowerCase()),
    );
  }

  const period = punchPeriodBounds(params.dateFrom, params.dateTo);
  if (period) {
    const punched = await employeeIdsWithPunchInPeriod(employees, period.from, period.to);
    employees = employees.filter((e) => punched.has(e.id));
  }

  return employees;
}

export async function jobTitlesForDeductionScope(params: {
  locationId?: string | null;
  locationIds?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<string[]> {
  const employees = await employeesForDeductionScope({
    locationId: params.locationId,
    locationIds: params.locationIds,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    includeInactive: true,
  });
  const titles = new Set<string>();
  for (const e of employees) {
    const t = (e.jobTitle ?? '').trim();
    if (t) titles.add(t);
  }
  return [...titles].sort((a, b) => a.localeCompare(b, 'ar'));
}

async function deviceIdForEmployee(employeeId: string): Promise<string | null> {
  const last = await prisma.transaction.findFirst({
    where: {
      employeeId,
      terminalSn: { not: null },
      isDuplicate: false,
    },
    orderBy: { punchTime: 'desc' },
    select: { terminalSn: true },
  });
  let sn = last?.terminalSn?.trim() ?? '';
  if (!sn) {
    const emp = await prisma.employeeProfile.findUnique({
      where: { id: employeeId },
      include: { mapping: true },
    });
    if (!emp) return null;
    const codes = employeePunchCodes(emp);
    if (!codes.length) return null;
    const byCode = await prisma.transaction.findFirst({
      where: {
        empCode: { in: codes },
        terminalSn: { not: null },
        isDuplicate: false,
      },
      orderBy: { punchTime: 'desc' },
      select: { terminalSn: true },
    });
    sn = byCode?.terminalSn?.trim() ?? '';
  }
  if (!sn) return null;
  const device = await prisma.device.findFirst({
    where: { serialNumber: sn },
    select: { id: true },
  });
  return device?.id ?? null;
}

function importSkipNoPunch(code: string, dateFrom: string, dateTo: string) {
  return `${code} — ملوش بصمة في الفترة (${dateFrom} → ${dateTo})`;
}

function importSkipEmployeeNotFound(code: string) {
  return `${code} — كود موظف غير موجود في النظام`;
}

function headerStyle(): Partial<ExcelJS.Style> {
  return {
    font: { bold: true, size: 11 },
    alignment: { horizontal: 'center', vertical: 'middle' },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4CCCC' } },
    border: {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    },
  };
}

function cellStyle(): Partial<ExcelJS.Style> {
  return {
    font: { size: 10 },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    },
  };
}

export async function exportDeductionTemplate(params: {
  deductionType: string;
  deviceId?: string | null;
  date?: string;
}): Promise<string> {
  if (!DEDUCTION_TYPE_FIELD[params.deductionType]) {
    throw new AppError('نوع الخصم غير مدعوم', 400, 'VALIDATION_ERROR');
  }

  const typeLabel = DEDUCTION_TYPES.find((t) => t.value === params.deductionType)?.label ?? params.deductionType;
  const device = params.deviceId
    ? await prisma.device.findUnique({ where: { id: params.deviceId }, include: { location: true } })
    : null;
  const employees = await resolveEmployeesForDevice(params.deviceId);
  const locationLabel = device?.location?.name ?? device?.name ?? device?.alias ?? 'الكل';

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Deductions');
  sheet.views = [{ rightToLeft: true }];

  sheet.mergeCells(1, 1, 1, 5);
  sheet.getCell(1, 1).value = `قالب ${typeLabel} - ${locationLabel}`;
  Object.assign(sheet.getCell(1, 1), { style: headerStyle() });

  SINGLE_HEADERS_AR.forEach((h, i) => {
    const cell = sheet.getCell(2, i + 1);
    cell.value = h;
    Object.assign(cell, { style: headerStyle() });
  });
  SINGLE_HEADERS_EN.forEach((h, i) => {
    const cell = sheet.getCell(3, i + 1);
    cell.value = h;
    Object.assign(cell, { style: headerStyle() });
  });

  let row = 4;
  for (const emp of employees) {
    const position = emp.department?.name ?? '';
    sheet.getCell(row, 1).value = emp.code ?? emp.mapping?.biotimeEmpCode ?? '';
    sheet.getCell(row, 2).value = emp.name ?? '';
    sheet.getCell(row, 3).value = position;
    sheet.getCell(row, 4).value = 0;
    sheet.getCell(row, 5).value = '';
    for (let c = 1; c <= 5; c++) Object.assign(sheet.getCell(row, c), { style: cellStyle() });
    row++;
  }

  sheet.columns = [{ width: 15 }, { width: 30 }, { width: 25 }, { width: 18 }, { width: 30 }];
  return workbookToBase64(workbook);
}

export async function exportDeductionMultiTemplate(params: {
  deviceId?: string | null;
  date?: string;
}): Promise<string> {
  const device = params.deviceId
    ? await prisma.device.findUnique({ where: { id: params.deviceId } })
    : null;
  const employees = await resolveEmployeesForDevice(params.deviceId);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Deductions');
  sheet.views = [{ rightToLeft: true }];

  const arabicHeaders = ['كود الموظف', 'اسم الموظف', 'الوظيفة', ...MULTI_IMPORT_TYPES.map((t) => t.label)];
  const englishHeaders = ['employee_code', 'employee_name', 'employee_position', ...MULTI_IMPORT_TYPES.map((t) => t.type)];

  arabicHeaders.forEach((h, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = h;
    Object.assign(cell, { style: headerStyle() });
  });
  englishHeaders.forEach((h, i) => {
    const cell = sheet.getCell(2, i + 1);
    cell.value = h;
    Object.assign(cell, { style: headerStyle() });
  });

  let row = 3;
  for (const emp of employees) {
    const position = emp.department?.name ?? '';
    sheet.getCell(row, 1).value = emp.code ?? emp.mapping?.biotimeEmpCode ?? '';
    sheet.getCell(row, 2).value = emp.name ?? '';
    sheet.getCell(row, 3).value = position;
    for (let c = 0; c < MULTI_IMPORT_TYPES.length; c++) {
      sheet.getCell(row, 4 + c).value = 0;
    }
    for (let c = 1; c <= englishHeaders.length; c++) {
      Object.assign(sheet.getCell(row, c), { style: cellStyle() });
    }
    row++;
  }

  const widths = [15, 30, 25, ...MULTI_IMPORT_TYPES.map(() => 18)];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

  void device;
  return workbookToBase64(workbook);
}

type SkippedRow = { code: string; reason: string };

function findHeaderRow(rows: unknown[][]): { headerIdx: number; header: string[] } {
  for (let idx = 0; idx < Math.min(rows.length, 8); idx++) {
    const row = rows[idx];
    if (!row) continue;
    const header = row.map((c) => {
      if (typeof c === 'string') return c.trim().toLowerCase();
      if (c && typeof c === 'object' && 'text' in (c as object)) {
        return String((c as { text?: unknown }).text ?? '').trim().toLowerCase();
      }
      return String(c ?? '').trim().toLowerCase();
    });
    if (
      header.includes('employee_code')
      || header.includes('كود الموظف')
      || header.some((h) => h.includes('employee_code') || h.includes('كود الموظف'))
    ) {
      return { headerIdx: idx, header };
    }
  }
  throw new AppError('لم يتم العثور على صف العناوين (employee_code)', 400, 'IMPORT_ERROR');
}

export async function loadSheetRows(base64: string): Promise<unknown[][]> {
  const raw = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(raw as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new AppError('الملف فارغ', 400, 'IMPORT_ERROR');

  const rows: unknown[][] = [];
  sheet.eachRow((row) => {
    rows.push(row.values ? (row.values as unknown[]).slice(1) : []);
  });
  return rows;
}

export async function importDeductionXlsx(params: {
  base64: string;
  deductionType: string;
  deviceId?: string | null;
  date?: string;
}): Promise<{ created: number; skipped: SkippedRow[]; message: string }> {
  if (!DEDUCTION_TYPE_FIELD[params.deductionType]) {
    throw new AppError('نوع الخصم غير مدعوم', 400, 'VALIDATION_ERROR');
  }

  const rows = await loadSheetRows(params.base64);
  const { headerIdx, header } = findHeaderRow(rows);
  const codeCol = header.indexOf('employee_code');
  const amountCol = header.indexOf('amount');
  if (codeCol < 0 || amountCol < 0) {
    throw new AppError('الملف لازم يحتوي على employee_code و amount', 400, 'IMPORT_ERROR');
  }
  const noteCol = header.indexOf('note');

  const dedDate = parseDay(params.date);
  let created = 0;
  const skipped: SkippedRow[] = [];

  for (const row of rows.slice(headerIdx + 1)) {
    if (!row || row[codeCol] == null || row[codeCol] === '') continue;
    const code = String(row[codeCol]).trim();
    const amt = parseExcelAmount(row[amountCol]);
    if (!Number.isFinite(amt) || amt <= 0) continue;

    const employee = await resolveEmployeeByCode(code);
    if (!employee) {
      skipped.push({ code, reason: 'موظف غير موجود' });
      continue;
    }

    const note = noteCol >= 0 && row[noteCol] ? String(row[noteCol]).trim() : '';
    const reference = await nextDeductionReference(dedDate);

    await prisma.deduction.create({
      data: {
        reference,
        employeeId: employee.id,
        type: params.deductionType,
        amount: amt,
        date: dedDate,
        deviceId: params.deviceId ?? null,
        notes: note || null,
        state: 'draft',
      },
    });
    created++;
  }

  const message = `تم إنشاء ${created} خصم.${skipped.length ? ` تم تخطي ${skipped.length}.` : ''}`;
  return { created, skipped, message };
}

export async function importDeductionMultiXlsx(params: {
  base64: string;
  deviceId?: string | null;
  date?: string;
}): Promise<{ created: number; skipped: SkippedRow[]; message: string }> {
  const rows = await loadSheetRows(params.base64);
  const { headerIdx, header } = findHeaderRow(rows);
  const codeCol = header.indexOf('employee_code');
  if (codeCol < 0) throw new AppError('العمود employee_code غير موجود', 400, 'IMPORT_ERROR');

  const typeColMap = new Map<string, number>();
  for (const { type } of MULTI_IMPORT_TYPES) {
    const col = header.indexOf(type);
    if (col >= 0) typeColMap.set(type, col);
  }
  if (!typeColMap.size) {
    throw new AppError('لم يتم العثور على أي عمود خصم معروف', 400, 'IMPORT_ERROR');
  }

  const dedDate = parseDay(params.date);
  let created = 0;
  const skipped: SkippedRow[] = [];

  for (const row of rows.slice(headerIdx + 1)) {
    if (!row || row[codeCol] == null || row[codeCol] === '') continue;
    const code = String(row[codeCol]).trim();
    if (!code) continue;

    const employee = await resolveEmployeeByCode(code);
    if (!employee) {
      skipped.push({ code, reason: 'موظف غير موجود' });
      continue;
    }

    for (const [type, col] of typeColMap) {
      if (col >= row.length) continue;
      const rawVal = row[col];
      let amt = 0;
      try {
        amt = rawVal != null && rawVal !== '' ? Number(rawVal) : 0;
      } catch {
        continue;
      }
      if (!Number.isFinite(amt) || amt <= 0) continue;

      const reference = await nextDeductionReference(dedDate);
      await prisma.deduction.create({
        data: {
          reference,
          employeeId: employee.id,
          type,
          amount: amt,
          date: dedDate,
          deviceId: params.deviceId ?? null,
          state: 'draft',
        },
      });
      created++;
    }
  }

  const message =
    `تم إنشاء ${created} سجل خصم معلّق.` +
    (skipped.length ? ` تم تخطي ${skipped.length} موظف.` : '') +
    ' عند حساب كشف الرواتب ستُطبَّق هذه الخصومات تلقائياً.';
  return { created, skipped, message };
}

function sheetDataValidations(sheet: ExcelJS.Worksheet) {
  return (sheet as ExcelJS.Worksheet & {
    dataValidations: { add: (address: string, validation: Record<string, unknown>) => void };
  }).dataValidations;
}

function deductionTypeFromLabel(raw: string): string | null {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return null;
  const byValue = DEDUCTION_TYPES.find((d) => d.value.toLowerCase() === t);
  if (byValue) return byValue.value;
  const byLabel = DEDUCTION_TYPES.find((d) => d.label.toLowerCase() === t);
  return byLabel?.value ?? null;
}

/**
 * Location template (Odoo-parity):
 * - With deductionType → single-type columns (code, name, position, amount, note)
 * - Without deductionType → legacy branch sheet with type dropdown
 * Optional dateFrom/dateTo filters to employees with ≥1 punch in period.
 * Without period: all at location(s) (incl. inactive), matching Odoo.
 * Multi-branch = combined employee pool across selected locations.
 */
export async function exportDeductionBranchTemplate(params: {
  locationId?: string | null;
  locationIds?: string[] | null;
  deductionType?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  jobTitle?: string | null;
  jobTitles?: string[] | null;
  date?: string;
}): Promise<{ base64: string; filename: string; count: number }> {
  const locationIds = normalizeDeductionLocationIds(params);
  const { locs, scopeLabel } = await resolveDeductionLocations(locationIds);

  const deductionType = params.deductionType?.trim();
  if (deductionType && !DEDUCTION_TYPE_FIELD[deductionType]) {
    throw new AppError('نوع الخصم غير مدعوم', 400, 'VALIDATION_ERROR');
  }

  const employees = await employeesForDeductionScope({
    locationIds,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    jobTitle: params.jobTitle,
    jobTitles: params.jobTitles,
    includeInactive: true,
  });

  const period = punchPeriodBounds(params.dateFrom, params.dateTo);
  const periodLabel = period ? `${period.fromStr} → ${period.toStr}` : 'كل الموظفين';
  if (!employees.length) {
    const jobTitles = normalizeDeductionJobTitles(params);
    const jobHint = jobTitles.length
      ? ` للوظائف: ${jobTitles.slice(0, 3).join('، ')}${jobTitles.length > 3 ? '…' : ''}`
      : '';
    throw new AppError(
      `لم يتم العثور على موظفين للتصدير (${scopeLabel} — ${periodLabel})${jobHint}`,
      400,
      'VALIDATION_ERROR',
    );
  }

  const workbook = new ExcelJS.Workbook();
  const typeLabel = deductionType
    ? (DEDUCTION_TYPES.find((t) => t.value === deductionType)?.label ?? deductionType)
    : 'استقطاعات';

  if (deductionType) {
    // Odoo single-type export
    const sheet = workbook.addWorksheet('Deductions');
    sheet.views = [{ rightToLeft: true }];
    sheet.mergeCells(1, 1, 1, 5);
    sheet.getCell(1, 1).value = `قالب ${typeLabel} - ${scopeLabel} (${periodLabel})`;
    Object.assign(sheet.getCell(1, 1), { style: headerStyle() });

    SINGLE_HEADERS_AR.forEach((h, i) => {
      const cell = sheet.getCell(2, i + 1);
      cell.value = h;
      Object.assign(cell, { style: headerStyle() });
    });
    SINGLE_HEADERS_EN.forEach((h, i) => {
      const cell = sheet.getCell(3, i + 1);
      cell.value = h;
      Object.assign(cell, { style: headerStyle() });
    });

    let row = 4;
    for (const emp of employees) {
      sheet.getCell(row, 1).value = emp.code ?? emp.mapping?.biotimeEmpCode ?? emp.identificationId ?? '';
      sheet.getCell(row, 2).value = emp.name ?? '';
      sheet.getCell(row, 3).value = emp.jobTitle ?? emp.department?.name ?? '';
      sheet.getCell(row, 4).value = 0;
      sheet.getCell(row, 5).value = '';
      for (let c = 1; c <= 5; c++) Object.assign(sheet.getCell(row, c), { style: cellStyle() });
      row++;
    }
    sheet.columns = [{ width: 15 }, { width: 30 }, { width: 25 }, { width: 18 }, { width: 30 }];
  } else {
    // Legacy multi-type dropdown sheet
    const sheet = workbook.addWorksheet('استقطاعات');
    sheet.views = [{ rightToLeft: true }];

    sheet.mergeCells(1, 1, 1, 6);
    sheet.getCell(1, 1).value = `قالب استقطاعات — ${scopeLabel} (${periodLabel})`;
    Object.assign(sheet.getCell(1, 1), { style: headerStyle() });

    const headersAr = ['كود الموظف', 'اسم الموظف', 'الوظيفة', 'نوع الخصم', 'قيمة الخصم', 'ملاحظات'];
    const headersEn = ['employee_code', 'employee_name', 'employee_position', 'deduction_type', 'amount', 'note'];
    headersAr.forEach((h, i) => {
      const cell = sheet.getCell(2, i + 1);
      cell.value = h;
      Object.assign(cell, { style: headerStyle() });
    });
    headersEn.forEach((h, i) => {
      const cell = sheet.getCell(3, i + 1);
      cell.value = h;
      Object.assign(cell, { style: headerStyle() });
    });

    let row = 4;
    for (const emp of employees) {
      sheet.getCell(row, 1).value = emp.code ?? emp.mapping?.biotimeEmpCode ?? emp.identificationId ?? '';
      sheet.getCell(row, 2).value = emp.name ?? '';
      sheet.getCell(row, 3).value = emp.jobTitle ?? emp.department?.name ?? '';
      sheet.getCell(row, 4).value = '';
      sheet.getCell(row, 5).value = '';
      sheet.getCell(row, 6).value = '';
      for (let c = 1; c <= 6; c++) Object.assign(sheet.getCell(row, c), { style: cellStyle() });
      row++;
    }

    const lastDataRow = Math.max(row - 1, 4);
    const labelList = DEDUCTION_TYPES.map((t) => t.label.replace(/"/g, '')).join(',');
    sheetDataValidations(sheet).add(`D4:D${lastDataRow}`, {
      type: 'list',
      allowBlank: true,
      formulae: [`"${labelList}"`],
      showErrorMessage: true,
      errorTitle: 'نوع الخصم',
      error: 'اختر نوع خصم من القائمة',
      showInputMessage: true,
      promptTitle: 'نوع الخصم',
      prompt: 'اختَر من القائمة المنسدلة',
    });

    [16, 28, 18, 18, 14, 24].forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });

    const help = workbook.addWorksheet('تعليمات');
    help.views = [{ rightToLeft: true }];
    help.getColumn(1).width = 80;
    [
      'تعليمات استيراد الاستقطاعات',
      '',
      '1) املأ فقط الصفوف المطلوبة: نوع الخصم + قيمة الخصم.',
      '2) نوع الخصم من القائمة المنسدلة فقط.',
      '3) الصفوف ذات المبلغ الفارغ أو الصفر لن تُنشأ.',
      '4) بعد التعبئة: استيراد → معاينة → تأكيد.',
      '5) الاستيراد يتطلب فترة بصمة (من / إلى).',
      locs.length > 1
        ? `6) هذا القالب يشمل ${locs.length} فروع: ${locs.map((l) => l.name).join('، ')}.`
        : '',
    ].filter(Boolean).forEach((t, i) => {
      help.getCell(i + 1, 1).value = t;
      if (i === 0) help.getCell(i + 1, 1).font = { bold: true, size: 13 };
    });
  }

  const day = (params.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const safeName = (locs[0]?.name || 'branch').replace(/[^\w\u0600-\u06FF-]+/g, '_').slice(0, 40);
  const multiSuffix = locs.length > 1 ? `_x${locs.length}` : '';
  const typeSlug = deductionType || 'all';
  return {
    base64: await workbookToBase64(workbook),
    filename: `deduction_${typeSlug}_${safeName}${multiSuffix}_${day}.xlsx`,
    count: employees.length,
  };
}

export type DeductionPreviewLine = {
  employeeCode: string;
  employeeName: string;
  employeeId: string | null;
  type: string;
  typeLabel: string;
  amount: number;
  note: string;
  ok: boolean;
  reason: string;
  selected: boolean;
};

async function loadDeductionBranchSheetRows(base64: string): Promise<unknown[][]> {
  const raw = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(raw as unknown as ExcelJS.Buffer);
  const preferred =
    workbook.worksheets.find((ws) => /استقطاع|deduction/i.test(ws.name) && !/تعليمات|instruction/i.test(ws.name))
    ?? workbook.worksheets.find((ws) => {
      let hit = false;
      ws.getRow(2).eachCell((cell) => {
        const v = String(cell.value ?? '').toLowerCase();
        if (v.includes('employee_code') || v.includes('كود')) hit = true;
      });
      ws.getRow(3).eachCell((cell) => {
        const v = String(cell.value ?? '').toLowerCase();
        if (v.includes('employee_code') || v.includes('كود')) hit = true;
      });
      return hit;
    })
    ?? workbook.worksheets[0];
  if (!preferred) throw new AppError('الملف فارغ', 400, 'IMPORT_ERROR');
  const rows: unknown[][] = [];
  preferred.eachRow((row) => {
    rows.push(row.values ? (row.values as unknown[]).slice(1) : []);
  });
  return rows;
}

export async function previewDeductionBranchXlsx(params: {
  base64: string;
  locationId?: string | null;
  locationIds?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** When set (Odoo single-type sheet without deduction_type column), apply this type to all rows. */
  deductionType?: string | null;
}): Promise<{ lines: DeductionPreviewLine[]; skipped: SkippedRow[]; countOk: number }> {
  const period = requirePunchPeriod(params.dateFrom, params.dateTo);
  const locationIds = normalizeDeductionLocationIds(params);
  const locationIdSet = new Set(locationIds);

  let punchedIds: Set<string> | null = null;
  if (locationIds.length) {
    const scopeEmps = await employeesForDeductionScope({
      locationIds,
      dateFrom: period.fromStr,
      dateTo: period.toStr,
      includeInactive: true,
    });
    punchedIds = new Set(scopeEmps.map((e) => e.id));
  }

  const fixedType = params.deductionType?.trim() || '';
  if (fixedType && !DEDUCTION_TYPE_FIELD[fixedType]) {
    throw new AppError('نوع الخصم غير مدعوم', 400, 'VALIDATION_ERROR');
  }

  const rows = await loadDeductionBranchSheetRows(params.base64);
  const { headerIdx, header } = findHeaderRow(rows);

  const codeCol = Math.max(
    header.indexOf('employee_code'),
    header.findIndex((h) => h.includes('employee_code') || h === 'كود الموظف' || h.includes('كود الموظف')),
  );
  const nameCol = Math.max(
    header.indexOf('employee_name'),
    header.findIndex((h) => h.includes('employee_name') || h.includes('اسم')),
  );
  const typeCol = Math.max(
    header.indexOf('deduction_type'),
    header.indexOf('نوع الخصم'),
    header.findIndex((h) => h.includes('deduction_type') || h.includes('نوع الخصم') || h.includes('نوع')),
  );
  const amountCol = Math.max(
    header.indexOf('amount'),
    header.findIndex((h) => h === 'amount' || h.includes('قيمة الخصم') || h === 'المبلغ'),
  );
  const noteCol = Math.max(
    header.indexOf('note'),
    header.findIndex((h) => h === 'note' || h.includes('ملاحظات')),
  );

  if (codeCol < 0 || amountCol < 0) {
    throw new AppError('الملف لازم يحتوي على employee_code و amount', 400, 'IMPORT_ERROR');
  }
  if (!fixedType && typeCol < 0) {
    throw new AppError('الملف لازم يحتوي على عمود نوع الخصم (deduction_type) أو تمرير نوع الخصم', 400, 'IMPORT_ERROR');
  }

  const lines: DeductionPreviewLine[] = [];
  const skipped: SkippedRow[] = [];

  for (const row of rows.slice(headerIdx + 1)) {
    if (!row) continue;
    const code = String(row[codeCol] ?? '').trim();
    if (!code) continue;

    const amount = parseExcelAmount(row[amountCol]);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const typeRaw = fixedType || String(row[typeCol] ?? '').trim();
    const type = fixedType || deductionTypeFromLabel(typeRaw);
    const typeLabel = type
      ? (DEDUCTION_TYPES.find((d) => d.value === type)?.label ?? type)
      : typeRaw;

    const employee = await resolveEmployeeByCode(code);
    const note = noteCol >= 0 && row[noteCol] != null ? String(row[noteCol]).trim() : '';
    const name = nameCol >= 0 ? String(row[nameCol] ?? '').trim() : (employee?.name ?? '');

    if (!type || !DEDUCTION_TYPE_FIELD[type]) {
      lines.push({
        employeeCode: code,
        employeeName: name,
        employeeId: employee?.id ?? null,
        type: typeRaw || '',
        typeLabel,
        amount,
        note,
        ok: false,
        reason: 'نوع خصم غير معروف — اختَر من القائمة',
        selected: false,
      });
      skipped.push({ code, reason: 'نوع خصم غير معروف' });
      continue;
    }
    if (!employee) {
      const reason = importSkipEmployeeNotFound(code);
      lines.push({
        employeeCode: code,
        employeeName: name,
        employeeId: null,
        type,
        typeLabel,
        amount,
        note,
        ok: false,
        reason,
        selected: false,
      });
      skipped.push({ code, reason });
      continue;
    }

    if (locationIdSet.size && (!employee.locationId || !locationIdSet.has(employee.locationId))) {
      const reason = `${code} — الموظف ليس على المواقع المحددة نفسها`;
      lines.push({
        employeeCode: code,
        employeeName: employee.name || name,
        employeeId: employee.id,
        type,
        typeLabel,
        amount,
        note,
        ok: false,
        reason,
        selected: false,
      });
      skipped.push({ code, reason });
      continue;
    }

    // Punch gate (Odoo): ≥1 transaction in [dateFrom, dateTo]
    let hasPunch = false;
    if (punchedIds) {
      hasPunch = punchedIds.has(employee.id);
    } else {
      const mapping = await prisma.employeeMapping.findFirst({
        where: { employeeId: employee.id },
        select: { biotimeEmpCode: true },
      });
      const ids = await employeeIdsWithPunchInPeriod(
        [{
          id: employee.id,
          code: employee.code,
          identificationId: employee.identificationId,
          mapping,
        }],
        period.from,
        period.to,
      );
      hasPunch = ids.has(employee.id);
    }

    if (!hasPunch) {
      const reason = importSkipNoPunch(code, period.fromStr, period.toStr);
      lines.push({
        employeeCode: code,
        employeeName: employee.name || name,
        employeeId: employee.id,
        type,
        typeLabel,
        amount,
        note,
        ok: false,
        reason,
        selected: false,
      });
      skipped.push({ code, reason });
      continue;
    }

    lines.push({
      employeeCode: code,
      employeeName: employee.name || name,
      employeeId: employee.id,
      type,
      typeLabel,
      amount,
      note,
      ok: true,
      reason: '',
      selected: true,
    });
  }

  return {
    lines,
    skipped,
    countOk: lines.filter((l) => l.ok).length,
  };
}

export async function confirmDeductionBranchImport(params: {
  lines: Array<{
    employeeId: string;
    type: string;
    amount: number;
    note?: string;
  }>;
  date?: string;
  deviceId?: string | null;
}): Promise<{ created: number; message: string }> {
  const dedDate = parseDay(params.date);
  let created = 0;

  for (const line of params.lines) {
    if (!line.employeeId || !line.type || !(line.amount > 0)) continue;
    if (!DEDUCTION_TYPE_FIELD[line.type]) continue;
    const reference = await nextDeductionReference(dedDate);
    const deviceId =
      params.deviceId
      ?? (await deviceIdForEmployee(line.employeeId));
    await prisma.deduction.create({
      data: {
        reference,
        employeeId: line.employeeId,
        type: line.type,
        amount: line.amount,
        date: dedDate,
        deviceId,
        notes: line.note?.trim() || null,
        state: 'draft',
      },
    });
    created++;
  }

  return {
    created,
    message: `تم إنشاء ${created} استقطاع معلّق. ستُطبَّق عند ربط كشف الرواتب.`,
  };
}

export type DeductionDistributeLine = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  jobTitle: string;
  amount: number;
  note: string;
};

export async function previewDeductionDistribute(params: {
  locationId?: string | null;
  locationIds?: string[] | null;
  dateFrom: string;
  dateTo: string;
  deductionType: string;
  date?: string;
  totalAmount: number;
  jobTitle?: string | null;
  jobTitles?: string[] | null;
}): Promise<{
  lines: DeductionDistributeLine[];
  employeeCount: number;
  perPersonAmount: number;
  totalAmount: number;
  note: string;
}> {
  requirePunchPeriod(params.dateFrom, params.dateTo);
  const locationIds = normalizeDeductionLocationIds(params);
  const { scopeLabel } = await resolveDeductionLocations(locationIds);

  const deductionType = String(params.deductionType || '').trim();
  if (!DEDUCTION_TYPE_FIELD[deductionType]) {
    throw new AppError('نوع الخصم غير مدعوم', 400, 'VALIDATION_ERROR');
  }

  const totalAmount = Number(params.totalAmount);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new AppError('يرجى إدخال مبلغ إجمالي أكبر من صفر', 400, 'VALIDATION_ERROR');
  }

  const employees = await employeesForDeductionScope({
    locationIds,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    jobTitle: params.jobTitle,
    jobTitles: params.jobTitles,
    includeInactive: true,
  });

  if (!employees.length) {
    const jobTitles = normalizeDeductionJobTitles(params);
    const jobHint = jobTitles.length
      ? ` للوظائف: ${jobTitles.slice(0, 3).join('، ')}${jobTitles.length > 3 ? '…' : ''}`
      : '';
    throw new AppError(
      `لم يتم العثور على موظفين للنطاق «${scopeLabel}»${jobHint} لديهم بصمة في الفترة.`,
      400,
      'VALIDATION_ERROR',
    );
  }

  const typeLabel = DEDUCTION_TYPES.find((t) => t.value === deductionType)?.label ?? deductionType;
  const note = `توزيع ${typeLabel} — ${scopeLabel}`;
  const amounts = equalSplitAmounts(employees.length, totalAmount);
  const lines: DeductionDistributeLine[] = employees.map((emp, i) => ({
    employeeId: emp.id,
    employeeCode: emp.code ?? emp.mapping?.biotimeEmpCode ?? emp.identificationId ?? '',
    employeeName: emp.name ?? '',
    jobTitle: emp.jobTitle ?? emp.department?.name ?? '',
    amount: amounts[i] ?? 0,
    note,
  }));

  return {
    lines,
    employeeCount: lines.length,
    perPersonAmount: lines[0]?.amount ?? 0,
    totalAmount,
    note,
  };
}

/** Re-split total across the provided employee ids (after client deletes preview lines). */
export async function recalcDeductionDistribute(params: {
  employeeIds: string[];
  totalAmount: number;
  note?: string;
}): Promise<{ lines: Array<{ employeeId: string; amount: number; note: string }>; employeeCount: number }> {
  const totalAmount = Number(params.totalAmount);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new AppError('يرجى إدخال مبلغ إجمالي أكبر من صفر', 400, 'VALIDATION_ERROR');
  }
  const ids = [...new Set(params.employeeIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) throw new AppError('لا توجد سطور في المعاينة', 400, 'VALIDATION_ERROR');

  const employees = await prisma.employeeProfile.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  if (employees.length !== ids.length) {
    throw new AppError('بعض الموظفين غير موجودين', 400, 'VALIDATION_ERROR');
  }

  // Preserve caller order
  const amounts = equalSplitAmounts(ids.length, totalAmount);
  const note = params.note?.trim() || '';
  return {
    employeeCount: ids.length,
    lines: ids.map((employeeId, i) => ({
      employeeId,
      amount: amounts[i] ?? 0,
      note,
    })),
  };
}

export async function confirmDeductionDistribute(params: {
  locationId?: string | null;
  locationIds?: string[] | null;
  dateFrom: string;
  dateTo: string;
  deductionType: string;
  date?: string;
  totalAmount: number;
  jobTitle?: string | null;
  jobTitles?: string[] | null;
  lines: Array<{ employeeId: string; amount: number; note?: string }>;
  deviceId?: string | null;
}): Promise<{ created: number; message: string }> {
  requirePunchPeriod(params.dateFrom, params.dateTo);
  const locationIds = normalizeDeductionLocationIds(params);
  if (!locationIds.length) {
    throw new AppError('اختر فرعاً واحداً على الأقل', 400, 'VALIDATION_ERROR');
  }

  const deductionType = String(params.deductionType || '').trim();
  if (!DEDUCTION_TYPE_FIELD[deductionType]) {
    throw new AppError('نوع الخصم غير مدعوم', 400, 'VALIDATION_ERROR');
  }

  const totalAmount = Number(params.totalAmount);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new AppError('يرجى إدخال مبلغ إجمالي أكبر من صفر', 400, 'VALIDATION_ERROR');
  }

  const lines = (params.lines || []).filter((l) => l.employeeId && Number(l.amount) > 0);
  if (!lines.length) throw new AppError('لا توجد مبالغ للاعتماد', 400, 'VALIDATION_ERROR');

  const sum = Math.round(lines.reduce((s, l) => s + Number(l.amount), 0) * 100) / 100;
  if (Math.abs(sum - totalAmount) > 0.05) {
    throw new AppError(
      `مجموع السطور (${sum.toFixed(2)}) لا يساوي المبلغ الإجمالي (${totalAmount.toFixed(2)}).`,
      400,
      'VALIDATION_ERROR',
    );
  }

  // Re-validate employees still in scope (locations + punch)
  const scopeEmps = await employeesForDeductionScope({
    locationIds,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    jobTitle: params.jobTitle,
    jobTitles: params.jobTitles,
    includeInactive: true,
  });
  const scopeIds = new Set(scopeEmps.map((e) => e.id));
  for (const line of lines) {
    if (!scopeIds.has(line.employeeId)) {
      throw new AppError(
        'أحد الموظفين لم يعد ضمن نطاق المواقع/فترة البصمة. أعد حساب التوزيع.',
        400,
        'VALIDATION_ERROR',
      );
    }
  }

  const dedDate = parseDay(params.date);
  let created = 0;
  for (const line of lines) {
    const reference = await nextDeductionReference(dedDate);
    const deviceId =
      params.deviceId
      ?? (await deviceIdForEmployee(line.employeeId));
    await prisma.deduction.create({
      data: {
        reference,
        employeeId: line.employeeId,
        type: deductionType,
        amount: Number(line.amount),
        date: dedDate,
        deviceId,
        notes: line.note?.trim() || null,
        state: 'draft',
      },
    });
    created++;
  }

  return {
    created,
    message: `تم إنشاء ${created} خصم معلّق.`,
  };
}
