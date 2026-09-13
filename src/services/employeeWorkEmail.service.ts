/**
 * Smart work-email (@vicanza.com) + first-time password helpers for employees.
 */
import { randomBytes } from 'crypto';

export const VICANZA_EMAIL_DOMAIN = 'vicanza.com';

const ARABIC_TO_LATIN: Record<string, string> = {
  ا: 'a', أ: 'a', إ: 'i', آ: 'a', ء: '',
  ب: 'b', ت: 't', ث: 'th', ج: 'g', ح: 'h', خ: 'kh',
  د: 'd', ذ: 'z', ر: 'r', ز: 'z', س: 's', ش: 'sh',
  ص: 's', ض: 'd', ط: 't', ظ: 'z', ع: 'a', غ: 'gh',
  ف: 'f', ق: 'k', ك: 'k', ل: 'l', م: 'm', ن: 'n',
  ه: 'h', ة: 'a', و: 'w', ؤ: 'w', ي: 'y', ى: 'a', ئ: 'y',
};

/** Rough Arabic → Latin so emails stay ASCII. Latin letters pass through. */
export function transliterateNamePart(raw: string): string {
  let out = '';
  // Strip Arabic diacritics (tashkeel) before mapping letters.
  const cleaned = raw.normalize('NFKC').replace(/[\u064B-\u0652]/g, '');
  for (const ch of cleaned) {
    if (/[A-Za-z0-9]/.test(ch)) {
      out += ch.toLowerCase();
      continue;
    }
    const mapped = ARABIC_TO_LATIN[ch];
    if (mapped != null) {
      out += mapped;
      continue;
    }
    if (/\s|-|_/.test(ch)) out += ' ';
  }
  return out
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '');
}

export function namePartsForEmail(fullName: string): string[] {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .map(transliterateNamePart)
    .filter((p) => p.length >= 2);
  return parts;
}

/**
 * Build a local-part like `ahmed.mohamed` from the employee name.
 * Falls back to emp code / random when the name has no Latinizable parts.
 */
export function buildEmailLocalPart(opts: {
  name: string;
  code?: string | null;
}): string {
  const parts = namePartsForEmail(opts.name);
  let local = '';
  if (parts.length >= 2) {
    local = `${parts[0]}.${parts[parts.length - 1]}`;
  } else if (parts.length === 1) {
    local = parts[0];
  }
  const code = String(opts.code ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!local && code) local = `emp.${code}`;
  if (!local) local = `emp.${randomBytes(3).toString('hex')}`;
  // Keep local-part readable and mailbox-safe.
  local = local.slice(0, 48).replace(/^\.+|\.+$/g, '');
  return local || `emp.${randomBytes(3).toString('hex')}`;
}

export function toVicanzaEmail(localPart: string): string {
  return `${localPart}@${VICANZA_EMAIL_DOMAIN}`;
}

/** Easy-to-copy random password (no ambiguous chars). */
export function generateWorkEmailPassword(length = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export function isBlankEmail(value: string | null | undefined): boolean {
  return !String(value ?? '').trim();
}
