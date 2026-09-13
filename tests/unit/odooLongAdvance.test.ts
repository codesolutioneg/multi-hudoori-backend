import { describe, expect, it } from 'vitest';
import {
  buildOdooLongAdvanceNote,
  buildOdooLongAdvanceVals,
  longAdvanceOdooMarker,
} from '../../src/services/odoo/odooLongAdvance.service';

describe('Odoo long advance payload', () => {
  it('creates a draft Odoo advance with a stable idempotency marker', () => {
    const advance = {
      id: 'advance-local-1',
      totalAmount: 12000,
      installments: 6,
      startDate: new Date('2026-09-26T00:00:00.000Z'),
      date: new Date('2026-09-10T00:00:00.000Z'),
      nextDeductionDate: new Date('2026-09-26T00:00:00.000Z'),
      notes: 'تفاصيل السلفة',
    };

    expect(longAdvanceOdooMarker(advance.id)).toBe(
      'Hudoori-Advance-ID:advance-local-1',
    );
    expect(buildOdooLongAdvanceNote(advance.id, advance.notes)).toContain(
      'Hudoori-Advance-ID:advance-local-1',
    );
    expect(buildOdooLongAdvanceVals(advance, 277)).toEqual({
      employee_id: 277,
      total_amount: 12000,
      installments: 6,
      start_date: '2026-09-26',
      next_deduction_date: '2026-09-26',
      note: 'تفاصيل السلفة\nHudoori-Advance-ID:advance-local-1',
      state: 'draft',
    });
  });
});
