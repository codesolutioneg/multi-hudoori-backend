/** Parse and validate Egyptian 14-digit national ID (الرقم القومي). */

export type EgyptianNationalIdParseResult = {
  valid: boolean;
  nationalId: string;
  birthDate: Date | null;
  age: number | null;
  error?: string;
};

/** birthDate is a UTC calendar day, so compare it against today in UTC too. */
function ageFromDate(birthDate: Date): number {
  const today = new Date();
  let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDiff = today.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1;
  }
  return Math.max(0, age);
}

/** Century digit 2 → 1900s, 3 → 2000s; digits 2–7 are YYMMDD. */
export function parseEgyptianNationalId(raw: string): EgyptianNationalIdParseResult {
  const nationalId = raw.trim().replace(/\s+/g, '');
  if (!nationalId) {
    return { valid: true, nationalId: '', birthDate: null, age: null };
  }

  if (!/^\d{14}$/.test(nationalId)) {
    return {
      valid: false,
      nationalId,
      birthDate: null,
      age: null,
      error: 'الرقم القومي يجب أن يكون 14 رقماً بالضبط',
    };
  }

  const centuryDigit = nationalId[0];
  if (centuryDigit !== '2' && centuryDigit !== '3') {
    return {
      valid: false,
      nationalId,
      birthDate: null,
      age: null,
      error: 'الرقم القومي غير صالح (رقم القرن)',
    };
  }

  const yy = Number(nationalId.slice(1, 3));
  const mm = Number(nationalId.slice(3, 5));
  const dd = Number(nationalId.slice(5, 7));
  const year = (centuryDigit === '2' ? 1900 : 2000) + yy;

  // UTC midnight: the value is persisted and rendered as a UTC calendar day,
  // so local-midnight construction would store the previous day east of UTC.
  const birthDate = new Date(Date.UTC(year, mm - 1, dd));
  if (
    birthDate.getUTCFullYear() !== year
    || birthDate.getUTCMonth() !== mm - 1
    || birthDate.getUTCDate() !== dd
  ) {
    return {
      valid: false,
      nationalId,
      birthDate: null,
      age: null,
      error: 'تاريخ الميلاد المستخرج من الرقم القومي غير صالح',
    };
  }

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (birthDate > today) {
    return {
      valid: false,
      nationalId,
      birthDate: null,
      age: null,
      error: 'تاريخ الميلاد في الرقم القومي لا يمكن أن يكون في المستقبل',
    };
  }

  return {
    valid: true,
    nationalId,
    birthDate,
    age: ageFromDate(birthDate),
  };
}

export function validateEgyptianNationalId(raw: string): string | null {
  const parsed = parseEgyptianNationalId(raw);
  return parsed.valid ? null : (parsed.error ?? 'الرقم القومي غير صالح');
}
