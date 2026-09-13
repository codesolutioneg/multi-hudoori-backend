/**
 * One workbook shape for every HR compliance report: title, the filters that
 * produced it, a header row, then the rows. Writing the filters into the sheet
 * matters because these get forwarded by email, and a list of names with no
 * record of what was asked for is impossible to interpret later.
 */
import ExcelJS from 'exceljs';

const TITLE_FILL = 'FF4472C4';
const HEADER_FILL = 'FFD9E2F3';
const ALERT_FILL = 'FFFFC7CE';
const ALERT_FONT = 'FF9C0006';

export type ReportSheet = {
  title: string;
  /** Human-readable description of the options used, one per line. */
  criteria: string[];
  headers: readonly string[];
  rows: (string | number)[][];
  /** Row indexes (0-based, into rows) to highlight as problems. */
  alertRows?: Set<number>;
  emptyMessage?: string;
};

export type ReportFile = {
  base64: string;
  file: string;
  filename: string;
  mimeType: string;
  rowCount: number;
};

function autoFitColumns(sheet: ExcelJS.Worksheet, headers: readonly string[]): void {
  headers.forEach((header, i) => {
    const column = sheet.getColumn(i + 1);
    let widest = String(header).length;
    column.eachCell({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? '').length;
      if (len > widest) widest = len;
    });
    column.width = Math.min(46, Math.max(12, widest + 2));
  });
}

export async function buildReportWorkbook(
  sheets: ReportSheet[],
  filenamePrefix: string,
  options?: { filename?: string },
): Promise<ReportFile> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hudoori';
  let rowCount = 0;

  for (const spec of sheets) {
    // Excel rejects sheet names over 31 chars and the characters in this class.
    const safeName = spec.title.replace(/[*?:\\/[\]]/g, ' ').slice(0, 31);
    const sheet = workbook.addWorksheet(safeName, { views: [{ rightToLeft: true }] });
    const colCount = Math.max(1, spec.headers.length);

    sheet.mergeCells(1, 1, 1, colCount);
    const title = sheet.getCell(1, 1);
    title.value = spec.title;
    title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_FILL } };
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 26;

    let row = 2;
    for (const line of spec.criteria) {
      sheet.mergeCells(row, 1, row, colCount);
      const cell = sheet.getCell(row, 1);
      cell.value = line;
      cell.font = { size: 10, italic: true };
      cell.alignment = { horizontal: 'right' };
      row++;
    }
    row++;

    const headerRow = row;
    spec.headers.forEach((header, i) => {
      const cell = sheet.getCell(headerRow, i + 1);
      cell.value = header;
      cell.font = { bold: true, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    sheet.getRow(headerRow).height = 28;
    row++;

    if (spec.rows.length === 0) {
      sheet.mergeCells(row, 1, row, colCount);
      sheet.getCell(row, 1).value = spec.emptyMessage ?? 'لا توجد نتائج';
      sheet.getCell(row, 1).alignment = { horizontal: 'center' };
    }

    spec.rows.forEach((values, index) => {
      const isAlert = spec.alertRows?.has(index) ?? false;
      values.forEach((value, i) => {
        const cell = sheet.getCell(row, i + 1);
        cell.value = value;
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        if (isAlert) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ALERT_FILL } };
          cell.font = { size: 10, color: { argb: ALERT_FONT } };
        } else {
          cell.font = { size: 10 };
        }
      });
      row++;
    });

    sheet.views = [{ rightToLeft: true, state: 'frozen', ySplit: headerRow }];
    autoFitColumns(sheet, spec.headers);
    rowCount += spec.rows.length;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer as ArrayBuffer).toString('base64');
  const filename = options?.filename?.trim() || `${filenamePrefix}.xlsx`;
  return {
    base64,
    file: base64,
    filename: filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    rowCount,
  };
}
