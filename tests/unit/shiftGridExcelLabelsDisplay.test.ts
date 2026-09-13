import { describe, expect, it } from 'vitest';
import {
  buildDropdownOptionLabels,
  shiftBusLabel,
  shiftDropdownLabel,
} from '../../src/services/shiftGridExcelLabels';
import type { Shift } from '@prisma/client';

function shift(partial: Partial<Shift>): Shift {
  return {
    id: 's1',
    name: '',
    code: null,
    startTime: '09:00',
    endTime: '17:00',
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as Shift;
}

describe('shiftGridExcelLabels display', () => {
  it('uses shift name only in dropdown (not code - name)', () => {
    const s = shift({ code: 'SH 12 M', name: 'شيفت 12 صباحاً' });
    expect(shiftDropdownLabel(s)).toBe('شيفت 12 صباحاً');
    expect(shiftDropdownLabel(s)).not.toContain(' - ');
  });

  it('falls back to code when name is empty', () => {
    expect(shiftDropdownLabel(shift({ code: 'SH 7 M', name: '' }))).toBe('SH 7 M');
  });

  it('uses name for bus-delay dropdown labels', () => {
    expect(shiftBusLabel(shift({ code: 'SH 12 M', name: 'شيفت 12 صباحاً' }))).toBe(
      'شيفت 12 صباحاً 🚌',
    );
  });

  it('dropdown options include names not combined labels', () => {
    const labels = buildDropdownOptionLabels([
      shift({ id: 'a', code: 'SH 12 M', name: 'شيفت 12 صباحاً' }),
      shift({ id: 'b', code: '0.6', name: '0.6' }),
    ]);
    expect(labels).toContain('شيفت 12 صباحاً');
    expect(labels).not.toContain('SH 12 M - شيفت 12 صباحاً');
  });
});
