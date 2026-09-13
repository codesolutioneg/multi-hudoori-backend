import { AppError } from '../utils/errors';

const ENGLISH_TEXT = /^[A-Za-z0-9\s.,'\-/&()]+$/;
const ENGLISH_CODE = /^[A-Za-z0-9_-]+$/;
const HAS_LETTER = /[A-Za-z]/;

/** Name / job: Latin letters, digits, common punctuation — no Arabic. */
export function assertEnglishText(value: string, fieldLabel: string, minLength = 1): string {
  const trimmed = value.trim();
  if (trimmed.length < minLength) {
    throw new AppError(`${fieldLabel} مطلوب`, 400, 'VALIDATION');
  }
  if (!ENGLISH_TEXT.test(trimmed) || !HAS_LETTER.test(trimmed)) {
    throw new AppError(
      `${fieldLabel} لازم يكون إنجليزي فقط (حروف وأرقام إنجليزية)`,
      400,
      'VALIDATION',
    );
  }
  return trimmed;
}

/** Fingerprint code: English letters, digits, _, - */
export function assertEnglishCode(value: string, fieldLabel = 'كود البصمة'): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AppError(`${fieldLabel} مطلوب`, 400, 'VALIDATION');
  }
  if (!ENGLISH_CODE.test(trimmed)) {
    throw new AppError(
      `${fieldLabel} لازم يكون إنجليزي فقط (حروف وأرقام و _ -)`,
      400,
      'VALIDATION',
    );
  }
  return trimmed;
}
