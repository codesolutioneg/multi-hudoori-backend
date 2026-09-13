import type { Shift, ShiftGridLine } from '@prisma/client';
import type { CellFlags } from './shiftGridData.service';
import { sortShiftsForDisplay } from './shiftCalculations.service';

export const LABEL_OFF = 'إجازة (off)';
export const LABEL_PRESENT = 'حاضر';
export const LABEL_SICK = 'إجازة مرضية';
export const LABEL_ANNUAL = 'إجازة سنوية';
export const LABEL_EXCLUDED = 'عدم احتساب يوم';
export const LABEL_BUS = 'تأخير باص';
export const LABEL_FINISHED = 'انهاء';
export const LABEL_RESIGNATION = 'استقاله';
export const LABEL_WORK_ABSENCE = 'انقطاع عن العمل';
export const LABEL_WORK_INJURY = 'اصابه عمل';
export const LABEL_MARRIAGE = 'إجازة جواز';
/** Auto-locked label for employees after departure date (not a selectable status). */
export const LABEL_DEPARTED = 'استقالة';

export function shiftDropdownLabel(shift: Shift): string {
  const code = (shift.code ?? '').trim();
  const name = (shift.name ?? '').trim();
  // Excel dropdown lists the shift name only (code stays for matching / BioTime).
  return name || code;
}

export function shiftBusLabel(shift: Shift): string {
  const name = (shift.name ?? '').trim();
  const code = (shift.code ?? '').trim();
  const base = name || code;
  return base ? `${base} 🚌` : '🚌';
}

/** Dropdown options — same order as shift grid UI: statuses, shifts, then bus-emoji shifts last. */
export function buildDropdownOptionLabels(shifts: Shift[]): string[] {
  const sorted = sortShiftsForDisplay(shifts);
  const options = [
    LABEL_OFF,
    LABEL_PRESENT,
    LABEL_SICK,
    LABEL_ANNUAL,
    LABEL_EXCLUDED,
    LABEL_BUS,
    LABEL_FINISHED,
    LABEL_RESIGNATION,
    LABEL_WORK_ABSENCE,
    LABEL_WORK_INJURY,
    LABEL_MARRIAGE,
  ];
  const busOptions: string[] = [];
  for (const shift of sorted) {
    const main = shiftDropdownLabel(shift);
    if (main) options.push(main);
    const bus = shiftBusLabel(shift);
    if (bus && bus !== '🚌') busOptions.push(bus);
  }
  options.push(...busOptions);
  return [...new Set(options)];
}

type LineLike = Pick<
  ShiftGridLine,
  | 'isOff'
  | 'isSick'
  | 'isAnnualLeave'
  | 'isExcluded'
  | 'isBusDelay'
  | 'isPresent'
  | 'isFinished'
  | 'isResignation'
  | 'isWorkAbsence'
  | 'isWorkInjury'
  | 'isMarriageLeave'
  | 'shiftId'
> & { shift?: Shift | null };

/** Map grid line → Excel dropdown value (must be one of buildDropdownOptionLabels). */
export function lineToExcelDropdownLabel(line: LineLike): string {
  if (line.isExcluded) return LABEL_EXCLUDED;
  if (line.isSick) return LABEL_SICK;
  if (line.isAnnualLeave) return LABEL_ANNUAL;
  if (line.isOff) return LABEL_OFF;
  if (line.isFinished) return LABEL_FINISHED;
  if (line.isResignation) return LABEL_RESIGNATION;
  if (line.isWorkAbsence) return LABEL_WORK_ABSENCE;
  if (line.isWorkInjury) return LABEL_WORK_INJURY;
  if (line.isMarriageLeave) return LABEL_MARRIAGE;
  if (line.shift) {
    if (line.isBusDelay) return shiftBusLabel(line.shift);
    return shiftDropdownLabel(line.shift);
  }
  if (line.isPresent) return LABEL_PRESENT;
  if (line.isBusDelay) return LABEL_BUS;
  return '';
}

