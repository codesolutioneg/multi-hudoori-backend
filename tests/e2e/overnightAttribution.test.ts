import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { prisma } from '../../src/prisma/client';
import { resetDatabase, ensureBioTimeConfig, createShift } from '../helpers/db';
import { generatePunchReport } from '../../src/services/punchReport.service';

/**
 * Overnight shift (e.g. 17:00 -> 01:00): the evening check-in and the after-midnight
 * check-out belong to the SAME work-date, not two separate days. Punch times are
 * stored as device wall-clock (UTC digits), so the report must read them as-is; a
 * timezone re-conversion pushed the 00:55 punch past the shift-end window and rolled
 * it to the next day as a bogus check-in.
 */
describe('overnight shift punch attribution', () => {
  beforeAll(async () => {
    await ensureBioTimeConfig();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  it('keeps an after-midnight checkout on the same overnight work-date', async () => {
    const shift = await createShift({
      name: 'Night',
      startTime: '17:00',
      endTime: '01:00',
      isOvernight: true,
    });
    const employee = await prisma.employeeProfile.create({
      data: { name: 'Night Worker', code: 'N100', basicSalary: 3000 },
    });
    const grid = await prisma.shiftGrid.create({
      data: { name: 'Night grid', dateFrom: new Date('2026-06-01'), dateTo: new Date('2026-06-03') },
    });
    // Overnight shift assigned on the work-date 2026-06-01.
    await prisma.shiftGridLine.create({
      data: {
        gridId: grid.id,
        employeeId: employee.id,
        date: new Date('2026-06-01T00:00:00.000Z'),
        shiftId: shift.id,
      },
    });
    // Check-in 17:05 on 06-01, check-out 00:55 on 06-02 (wall-clock stored as UTC digits).
    await prisma.transaction.create({
      data: { employeeId: employee.id, empCode: 'N100', biotimeTransactionId: 950001, punchTime: new Date(Date.UTC(2026, 5, 1, 17, 5)), punchState: '0' },
    });
    await prisma.transaction.create({
      data: { employeeId: employee.id, empCode: 'N100', biotimeTransactionId: 950002, punchTime: new Date(Date.UTC(2026, 5, 2, 0, 55)), punchState: '1' },
    });

    const lines = await generatePunchReport(
      new Date('2026-06-01'),
      new Date('2026-06-03'),
      [employee.id],
      grid.id,
      true,
    );

    const punchLines = lines.filter((l) => l.employeeId === employee.id && (l.punchCount || 0) > 0);
    // Both punches must collapse onto ONE work-date, not split into two days.
    expect(punchLines).toHaveLength(1);
    expect(punchLines[0].punchDate.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(punchLines[0].punchCount).toBe(2);
    // No stray line on 2026-06-02 carrying the after-midnight punch.
    expect(lines.some((l) => l.punchDate.toISOString().slice(0, 10) === '2026-06-02' && (l.punchCount || 0) > 0)).toBe(false);
  });
});
