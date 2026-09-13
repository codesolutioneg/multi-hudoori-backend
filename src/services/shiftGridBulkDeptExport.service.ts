/**
 * Bulk-export one Excel file per department for each selected shift grid,
 * packaged as a single ZIP download.
 */
import JSZip from 'jszip';
import { prisma } from '../prisma/client';
import {
  exportShiftGridXlsx,
  resolveGridExcelDateRange,
} from './shiftGridExcel.service';
import { UNGROUPED_DEPARTMENT_LABEL } from './shiftGridGrouping.service';

function safeToken(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Distinct department names for employees who appear on the grid. */
export async function departmentsOnShiftGrid(gridId: string): Promise<string[]> {
  const rows = await prisma.shiftGridLine.findMany({
    where: { gridId },
    distinct: ['employeeId'],
    select: {
      employee: { select: { department: { select: { name: true } } } },
    },
  });
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.employee.department?.name?.trim() || UNGROUPED_DEPARTMENT_LABEL;
    names.add(name);
  }
  return [...names].sort((a, b) => {
    if (a === UNGROUPED_DEPARTMENT_LABEL) return 1;
    if (b === UNGROUPED_DEPARTMENT_LABEL) return -1;
    return a.localeCompare(b, 'ar');
  });
}

export type BulkDeptExportResult = {
  base64: string;
  filename: string;
  mimeType: string;
  gridCount: number;
  fileCount: number;
  skipped: Array<{ gridId: string; name: string; reason: string }>;
};

/**
 * For each grid: emit one .xlsx per department found on that grid.
 * Returns a ZIP (base64) containing all files.
 */
export async function exportShiftGridsByDepartmentZip(
  grids: Array<{ id: string; name: string; dateFrom: Date; dateTo: Date }>,
  options?: { dateFrom?: string; dateTo?: string },
): Promise<BulkDeptExportResult> {
  if (!grids.length) {
    throw new Error('لا توجد جداول للتصدير');
  }

  const zip = new JSZip();
  const skipped: BulkDeptExportResult['skipped'] = [];
  let fileCount = 0;

  for (const grid of grids) {
    const departments = await departmentsOnShiftGrid(grid.id);
    if (!departments.length) {
      skipped.push({
        gridId: grid.id,
        name: grid.name,
        reason: 'لا يوجد موظفون / أقسام على الجدول',
      });
      continue;
    }

    const range = resolveGridExcelDateRange(
      grid.dateFrom,
      grid.dateTo,
      options?.dateFrom,
      options?.dateTo,
    );
    const fromKey = range.from.toISOString().slice(0, 10);
    const toKey = range.to.toISOString().slice(0, 10);
    const safeName = safeToken(grid.name || 'shift_grid') || 'shift_grid';

    for (const dept of departments) {
      const base64 = await exportShiftGridXlsx(grid.id, {
        dateFrom: options?.dateFrom,
        dateTo: options?.dateTo,
        departmentNames: [dept],
      });
      const deptToken = safeToken(dept) || 'dept';
      const filename = `${safeName}_${fromKey}_${toKey}_${deptToken}.xlsx`;
      zip.file(filename, Buffer.from(base64, 'base64'));
      fileCount++;
    }
  }

  if (fileCount === 0) {
    throw new Error('لا توجد ملفات للتصدير — الجداول بدون أقسام/موظفين');
  }

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const period =
    grids.length === 1
      ? safeToken(grids[0].name)
      : `${grids.length}_grids`;
  const filename = `shift_grids_by_department_${period}.zip`;

  return {
    base64: zipBuffer.toString('base64'),
    filename,
    mimeType: 'application/zip',
    gridCount: grids.length - skipped.length,
    fileCount,
    skipped,
  };
}

/**
 * One full-grid Excel per selected grid, packaged as a ZIP.
 * (Same workbook shape as the detail-page «تصدير Excel» without dept filter.)
 */
export async function exportShiftGridsFullZip(
  grids: Array<{ id: string; name: string; dateFrom: Date; dateTo: Date }>,
  options?: { dateFrom?: string; dateTo?: string },
): Promise<BulkDeptExportResult> {
  if (!grids.length) {
    throw new Error('لا توجد جداول للتصدير');
  }

  const zip = new JSZip();
  const skipped: BulkDeptExportResult['skipped'] = [];
  let fileCount = 0;

  for (const grid of grids) {
    const range = resolveGridExcelDateRange(
      grid.dateFrom,
      grid.dateTo,
      options?.dateFrom,
      options?.dateTo,
    );
    const fromKey = range.from.toISOString().slice(0, 10);
    const toKey = range.to.toISOString().slice(0, 10);
    const safeName = safeToken(grid.name || 'shift_grid') || 'shift_grid';

    try {
      const base64 = await exportShiftGridXlsx(grid.id, {
        dateFrom: options?.dateFrom,
        dateTo: options?.dateTo,
      });
      const filename = `${safeName}_${fromKey}_${toKey}.xlsx`;
      zip.file(filename, Buffer.from(base64, 'base64'));
      fileCount++;
    } catch (e) {
      skipped.push({
        gridId: grid.id,
        name: grid.name,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (fileCount === 0) {
    throw new Error('لا توجد ملفات للتصدير');
  }

  // Single grid → still zip for a consistent client download path,
  // or we could return the lone xlsx; ZIP keeps the API uniform.
  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const period =
    grids.length === 1
      ? safeToken(grids[0].name)
      : `${grids.length}_grids`;
  const filename = `shift_grids_${period}.zip`;

  return {
    base64: zipBuffer.toString('base64'),
    filename,
    mimeType: 'application/zip',
    gridCount: grids.length - skipped.length,
    fileCount,
    skipped,
  };
}