function emptyFlags(): CellFlags {
  return {
    shiftId: null,
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
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function findShiftByCodePart(codePart: string, shifts: Shift[]): Shift | undefined {
  const key = codePart.trim().toLowerCase();
  if (!key) return undefined;
  return shifts.find((s) => (s.code ?? '').trim().toLowerCase() === key);
}

function findShiftByDropdownLabel(label: string, shifts: Shift[]): Shift | undefined {
  const normalized = normalizeLabel(label).toLowerCase();
  for (const shift of shifts) {
    if (shiftDropdownLabel(shift).toLowerCase() === normalized) return shift;
    if (shiftBusLabel(shift).toLowerCase() === normalized) return shift;
    const code = (shift.code ?? '').trim().toLowerCase();
    const name = (shift.name ?? '').trim().toLowerCase();
    if (code && normalized === code) return shift;
    if (name && normalized === name) return shift;
  }

  // Tolerant match: Excel often uses "CODE - Arabic name"
  // e.g. "SH 7 M - شيفت ٧" — try code first, then the name after the dash
  // (codes may have been renamed on prod while Arabic names stayed stable).
  const dashIdx = normalized.indexOf(' - ');
  if (dashIdx > 0) {
    const byCode = findShiftByCodePart(normalized.slice(0, dashIdx), shifts);
    if (byCode) return byCode;
    const namePart = normalized.slice(dashIdx + 3).trim();
    if (namePart) {
      for (const shift of shifts) {
        const name = (shift.name ?? '').trim().toLowerCase();
        if (name && name === namePart) return shift;
        if (shiftDropdownLabel(shift).toLowerCase() === namePart) return shift;
      }
    }
  }

  // Last resort: longest active shift code that is a prefix of the label.
  let best: Shift | undefined;
  let bestLen = 0;
  for (const shift of shifts) {
    const code = (shift.code ?? '').trim().toLowerCase();
    if (!code || code.length < 2) continue;
    if (
      (normalized === code ||
        normalized.startsWith(`${code} `) ||
        normalized.startsWith(`${code}-`) ||
        normalized.startsWith(`${code} -`)) &&
      code.length > bestLen
    ) {
      best = shift;
      bestLen = code.length;
    }
  }
  return best;
}

/** Status prefixes that may appear alone or before a shift code in imported Excels. */
const STATUS_PREFIXES: { prefix: string; flag: Partial<CellFlags> }[] = [
  { prefix: LABEL_BUS, flag: { isBusDelay: true } },
  { prefix: LABEL_EXCLUDED, flag: { isExcluded: true } },
  { prefix: LABEL_WORK_ABSENCE, flag: { isWorkAbsence: true } },
  { prefix: LABEL_ANNUAL, flag: { isAnnualLeave: true } },
  { prefix: LABEL_SICK, flag: { isSick: true } },
  { prefix: LABEL_WORK_INJURY, flag: { isWorkInjury: true } },
  { prefix: 'إصابة عمل', flag: { isWorkInjury: true } },
  { prefix: 'اصابة عمل', flag: { isWorkInjury: true } },
  { prefix: LABEL_MARRIAGE, flag: { isMarriageLeave: true, isPresent: true } },
  { prefix: 'اجازة جواز', flag: { isMarriageLeave: true, isPresent: true } },
  { prefix: LABEL_RESIGNATION, flag: { isResignation: true } },
  { prefix: LABEL_FINISHED, flag: { isFinished: true } },
  { prefix: 'إنهاء', flag: { isFinished: true } },
  { prefix: LABEL_PRESENT, flag: { isPresent: true } },
  { prefix: LABEL_OFF, flag: { isOff: true } },
].sort((a, b) => b.prefix.length - a.prefix.length);

function splitStatusAndRemainder(label: string): {
  flag: Partial<CellFlags> | null;
  remainder: string;
} {
  const v = normalizeLabel(label);
  const lower = v.toLowerCase();
  for (const { prefix, flag } of STATUS_PREFIXES) {
    const p = prefix.toLowerCase();
    if (lower === p) return { flag, remainder: '' };
    if (lower.startsWith(`${p} `) || lower.startsWith(`${p}\t`)) {
      return { flag, remainder: normalizeLabel(v.slice(prefix.length)) };
    }
  }
  // Short aliases used in older Excels
  if (lower === 'off' || v === 'إجازة') return { flag: { isOff: true }, remainder: '' };
  if (v === 'م') return { flag: { isSick: true }, remainder: '' };
  if (v === 'إ') return { flag: { isAnnualLeave: true }, remainder: '' };
  if (v === '×' || lower === 'x') return { flag: { isExcluded: true }, remainder: '' };
  if (v === 'ب') return { flag: { isBusDelay: true }, remainder: '' };
  if (lower === 'finished') return { flag: { isFinished: true }, remainder: '' };
  if (lower === 'resignation') return { flag: { isResignation: true }, remainder: '' };
  if (lower === 'work_absence' || lower === 'work absence') {
    return { flag: { isWorkAbsence: true }, remainder: '' };
  }
  if (lower === 'work_injury' || lower === 'work injury') {
    return { flag: { isWorkInjury: true }, remainder: '' };
  }
  if (
    lower === 'marriage' ||
    lower === 'marriage_leave' ||
    v === 'إجازة جواز' ||
    v === 'اجازة جواز'
  ) {
    return { flag: { isMarriageLeave: true, isPresent: true }, remainder: '' };
  }
  return { flag: null, remainder: v };
}

export function excelLabelToCellFlags(label: string, shifts: Shift[]): CellFlags {
  const v = normalizeLabel(label);
  if (!v) return emptyFlags();

  // Legacy export placeholder — treat as empty (import ignores it before apply).
  if (v === LABEL_DEPARTED) {
    return emptyFlags();
  }

  if (v.includes('🚌')) {
    const codePart = v.split('🚌')[0].trim();
    const shift = findShiftByCodePart(codePart, shifts) ?? findShiftByDropdownLabel(v, shifts);
    if (!shift) throw new Error(`شيفت غير معروف: ${label}`);
    return { ...emptyFlags(), shiftId: shift.id, isBusDelay: true };
  }

  const { flag: statusFlag, remainder } = splitStatusAndRemainder(v);

  // Status only (no shift text after the prefix).
  if (statusFlag && !remainder) {
    return { ...emptyFlags(), ...statusFlag };
  }

  const shiftText = remainder || v;
  const shift = findShiftByDropdownLabel(shiftText, shifts);
  if (shift) {
    // Combined cells from the other system: "حاضر SH 4 N - …", "تأخير باص SH 6 N - …"
    return {
      ...emptyFlags(),
      shiftId: shift.id,
      ...(statusFlag ?? {}),
    };
  }

  // Completely unknown — caller skips the cell.
  throw new Error(`قيمة غير مسموحة: ${label}`);
}

export function isAllowedDropdownLabel(label: string, shifts: Shift[]): boolean {
  const v = normalizeLabel(label);
  if (!v) return true;
  if (v === LABEL_DEPARTED) return true;
  try {
    excelLabelToCellFlags(v, shifts);
    return true;
  } catch {
    return false;
  }
}
