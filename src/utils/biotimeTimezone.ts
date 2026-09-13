/** BioTime / Odoo store device-local wall clock; reports use that for work_date logic. */
const DEFAULT_TIMEZONE = 'Africa/Cairo';

export function punchInstantToWallClock(instant: Date, timeZone = DEFAULT_TIMEZONE): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  let y = Number(parts.year);
  let m = Number(parts.month);
  let d = Number(parts.day);
  let h = Number(parts.hour);
  const min = Number(parts.minute);
  const sec = Number(parts.second);
  // ICU can emit hour 24 at local midnight (e.g. Africa/Cairo); normalize to 00:xx same calendar day.
  if (h === 24) h = 0;
  return new Date(Date.UTC(y, m - 1, d, h, min, sec));
}

/** Parse BioTime API datetime string as wall-clock (Odoo: no UTC conversion). */
export function parseBioTimePunchTime(punchTimeStr: string): Date | null {
  const normalized = punchTimeStr.trim().replace(' ', 'T');
  if (!normalized) return null;
  const d = new Date(`${normalized}Z`);
  return isNaN(d.getTime()) ? null : d;
}

export function wallClockHour(d: Date): number {
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

/** Calendar date key from a @db.Date or Date (UTC midnight). */
export function calendarDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Odoo datetime.combine(date, min/max time) for BioTime API filters. */
export function formatBioTimeRange(dateFrom?: Date, dateTo?: Date): {
  start_time?: string;
  end_time?: string;
} {
  const out: { start_time?: string; end_time?: string } = {};
  if (dateFrom) out.start_time = `${calendarDateKey(dateFrom)} 00:00:00`;
  if (dateTo) out.end_time = `${calendarDateKey(dateTo)} 23:59:59`;
  return out;
}

/** Format instant as BioTime local wall clock string. */
export function formatBioTimeDateTime(instant: Date, timeZone = DEFAULT_TIMEZONE): string {
  const wall = punchInstantToWallClock(instant, timeZone);
  const y = wall.getUTCFullYear();
  const m = String(wall.getUTCMonth() + 1).padStart(2, '0');
  const day = String(wall.getUTCDate()).padStart(2, '0');
  const h = String(wall.getUTCHours()).padStart(2, '0');
  const min = String(wall.getUTCMinutes()).padStart(2, '0');
  const s = String(wall.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

export { DEFAULT_TIMEZONE };
