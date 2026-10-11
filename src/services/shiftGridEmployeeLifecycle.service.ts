/**
 * Auto archive / restore employees based on shift-grid cell status.
 *
 * - Departure cells (انهاء / استقاله / انقطاع عن العمل) → archive
 * - Real shift assignment (shiftId set) → restore (unarchive)
 */
import type { CellFlags } from './shiftGridData.service';
import { archiveEmployee, restoreEmployee } from './employeeArchive.service';
import {
  getOutstandingLongAdvanceWarningWithEmployee,
  type LongAdvanceWarningWithEmployee,
} from './advances.service';
import { prisma } from '../prisma/client';
import { logger } from '../utils/logger';

export type LifecycleAction = 'archive' | 'restore' | 'none';

export type LifecycleSyncResult = {
  action: LifecycleAction;
  longAdvanceWarning: LongAdvanceWarningWithEmployee | null;
};

/** Exit / left-work statuses that should archive the employee. */
export function isDepartureCellFlags(
  flags: Pick<CellFlags, 'isFinished' | 'isResignation' | 'isWorkAbsence'>,
): boolean {
  return Boolean(flags.isFinished || flags.isResignation || flags.isWorkAbsence);
}

/** A real scheduled shift (not leave / off / exit / present-only). */
export function isActiveShiftCellFlags(flags: Pick<CellFlags, 'shiftId'>): boolean {
  return Boolean(flags.shiftId);
}

export function lifecycleActionFromFlags(flags: CellFlags): LifecycleAction {
  if (isActiveShiftCellFlags(flags)) return 'restore';
  if (isDepartureCellFlags(flags)) return 'archive';
  return 'none';
}

function departureReason(flags: CellFlags): string {
  if (flags.isFinished) return 'أوتوماتيك من جدول الشيفت: انهاء';
  if (flags.isResignation) return 'أوتوماتيك من جدول الشيفت: استقاله';
  if (flags.isWorkAbsence) return 'أوتوماتيك من جدول الشيفت: انقطاع عن العمل';
  return 'أوتوماتيك من جدول الشيفت: خروج';
}

/**
 * Apply archive/restore for one employee from the cell flags just written.
 * Idempotent via archiveEmployee / restoreEmployee.
 */
export async function syncEmployeeLifecycleFromCellFlags(
  employeeId: string,
  flags: CellFlags,
  options?: { actor?: string | null },
): Promise<LifecycleSyncResult> {
  const action = lifecycleActionFromFlags(flags);
  if (action === 'none') return { action: 'none', longAdvanceWarning: null };

  const emp = await prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    select: { id: true, active: true },
  });
  if (!emp) return { action: 'none', longAdvanceWarning: null };

  try {
    if (action === 'archive') {
      if (!emp.active) {
        const warning = await getOutstandingLongAdvanceWarningWithEmployee(employeeId);
        return { action: 'archive', longAdvanceWarning: warning };
      }
      await archiveEmployee(
        employeeId,
        departureReason(flags),
        options?.actor ?? undefined,
      );
      const warning = await getOutstandingLongAdvanceWarningWithEmployee(employeeId);
      return { action: 'archive', longAdvanceWarning: warning };
    }

    if (emp.active) return { action: 'restore', longAdvanceWarning: null };
    await restoreEmployee(employeeId);
    return { action: 'restore', longAdvanceWarning: null };
  } catch (err) {
    logger.warn(
      { err, employeeId, action },
      'shift-grid lifecycle archive/restore failed',
    );
    return { action: 'none', longAdvanceWarning: null };
  }
}

/** Restore wins over archive when both appear in the same import/bulk pass. */
export function mergeLifecycleActions(actions: LifecycleAction[]): LifecycleAction {
  if (actions.includes('restore')) return 'restore';
  if (actions.includes('archive')) return 'archive';
  return 'none';
}

export async function applyMergedLifecycleAction(
  employeeId: string,
  action: LifecycleAction,
  options?: { actor?: string | null; archiveReason?: string },
): Promise<LifecycleSyncResult> {
  if (action === 'none') return { action: 'none', longAdvanceWarning: null };

  const emp = await prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    select: { id: true, active: true },
  });
  if (!emp) return { action: 'none', longAdvanceWarning: null };

  try {
    if (action === 'archive') {
      if (!emp.active) {
        const warning = await getOutstandingLongAdvanceWarningWithEmployee(employeeId);
        return { action: 'archive', longAdvanceWarning: warning };
      }
      await archiveEmployee(
        employeeId,
        options?.archiveReason?.trim() || 'أوتوماتيك من جدول الشيفت: خروج',
        options?.actor ?? undefined,
      );
      const warning = await getOutstandingLongAdvanceWarningWithEmployee(employeeId);
      return { action: 'archive', longAdvanceWarning: warning };
    }

    if (emp.active) return { action: 'restore', longAdvanceWarning: null };
    await restoreEmployee(employeeId);
    return { action: 'restore', longAdvanceWarning: null };
  } catch (err) {
    logger.warn(
      { err, employeeId, action },
      'shift-grid lifecycle archive/restore failed',
    );
    return { action: 'none', longAdvanceWarning: null };
  }
}
