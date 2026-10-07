import { PayrollState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { AppError } from '../utils/errors';
import { addUtcDays, utcDateOnly } from '../utils/payrollPeriod';
import { payrollMonthRange } from './shiftGridMerge.service';

export type OpenCycle = { dateFrom: string; dateTo: string; payrollMonthStartDay: number };

export function enumerateUtcDates(from: Date, to: Date): Date[] {
  const start = utcDateOnly(from);
  const end = utcDateOnly(to);
  const out: Date[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addUtcDays(d, 1)) {
    out.push(new Date(d));
  }
  return out;
}

export async function getOpenCycle(ref = new Date()): Promise<OpenCycle> {
  const config = await prisma.bioTimeConfig.findFirst({
    select: { payrollMonthStartDay: true },
  });
  const payrollMonthStartDay = config?.payrollMonthStartDay ?? 26;
  const { dateFrom, dateTo } = payrollMonthRange(ref, payrollMonthStartDay);
  return {
    dateFrom: dateFrom.toISOString().slice(0, 10),
    dateTo: dateTo.toISOString().slice(0, 10),
    payrollMonthStartDay,
  };
}

/** Blocks when any date falls in a payroll period that is confirmed or sent to Odoo. */
export async function assertDatesNotPeriodLocked(employeeId: string, dates: Date[]): Promise<void> {
  if (!dates.length) return;
  const unique = [...new Set(dates.map((d) => utcDateOnly(d).getTime()))].map((t) => new Date(t));

  for (const day of unique) {
    const locked = await prisma.payrollLine.findFirst({
      where: {
        employeeId,
        payroll: {
          dateFrom: { lte: day },
          dateTo: { gte: day },
          OR: [{ state: PayrollState.confirmed }, { odooSentAt: { not: null } }],
        },
      },
      select: { id: true },
    });
    if (locked) {
      throw new AppError(
        'الفترة مقفولة — لا يمكن تعديل أيام تم اعتماد كشفها أو إرساله',
        400,
        'PERIOD_LOCKED',
      );
    }
  }
}
