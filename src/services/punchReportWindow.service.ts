/**
 * Punch-report overnight / pairing floors — configurable per company.
 * Defaults match Hudoori-dev hardcoded 10h / 5h / calendar hour 6.
 */
import type { BioTimeConfig } from '@prisma/client';
import { prisma } from '../prisma/client';
import {
  DEFAULT_EARLY_CHECKIN_HOURS,
  DEFAULT_LATE_CHECKOUT_HOURS,
} from './shiftTime.service';

export const PUNCH_REPORT_MIN_LATE_CHECKOUT_HOURS = 10;
export const PUNCH_REPORT_MIN_EARLY_CHECKIN_HOURS = 5;
export const PUNCH_REPORT_CALENDAR_DAY_FLOOR_HOUR = 6;

export type PunchReportWindowSettings = {
  minLateCheckoutHours: number;
  minEarlyCheckinHours: number;
  calendarDayFloorHour: number;
};

export function punchReportWindowFromConfig(
  config: Partial<BioTimeConfig> | null | undefined,
): PunchReportWindowSettings {
  const late = Number(config?.punchReportMinLateCheckoutHours);
  const early = Number(config?.punchReportMinEarlyCheckinHours);
  const floor = Math.round(Number(config?.punchReportCalendarDayFloorHour));
  return {
    minLateCheckoutHours:
      Number.isFinite(late) && late >= 0 ? late : PUNCH_REPORT_MIN_LATE_CHECKOUT_HOURS,
    minEarlyCheckinHours:
      Number.isFinite(early) && early >= 0 ? early : PUNCH_REPORT_MIN_EARLY_CHECKIN_HOURS,
    calendarDayFloorHour:
      Number.isFinite(floor) && floor >= 0 && floor <= 23
        ? floor
        : PUNCH_REPORT_CALENDAR_DAY_FLOOR_HOUR,
  };
}

export async function getPunchReportWindowSettings(): Promise<PunchReportWindowSettings> {
  const config = await prisma.bioTimeConfig.findFirst({
    select: {
      punchReportMinLateCheckoutHours: true,
      punchReportMinEarlyCheckinHours: true,
      punchReportCalendarDayFloorHour: true,
    },
  });
  return punchReportWindowFromConfig(config);
}

export function punchReportWindowConfigJson(
  config: Partial<BioTimeConfig> | null | undefined,
) {
  const w = punchReportWindowFromConfig(config);
  return {
    punchReportMinLateCheckoutHours: w.minLateCheckoutHours,
    punchReportMinEarlyCheckinHours: w.minEarlyCheckinHours,
    punchReportCalendarDayFloorHour: w.calendarDayFloorHour,
    defaultLateCheckoutHours:
      config?.defaultLateCheckoutHours != null &&
      Number.isFinite(Number(config.defaultLateCheckoutHours))
        ? Number(config.defaultLateCheckoutHours)
        : DEFAULT_LATE_CHECKOUT_HOURS,
    defaultEarlyCheckinHours:
      config?.defaultEarlyCheckinHours != null &&
      Number.isFinite(Number(config.defaultEarlyCheckinHours))
        ? Number(config.defaultEarlyCheckinHours)
        : DEFAULT_EARLY_CHECKIN_HOURS,
  };
}
