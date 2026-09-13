import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { assertShiftGridExcelMeta } from '../../src/services/shiftGridExcel.service';

describe('assertShiftGridExcelMeta', () => {
  it('rejects workbook without _meta', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('جدول الشيفتات');
    expect(() => assertShiftGridExcelMeta(wb, 'grid-a')).toThrow(/_meta/);
  });

  it('rejects mismatched shift_grid_id', () => {
    const wb = new ExcelJS.Workbook();
    const meta = wb.addWorksheet('_meta');
    meta.getCell(1, 1).value = 'shift_grid_id';
    meta.getCell(1, 2).value = 'grid-other';
    meta.getCell(4, 1).value = 'grid_name';
    meta.getCell(4, 2).value = 'Bri.Mad';
    expect(() => assertShiftGridExcelMeta(wb, 'grid-a', 'Sizzler')).toThrow(/Bri\.Mad/);
  });

  it('accepts matching shift_grid_id', () => {
    const wb = new ExcelJS.Workbook();
    const meta = wb.addWorksheet('_meta');
    meta.getCell(1, 1).value = 'shift_grid_id';
    meta.getCell(1, 2).value = 'grid-a';
    expect(() => assertShiftGridExcelMeta(wb, 'grid-a')).not.toThrow();
  });
});
