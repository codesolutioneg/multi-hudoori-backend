/** Egyptian IBAN: EG + 27 digits (29 characters total). */
export function normalizeEgyptianIban(value: unknown): string {
  return String(value ?? '').replace(/\s/g, '').toUpperCase();
}

export function validateEgyptianIban(value: unknown, required = false): {
  valid: boolean;
  normalized?: string | null;
  error?: string;
} {
  const iban = normalizeEgyptianIban(value);
  if (!iban) {
    if (required) {
      return { valid: false, error: 'رقم IBAN مطلوب عند تفعيل الحساب البنكي' };
    }
    return { valid: true, normalized: null };
  }
  if (!/^EG\d{27}$/.test(iban)) {
    return {
      valid: false,
      error: 'رقم IBAN غير صالح — يجب أن يبدأ بـ EG متبوعاً بـ 27 رقم',
    };
  }
  return { valid: true, normalized: iban };
}

export function formatEgyptianIbanDisplay(iban: string | null | undefined): string {
  const n = normalizeEgyptianIban(iban);
  if (!n) return '';
  return n.replace(/(.{4})/g, '$1 ').trim();
}
