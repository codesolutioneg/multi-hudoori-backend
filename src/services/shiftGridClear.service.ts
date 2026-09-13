/**
 * Clear / wipe / delete shift grids (HR toolbar actions).
 */
import { ShiftGridState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';

const CLEARED_LINE_FLAGS = {
  shiftId: null as string | null,
  isOff: false,
  isSick: false,
  isAnnualLeave: false,
  isExcluded: false,
  isBusDelay: false,
  isPresent: false,
  isFinished: false,
  isResignation: false,
  isWorkAbsence: false,
  isWorkInjury: false,
  isMarriageLeave: false,
};

async function loadEditableGrid(gridId: string) {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) throw new NotFoundError('الجدول غير موجود');
  if (grid.state === ShiftGridState.confirmed) {
    throw new AppError('الجدول مؤكد — افتحه للتعديل أولاً', 400, 'GRID_LOCKED');
  }
  return grid;
}

/** A — empty shift/status cells; keep employees on the grid. */
export async function clearShiftGridAssignments(gridId: string) {
  const grid = await loadEditableGrid(gridId);
  const result = await prisma.shiftGridLine.updateMany({
    where: { gridId },
    data: CLEARED_LINE_FLAGS,
  });
  return {
    gridId: grid.id,
    clearedCells: result.count,
  };
}

/** B — remove all employee rows/cells; grid shell remains. */
export async function wipeShiftGridEmployees(gridId: string) {
  const grid = await loadEditableGrid(gridId);
  const result = await prisma.$transaction(async (tx) => {
    const ot = await tx.shiftGridManualOtLine.deleteMany({ where: { gridId } });
    const lines = await tx.shiftGridLine.deleteMany({ where: { gridId } });
    await tx.shiftGrid.update({
      where: { id: gridId },
      data: { employeeIds: [] },
    });
    return { ot: ot.count, lines: lines.count };
  });
  return {
    gridId: grid.id,
    removedLines: result.lines,
    removedManualOt: result.ot,
  };
}

/** C — delete the grid itself (blocked when payrolls are linked). */
export async function deleteShiftGrid(gridId: string) {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) throw new NotFoundError('الجدول غير موجود');

  const payrollCount = await prisma.payroll.count({ where: { shiftGridId: gridId } });
  if (payrollCount > 0) {
    throw new AppError(
      `لا يمكن حذف الجدول — مرتبط بـ ${payrollCount} كشف رواتب. احذف/افصل الكشوف أولاً.`,
      400,
      'HAS_PAYROLL',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.syncJob.deleteMany({ where: { gridId } });
    // Source weeks pointing at this merge target
    await tx.shiftGrid.updateMany({
      where: { mergedIntoGridId: gridId },
      data: { mergedIntoGridId: null },
    });
    await tx.shiftGrid.delete({ where: { id: gridId } });
  });

  return {
    gridId: grid.id,
    name: grid.name,
    deleted: true,
  };
}
