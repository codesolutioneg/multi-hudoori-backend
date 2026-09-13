import ExcelJS from 'exceljs';
import { prisma } from '../prisma/client';
import { locationJson } from './serialize.service';

const HEADERS = ['الاسم', 'الاسم الفعلي', 'الكود', 'نشط', 'الترتيب'];

export async function exportLocationsXlsx(): Promise<{
  base64: string;
  file: string;
  filename: string;
  mimeType: string;
}> {
  const locations = await prisma.location.findMany({ orderBy: [{ sequence: 'asc' }, { name: 'asc' }] });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('المواقع', { views: [{ rightToLeft: true }] });
  sheet.addRow(HEADERS);
  for (const loc of locations) {
    sheet.addRow([loc.name, loc.actualName ?? '', loc.code ?? '', loc.active ? 'نعم' : 'لا', loc.sequence]);
  }
  sheet.getRow(1).font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer as ArrayBuffer).toString('base64');
  // Same envelope as every other export (file + mimeType), so clients need no
  // special case for locations. base64 is kept for existing callers.
  return {
    base64,
    file: base64,
    filename: 'locations.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

function colIndex(headers: string[], names: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim().toLowerCase();
    if (names.some((n) => h === n.toLowerCase() || h.includes(n.toLowerCase()))) return i;
  }
  return -1;
}

export async function importLocationsXlsx(base64: string) {
  const buf = Buffer.from(base64, 'base64');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('ملف Excel فارغ');

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = String(cell.value ?? '').trim();
  });

  const nameCol = colIndex(headers, ['الاسم', 'name', 'location', 'موقع']);
  const actualNameCol = colIndex(headers, ['الاسم الفعلي', 'actual name', 'actualname']);
  const codeCol = colIndex(headers, ['الكود', 'code']);
  const activeCol = colIndex(headers, ['نشط', 'active']);
  const seqCol = colIndex(headers, ['الترتيب', 'sequence']);

  if (nameCol < 0) throw new Error('عمود الاسم غير موجود');

  const errors: string[] = [];
  let imported = 0;

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const name = String(row.getCell(nameCol + 1).value ?? '').trim();
    if (!name) continue;
    const code = codeCol >= 0 ? String(row.getCell(codeCol + 1).value ?? '').trim() : '';
    const activeRaw = activeCol >= 0 ? String(row.getCell(activeCol + 1).value ?? '').trim() : 'نعم';
    const active = !['لا', 'no', '0', 'false'].includes(activeRaw.toLowerCase());
    const sequence = seqCol >= 0 ? Number(row.getCell(seqCol + 1).value) || 10 : 10;
    const actualName = actualNameCol >= 0
      ? String(row.getCell(actualNameCol + 1).value ?? '').trim() || null
      : undefined;

    try {
      const existing = await prisma.location.findFirst({
        where: code
          ? { OR: [{ name: { equals: name, mode: 'insensitive' } }, { code: { equals: code, mode: 'insensitive' } }] }
          : { name: { equals: name, mode: 'insensitive' } },
      });
      if (existing) {
        await prisma.location.update({
          where: { id: existing.id },
          data: { name, actualName: actualName ?? existing.actualName, code: code || null, active, sequence },
        });
      } else {
        await prisma.location.create({
          data: { name, actualName: actualName ?? null, code: code || null, active, sequence },
        });
      }
      imported++;
    } catch (e) {
      errors.push(`صف ${r}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const locations = await prisma.location.findMany({ orderBy: [{ sequence: 'asc' }, { name: 'asc' }] });
  return {
    message: `تم استيراد/تحديث ${imported} موقع`,
    imported,
    errors,
    locations: locations.map(locationJson),
  };
}
