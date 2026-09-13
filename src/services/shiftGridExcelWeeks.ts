/**
 * Week groups for the shift grid Excel header (الأسبوع الأول، الثاني ...).
 *
 * The start weekday is configurable because it is a scheduling convention, not a
 * constant: this branch runs Sunday to Saturday. It previously started a new
 * week on Saturday, which pushed Saturday into the following week's block.
 */
export const DEFAULT_WEEK_START_DAY = 0;

/** 0 = Sunday through 6 = Saturday, matching Date.getUTCDay. */
export function parseWeekStartDay(value: unknown): number {
  const day = Math.round(Number(value));
  return Number.isFinite(day) && day >= 0 && day <= 6 ? day : DEFAULT_WEEK_START_DAY;
}

export function buildWeekGroups(
  dates: { jsWeekday: number }[],
  weekStartDay: number = DEFAULT_WEEK_START_DAY,
): { label: string; colspan: number }[] {
  if (dates.length === 0) return [];

  const startDay = parseWeekStartDay(weekStartDay);
  const ordinals = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس'];
  const weeks: { colspan: number }[] = [];
  let current: { colspan: number } | null = null;

  for (const d of dates) {
    // A new block opens on the configured start weekday, so a range beginning
    // mid-week still gets its own leading block.
    if (current == null || d.jsWeekday === startDay) {
      current = { colspan: 0 };
      weeks.push(current);
    }
    current.colspan += 1;
  }

  return weeks.map((w, i) => ({
    label: `الأسبوع ${i < ordinals.length ? ordinals[i] : i + 1}`,
    colspan: w.colspan,
  }));
}
